// Checks out a PR into a git worktree and asks `claude -p` to review it,
// producing a risk score, a reviewable score, and suggested inline comments.
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { KeyedMutex } = require("./semaphore");
const { log } = require("./log");
const { track } = require("./procs");

const CACHE_DIR = path.join(os.homedir(), ".ranked-reviews");
const REPOS_DIR = path.join(CACHE_DIR, "repos");
const WORKTREES_DIR = path.join(CACHE_DIR, "worktrees");

const REVIEW_MODEL = process.env.REVIEW_MODEL || "opus";
const REVIEW_EFFORT = process.env.REVIEW_EFFORT || "xhigh";
const CLAUDE_TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS || 12 * 60 * 1000);
const MAX_DIFF_CHARS = Number(process.env.REVIEW_MAX_DIFF_CHARS || 150_000);

// Serialize git operations (clone / fetch / worktree add+remove) per repo clone
// so concurrent reviews on the same repo don't trip over each other's locks.
const repoLock = new KeyedMutex();

for (const dir of [REPOS_DIR, WORKTREES_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(repo) {
  return repo.replace(/[^a-zA-Z0-9._-]/g, "__");
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        err.stdout = stdout;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
    track(child);
  });
}

// Make sure we have a local clone of the repo to base worktrees on. We use a
// blobless partial clone to keep it lightweight; blobs are fetched on demand.
async function ensureClone(repo) {
  const dir = path.join(REPOS_DIR, safeName(repo));
  if (fs.existsSync(path.join(dir, ".git"))) {
    return dir;
  }

  log(`cloning ${repo} (first time; this can take a while for large repos)…`);
  await run("gh", ["repo", "clone", repo, dir, "--", "--filter=blob:none", "--no-tags"]);
  log(`cloned ${repo}`);
  return dir;
}

// Fetch the PR head into a uniquely named ref (avoids the shared FETCH_HEAD
// race), then add a detached worktree pointing at it. Returns { worktree, sha }.
async function addWorktree(repoDir, number) {
  const ref = `refs/rr/pr-${number}`;
  await run("git", ["-C", repoDir, "fetch", "--no-tags", "--force", "origin", `pull/${number}/head:${ref}`]);

  const { stdout: shaOut } = await run("git", ["-C", repoDir, "rev-parse", ref]);
  const sha = shaOut.trim();

  const worktree = path.join(WORKTREES_DIR, `${path.basename(repoDir)}__pr-${number}`);
  // Clear any stale worktree from a previous interrupted run.
  await run("git", ["-C", repoDir, "worktree", "remove", "--force", worktree]).catch(() => {});
  fs.rmSync(worktree, { recursive: true, force: true });

  await run("git", ["-C", repoDir, "worktree", "add", "--detach", worktree, ref]);
  return { worktree, sha };
}

async function removeWorktree(repoDir, worktree) {
  await run("git", ["-C", repoDir, "worktree", "remove", "--force", worktree]).catch(() => {});
  fs.rmSync(worktree, { recursive: true, force: true });
  await run("git", ["-C", repoDir, "worktree", "prune"]).catch(() => {});
}

// Pull a single JSON object out of arbitrary text. Handles ```json fences and
// leading/trailing prose by grabbing the outermost { ... }.
function extractJsonObject(text) {
  if (!text) return null;
  let t = text.trim();

  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    t = fence[1].trim();
  }

  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }

  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

// `claude -p --output-format json` prints a banner then a single JSON result
// line. Find the result object and return its `.result` string.
function parseClaudeEnvelope(stdout) {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && "result" in obj) {
        return obj;
      }
    } catch {
      // not the line we want
    }
  }
  return null;
}

// Render the review "memory" — previously reviewed PRs and their scores — as
// anchors so this review is scored on the same scale as the rest of the corpus.
function renderMemory(memory) {
  if (!Array.isArray(memory) || memory.length === 0) {
    return "";
  }

  const lines = memory
    .map((m) => {
      const summary = (m.summary || "").replace(/\s+/g, " ").slice(0, 200);
      return `- "${(m.title || "").slice(0, 120)}" — risk=${m.risk ?? "?"} reviewable=${m.reviewable ?? "?"} comments=${m.commentCount ?? 0}${summary ? ` — ${summary}` : ""}`;
    })
    .join("\n");

  return `

For calibration, here are previously reviewed PRs and the scores they received.
Score the PR below on the SAME scale so your numbers are comparable to these:
${lines}
`;
}

function buildPrompt({ repo, number, title, body, labels, diff, truncated, memory }) {
  const labelList = (labels || []).map((l) => l.name).join(", ") || "none";
  return `You are an expert code reviewer. Review the following GitHub pull request.

The repository is checked out at the PR's head commit in your current working
directory, so you may read any file with your tools to understand context, APIs,
and conventions before judging the change.
${renderMemory(memory)}
Repository: ${repo}
PR #${number}: ${title}
Labels: ${labelList}
Description:
${(body || "").trim() || "(no description provided)"}

Unified diff${truncated ? " (TRUNCATED — only the first part is shown)" : ""}:
\`\`\`diff
${diff}
\`\`\`

Assess the PR and respond with ONLY a single JSON object — no markdown, no prose
outside the JSON — matching exactly this schema:

{
  "risk": <integer 0-100: how risky is this PR — how likely is it to break
           things in production or need to be reverted? Higher when the change
           touches critical paths, core logic, data migrations, concurrency,
           auth/security, or has a wide blast radius, especially without
           adequate test coverage. Lower for isolated, well-tested, or purely
           cosmetic changes. Reserve 80+ for changes that could cause a serious
           outage or data loss, and below 20 for changes that are very safe to
           merge.>,
  "reviewable": <integer 0-100: how many obvious review comments can be made on
                 this PR? 100 means there are many clear, obvious problems worth
                 commenting on — bugs, missing tests, poor naming, unhandled
                 edge cases, style issues. 0 means the PR is perfect with
                 nothing to comment on. Use the full range.>,
  "summary": "<2-4 sentence summary of what the PR does and your overall take>",
  "comments": [
    {
      "file": "<path relative to repo root, exactly as in the diff>",
      "line": <integer line number in the new version of the file>,
      "severity": "blocking" | "warning" | "nit",
      "comment": "<specific, actionable review feedback>"
    }
  ]
}

Severity guidance:
- "blocking": a serious problem that should be fixed before this PR merges — a
  correctness bug, security hole, data-loss risk, broken/missing test for a
  critical path, or anything likely to cause an incident. Use this whenever you
  would not approve the PR as-is.
- "warning": a real problem worth raising but not strictly merge-blocking.
- "nit": a minor style or preference suggestion.

Only include comments you would actually leave on the PR. If the PR is clean,
return an empty "comments" array.`;
}

