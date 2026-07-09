// Calibration pass.
//
// Each PR is reviewed independently, so its raw risk/reviewable scores are
// only self-consistent — a "7" from one review may not mean the same thing as a
// "7" from another. This pass feeds the WHOLE memory of reviewed PRs to claude
// at once and asks it to assign calibrated scores that are comparable across
// PRs (a typo fix should not out-rank a risky migration; the full 0-100 range
// should be used; PRs with more to comment on should out-score clean ones on
// reviewable).
const { execFile } = require("child_process");
const os = require("os");
const { REVIEW_MODEL, REVIEW_EFFORT } = require("./reviewer");
const { track } = require("./procs");

const CALIBRATION_TIMEOUT_MS = Number(process.env.CALIBRATION_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_ITEMS = Number(process.env.CALIBRATION_MAX_ITEMS || 120);
const MAX_SUMMARY_CHARS = 320;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
    track(child);
  });
}

function parseClaudeEnvelope(stdout) {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && "result" in obj) return obj;
    } catch {
      // not the result line
    }
  }
  return null;
}

function extractJsonObject(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

function buildPrompt(items, total) {
  const lines = items
    .map((it, i) => {
      const summary = (it.summary || "").replace(/\s+/g, " ").slice(0, MAX_SUMMARY_CHARS);
      return `[${i}] ${it.key} — "${(it.title || "").slice(0, 140)}" — current risk=${it.risk ?? "?"} reviewable=${it.reviewable ?? "?"} comments=${it.commentCount ?? 0}\n     ${summary}`;
    })
    .join("\n");

  const truncatedNote =
    items.length < total
      ? `\n(Showing the ${items.length} most recently reviewed of ${total} PRs in memory.)`
      : "";

  return `You are calibrating automated pull-request review scores so they are
consistent and comparable ACROSS pull requests. Each PR below was scored
independently, so the raw numbers may not be on the same scale.

For every PR, assign a CALIBRATED "risk" and "reviewable" score (integers
0-100) such that, read together, the whole set is well-calibrated:

- Risk: PRs more likely to break things or need to be reverted (touching
  critical paths, core logic, migrations, concurrency, auth/security, or with a
  wide blast radius, especially without tests) must rank clearly above safe,
  isolated changes.
- Reviewable: PRs with more/clearer obvious comments to make must rank above
  clean ones with little or nothing to comment on.
- Use the FULL 0-100 range; do not cluster everything in a narrow band.
- Preserve a score when it is already reasonable relative to the others; only
  move scores to fix cross-PR inconsistencies.

Reviewed PRs (the review memory):${truncatedNote}
${lines}

Respond with ONLY a single JSON object — no markdown, no prose outside it:

{
  "note": "<2-3 sentences: what calibration problems you found across these PRs and how you corrected them. If the scores were already consistent, say so.>",
  "scores": [
    { "index": <integer matching the [N] above>,
      "risk": <integer 0-100>,
      "reviewable": <integer 0-100>,
      "reason": "<short reason if you materially changed this PR's scores, else empty string>" }
  ]
}`;
}

const clamp = (n) =>
  Number.isFinite(Number(n)) ? Math.max(0, Math.min(100, Math.round(Number(n)))) : null;

// items: [{ key, title, risk, reviewable, summary, commentCount }]
// Returns { note, model, scores: { key: { risk, reviewable, reason } } } or null.
async function calibrate(items) {
  if (!Array.isArray(items) || items.length < 2) {
    return null;
  }

  const selected = items.slice(0, MAX_ITEMS);
  const prompt = buildPrompt(selected, items.length);

  const { stdout } = await run(
    "claude",
    ["-p", prompt, "--output-format", "json", "--model", REVIEW_MODEL, "--effort", REVIEW_EFFORT],
    { cwd: os.tmpdir(), timeout: CALIBRATION_TIMEOUT_MS }
  );

  const envelope = parseClaudeEnvelope(stdout);
  if (!envelope) throw new Error("Could not parse claude output envelope");
  if (envelope.is_error) {
    throw new Error("claude reported an error: " + (envelope.result || "unknown"));
  }

  const parsed = extractJsonObject(envelope.result);
  if (!parsed || !Array.isArray(parsed.scores)) {
    throw new Error("Could not parse calibration JSON from claude result");
  }

  const scores = {};
  for (const s of parsed.scores) {
    const idx = Number(s.index);
    const item = selected[idx];
    if (!item) continue;
    const risk = clamp(s.risk);
    const reviewable = clamp(s.reviewable);
    if (risk == null && reviewable == null) continue;
    scores[item.key] = {
      risk,
      reviewable,
      reason: typeof s.reason === "string" ? s.reason.trim() : "",
    };
  }

  return {
    note: typeof parsed.note === "string" ? parsed.note.trim() : "",
    model: REVIEW_MODEL,
    scores,
  };
}

module.exports = { calibrate };