// Map a claude-supplied severity onto our three tiers, accepting the legacy
// "blocker" spelling as "blocking".
function normalizeSeverity(sev) {
  if (sev === "blocking" || sev === "blocker") return "blocking";
  if (sev === "warning" || sev === "nit") return sev;
  return "nit";
}

function normalizeResult(parsed) {
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n))));
  const comments = Array.isArray(parsed.comments) ? parsed.comments : [];

  return {
    risk: Number.isFinite(Number(parsed.risk)) ? clamp(parsed.risk) : null,
    reviewable: Number.isFinite(Number(parsed.reviewable)) ? clamp(parsed.reviewable) : null,
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
    comments: comments
      .filter((c) => c && typeof c === "object")
      .map((c) => ({
        file: String(c.file || "").trim(),
        line: Number.isFinite(Number(c.line)) ? Number(c.line) : null,
        severity: normalizeSeverity(c.severity),
        comment: String(c.comment || "").trim(),
      }))
      .filter((c) => c.comment),
  };
}

// Human-friendly model label (e.g. "opus 4.8"). Seeded from a small alias map so
// it shows correctly with zero startup delay, then overridden by the real
// resolved id `claude` reports in each review's JSON envelope — so it stays
// accurate even if an alias later points at a different version.
const ALIAS_VERSIONS = {
  opus: "opus 4.8",
  sonnet: "sonnet 5",
  haiku: "haiku 4.5",
  fable: "fable 5",
};

// "claude-opus-4-8" / "claude-opus-4-8[1m]" -> "opus 4.8". Falls back to the raw
// id (minus the "claude-" prefix) for shapes we don't recognize.
function friendlyModel(id) {
  if (!id) return null;
  const s = id.replace(/^claude-/, "").replace(/\[.*\]$/, "");
  const m = s.match(/^([a-z]+)-(\d+(?:-\d+)*)$/);
  return m ? `${m[1]} ${m[2].replace(/-/g, ".")}` : s;
}

let modelLabel = ALIAS_VERSIONS[REVIEW_MODEL] || friendlyModel(REVIEW_MODEL);

// `claude --output-format json` reports the resolved model as the key(s) of
// `modelUsage`. Trust it over the seed so the version stays exact.
function rememberModel(envelope) {
  const usage = envelope && envelope.modelUsage;
  const label = friendlyModel(usage && Object.keys(usage)[0]);
  if (label) modelLabel = label;
}

// The version-qualified model label (e.g. "opus 4.8").
function modelDisplay() {
  return modelLabel || REVIEW_MODEL;
}

// Review a single PR end to end. Throws on failure; the caller records the error.
async function reviewPR({ repo, number, title, body, labels, memory }) {
  const repoDir = await ensureClone(repo);

  // Get the diff up front (doesn't need a worktree). Truncate huge diffs.
  let diff = "";
  try {
    const { stdout } = await run("gh", ["pr", "diff", String(number), "--repo", repo]);
    diff = stdout;
  } catch (e) {
    diff = "(failed to load diff: " + (e.stderr || e.message) + ")";
  }
  const truncated = diff.length > MAX_DIFF_CHARS;
  if (truncated) {
    diff = diff.slice(0, MAX_DIFF_CHARS);
  }

  // Serialized: set up the worktree.
  const { worktree, sha } = await repoLock.run(repo, () => addWorktree(repoDir, number));

  try {
    const prompt = buildPrompt({ repo, number, title, body, labels, diff, truncated, memory });

    const { stdout } = await run(
      "claude",
      [
        "-p",
        prompt,
        "--output-format",
        "json",
        "--permission-mode",
        "bypassPermissions",
        "--model",
        REVIEW_MODEL,
        "--effort",
        REVIEW_EFFORT,
      ],
      { cwd: worktree, timeout: CLAUDE_TIMEOUT_MS }
    );

    const envelope = parseClaudeEnvelope(stdout);
    if (!envelope) {
      throw new Error("Could not parse claude output envelope");
    }
    if (envelope.is_error) {
      throw new Error("claude reported an error: " + (envelope.result || "unknown"));
    }
    rememberModel(envelope);

    const parsed = extractJsonObject(envelope.result);
    if (!parsed) {
      throw new Error("Could not parse review JSON from claude result");
    }

    return { ...normalizeResult(parsed), sha };
  } finally {
    // Serialized: tear down the worktree.
    await repoLock.run(repo, () => removeWorktree(repoDir, worktree));
  }
}

module.exports = { reviewPR, modelDisplay, REVIEW_MODEL, REVIEW_EFFORT };
