const express = require("express");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Semaphore } = require("./lib/semaphore");
const { reviewPR, modelDisplay, REVIEW_MODEL, REVIEW_EFFORT } = require("./lib/reviewer");
const { calibrate } = require("./lib/calibrate");
const { log, tail } = require("./lib/log");
const { killAll } = require("./lib/procs");

const app = express();
const PORT = Number(process.env.PORT || 3002);
const REVIEW_CONCURRENCY = Number(process.env.REVIEW_CONCURRENCY || 3);
const MEMORY_SAMPLE_SIZE = Number(process.env.REVIEW_MEMORY_SAMPLE || 25);
const PRS_TTL_MS = Number(process.env.PRS_TTL_MS || 60_000);
const PRS_REFRESH_INTERVAL_MS = Number(process.env.PRS_REFRESH_INTERVAL_MS || 60 * 60 * 1000);
const SLEEP_FILE = path.join(__dirname, "sleep.json");
const REVIEWS_FILE = path.join(__dirname, "reviews.json");
const CALIBRATION_FILE = path.join(__dirname, "calibration.json");
const PRS_CACHE_FILE = path.join(__dirname, "prs.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));

// ---------------------------------------------------------------------------
// Sleep state (carried over from theirprs): temporarily hide PRs.
// ---------------------------------------------------------------------------
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getActiveSleep() {
  const sleep = readJson(SLEEP_FILE, {});
  const now = Date.now();
  let changed = false;

  for (const key of Object.keys(sleep)) {
    if (new Date(sleep[key].until).getTime() <= now) {
      delete sleep[key];
      changed = true;
    }
  }

  if (changed) {
    writeJson(SLEEP_FILE, sleep);
  }

  return sleep;
}

// ---------------------------------------------------------------------------
// Review cache + processing queue.
// ---------------------------------------------------------------------------
// reviews: key ("owner/repo#number") -> {
//   status: "queued" | "processing" | "done" | "error",
//   title, repo, number,                       // memory metadata
//   risk, reviewable, summary, comments, sha, error, reviewedAt,
//   calibrated: { risk, reviewable, reason } // set by the calibration pass
// Each comment is { file, line, severity, comment, posted?: { at, url } };
// `posted` is set once we post it to the PR so we don't post it twice.
// }
// This map is also the persistent "memory" of every PR ever reviewed.
const reviews = readJson(REVIEWS_FILE, {});
const inFlight = new Set();
const semaphore = new Semaphore(REVIEW_CONCURRENCY);

// A previous run may have left "queued"/"processing" entries that never resumed.
// Drop those stale, dataless entries on startup (keep finished "done"/"error"
// results) so they get re-reviewed cleanly on the next /api/prs.
let droppedOnStartup = 0;
for (const [key, r] of Object.entries(reviews)) {
  if (r.status !== "done" && r.status !== "error") {
    delete reviews[key];
    droppedOnStartup += 1;
  }
}
writeJson(REVIEWS_FILE, reviews);
if (droppedOnStartup > 0) {
  log(`startup: dropped ${droppedOnStartup} unfinished (queued/processing) reviews from a previous run`);
}

// Calibration state: the result of the most recent cross-PR calibration pass.
let calibration = readJson(CALIBRATION_FILE, { calibratedAt: null, note: "", count: 0 });
let calibrationRunning = false;
let calibrationDirty = false; // new reviews finished since the last pass

let persistTimer = null;
function persistReviews() {
  // Debounce disk writes; reviews complete in bursts.
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeJson(REVIEWS_FILE, reviews);
  }, 500);
}

// Effective scores prefer the calibrated value (comparable across PRs) and fall
// back to the raw per-review score.
function effectiveScore(r, field) {
  if (r && r.calibrated && r.calibrated[field] != null) return r.calibrated[field];
  return r ? r[field] ?? null : null;
}

// Comments that still "count" — dismissed ones are excluded from all counts that
// feed ranking (blocking priority) and calibration signals.
function activeComments(r) {
  return Array.isArray(r && r.comments) ? r.comments.filter((c) => c && !c.dismissed) : [];
}

// Build the review "memory" passed into a new review as calibration anchors.
// We sample across the score range (not just recent) so the anchors span the
// whole scale, and exclude the PR being reviewed.
function buildMemorySample(excludeKey) {
  const done = Object.entries(reviews)
    .filter(([key, r]) => key !== excludeKey && r.status === "done" && r.title)
    .map(([, r]) => ({
      title: r.title,
      risk: effectiveScore(r, "risk"),
      reviewable: effectiveScore(r, "reviewable"),
      commentCount: activeComments(r).length,
      summary: r.summary,
    }));

  if (done.length <= MEMORY_SAMPLE_SIZE) return done;

  // Sort by risk and take an even spread across the range.
  done.sort((a, b) => (a.risk ?? 0) - (b.risk ?? 0));
  const step = (done.length - 1) / (MEMORY_SAMPLE_SIZE - 1);
  const sample = [];
  for (let i = 0; i < MEMORY_SAMPLE_SIZE; i++) {
    sample.push(done[Math.round(i * step)]);
  }
  return sample;
}

function execGhJson(args) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

function execGhText(args) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function prKey(pr) {
  return `${pr.repository.nameWithOwner}#${pr.number}`;
}

// Queue a PR for review unless it's already in flight or already reviewed at the
// same head commit. Processing happens in the background under the semaphore.
function enqueueReview(pr) {
  const key = prKey(pr);
  const existing = reviews[key];

  if (inFlight.has(key)) {
    return;
  }
  if (existing && existing.status === "done" && existing.sha && existing.sha === pr.headSha) {
    return;
  }

  inFlight.add(key);
  // Keep identifying metadata (title/repo/number) so the memory and calibration
  // pass have context even while a review is queued/processing.
  reviews[key] = {
    ...(existing || {}),
    status: "queued",
    title: pr.title || (existing && existing.title) || "",
    repo: pr.repository.nameWithOwner,
    number: pr.number,
  };
  persistReviews();

  const startedAt = Date.now();
  semaphore
    .run(async () => {
      reviews[key] = { ...reviews[key], status: "processing" };
      persistReviews();
      log(`reviewing ${key} (${modelDisplay()}/${REVIEW_EFFORT})…`);

      const result = await reviewPR({
        repo: pr.repository.nameWithOwner,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        labels: pr.labels,
        memory: buildMemorySample(key),
      });

      reviews[key] = {
        ...reviews[key],
        status: "done",
        risk: result.risk,
        reviewable: result.reviewable,
        summary: result.summary,
        comments: result.comments,
        sha: result.sha || pr.headSha || null,
        reviewedAt: new Date().toISOString(),
        calibrated: null, // invalidated until the next calibration pass
      };
      calibrationDirty = true;
      const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
      log(`reviewed ${key} in ${secs}s — risk=${result.risk} reviewable=${result.reviewable} comments=${result.comments.length}`);
    })
    .catch((err) => {
      const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
      log(`review FAILED ${key} after ${secs}s: ${(err.stderr || err.message || "unknown").slice(0, 300)}`);
      reviews[key] = {
        ...(reviews[key] || {}),
        status: "error",
        error: (err.stderr || err.message || "unknown error").slice(0, 2000),
        reviewedAt: new Date().toISOString(),
      };
    })
    .finally(() => {
      inFlight.delete(key);
      persistReviews();
      maybeCalibrate();
    });
}

// ---------------------------------------------------------------------------
// Calibration pass: re-scores the whole memory so scores are comparable.
// ---------------------------------------------------------------------------
function doneReviewItems() {
  return Object.entries(reviews)
    .filter(([, r]) => r.status === "done")
    .sort((a, b) => new Date(b[1].reviewedAt || 0) - new Date(a[1].reviewedAt || 0))
    .map(([key, r]) => ({
      key,
      title: r.title || key,
      risk: r.risk,
      reviewable: r.reviewable,
      summary: r.summary,
      commentCount: activeComments(r).length,
    }));
}

// Run automatically once the review queue has drained and new results exist.
function maybeCalibrate() {
  if (calibrationRunning || calibrationDirty === false) return;
  if (inFlight.size > 0) return; // wait until the in-progress batch finishes
  if (doneReviewItems().length < 2) return;
  runCalibration();
}

async function runCalibration() {
  if (calibrationRunning) return;
  calibrationRunning = true;
  calibrationDirty = false;

  const items = doneReviewItems();
  log(`calibrating across ${items.length} reviewed PRs…`);
  try {
    const result = await calibrate(items);
    if (result) {
      for (const [key, scores] of Object.entries(result.scores)) {
        if (reviews[key]) reviews[key].calibrated = scores;
      }
      calibration = {
        calibratedAt: new Date().toISOString(),
        note: result.note,
        count: items.length,
        model: result.model,
      };
      writeJson(CALIBRATION_FILE, calibration);
      persistReviews();
      log(`calibrated ${Object.keys(result.scores).length}/${items.length} reviewed PRs`);
    }
  } catch (err) {
    log(`calibration FAILED: ${(err.stderr || err.message || "unknown").slice(0, 300)}`);
  } finally {
    calibrationRunning = false;
    // Reviews that completed during the pass leave it dirty; run again.
    if (calibrationDirty) setTimeout(maybeCalibrate, 100);
  }
}

// ---------------------------------------------------------------------------
// PR list: cached with stale-while-revalidate so refreshes are instant.
// ---------------------------------------------------------------------------
// prsCache: { data: [...filtered PRs with body+headSha], fetchedAt: iso } | null
let prsCache = readJson(PRS_CACHE_FILE, null);
let prsRefreshing = false;

// The slow part: hit GitHub via `gh` for the PRs needing review.
async function fetchPrsFromGh() {
  const [viewerLoginRaw, prs] = await Promise.all([
    execGhText(["api", "user", "--jq", ".login"]),
    execGhJson([
      "search",
      "prs",
      "--review-requested=@me",
      "--state=open",
      "--limit=200",
      "--json",
      "number,title,repository,updatedAt,url,isDraft,state,createdAt,labels,author,body",
    ]),
  ]);

  const viewerLogin = (viewerLoginRaw || "").toLowerCase();

  const byRepo = new Map();
  for (const pr of prs) {
    const repo = pr.repository.nameWithOwner;
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(pr);
  }

  await Promise.all(
    [...byRepo.entries()].map(async ([repo, repoPrs]) => {
      try {
        const details = await execGhJson([
          "pr",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--search",
          "review-requested:@me",
          "--limit",
          "200",
          "--json",
          "number,reviewDecision,headRefOid,latestReviews,reviewRequests",
        ]);

        const byNumber = new Map(details.map((d) => [d.number, d]));
        for (const pr of repoPrs) {
          const d = byNumber.get(pr.number) || {};
          pr.reviewDecision = d.reviewDecision || "";
          pr.headSha = d.headRefOid || "";
          pr.latestReviews = d.latestReviews || [];
          pr.reviewRequests = d.reviewRequests || [];
        }
      } catch {
        for (const pr of repoPrs) {
          pr.reviewDecision = "";
          pr.headSha = "";
          pr.latestReviews = [];
          pr.reviewRequests = [];
        }
      }
    })
  );

  return prs.filter((pr) => {
    if (!pr.author || pr.author.login.toLowerCase() === viewerLogin || pr.isDraft) return false;

    // Skip PRs that already have an overall review decision: an approval, or
    // changes requested (waiting on the author, not on a fresh review).
    if (pr.reviewDecision === "APPROVED" || pr.reviewDecision === "CHANGES_REQUESTED") {
      return false;
    }

    // Belt-and-suspenders for the case where the overall decision is still
    // pending but YOU already reviewed (e.g. you approved via a team request):
    // drop it unless your review was re-requested (you're individually back in
    // the review-request list).
    const reRequested = (pr.reviewRequests || []).some(
      (r) => (r.login || "").toLowerCase() === viewerLogin
    );
    const myReview = (pr.latestReviews || []).find(
      (r) => r.author && (r.author.login || "").toLowerCase() === viewerLogin
    );
    const alreadyReviewed =
      myReview && (myReview.state === "APPROVED" || myReview.state === "CHANGES_REQUESTED");
    if (alreadyReviewed && !reRequested) return false;

    return true;
  });
}

// Refresh the cache from GitHub and enqueue any new/changed reviews. Guarded so
// only one refresh runs at a time; callers may run it in the background.
async function refreshPrs() {
  if (prsRefreshing) return prsCache ? prsCache.data : [];
  prsRefreshing = true;
  try {
    const data = await fetchPrsFromGh();
    prsCache = { data, fetchedAt: new Date().toISOString() };
    writeJson(PRS_CACHE_FILE, prsCache);
    const before = inFlight.size;
    for (const pr of data) enqueueReview(pr);
    log(`refreshed PR list: ${data.length} PRs, ${inFlight.size} reviews in flight (+${inFlight.size - before} newly queued)`);
    return data;
  } finally {
    prsRefreshing = false;
  }
}

// Strip fields only needed server-side (the heavy `body` used for the review
// prompt, and the review metadata used for filtering) before sending to the
// browser.
function clientPrs(data) {
  return data.map(({ body, latestReviews, reviewRequests, ...pr }) => pr);
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------
app.get("/api/prs", async (req, res) => {
  const forceFresh = req.query.fresh === "1";
  const revalidate = req.query.revalidate === "1";

  try {
    // Serve the cache instantly when we have one and aren't forced to wait.
    if (prsCache && !forceFresh) {
      const age = Date.now() - new Date(prsCache.fetchedAt).getTime();
      const stale = age > PRS_TTL_MS;

      // Ensure reviews are enqueued for cached PRs (idempotent; covers restarts
      // where the cache loaded from disk but nothing was queued yet).
      for (const pr of prsCache.data) enqueueReview(pr);

      // Revalidate in the background when stale or explicitly asked to.
      if ((stale || revalidate) && !prsRefreshing) {
        refreshPrs().catch((e) => console.error("Background PR refresh failed:", e.message));
      }

      return res.json({
        prs: clientPrs(prsCache.data),
        fetchedAt: prsCache.fetchedAt,
        stale: stale || revalidate,
      });
    }

    // No cache (or forced): do the slow fetch once and serve it.
    const data = await refreshPrs();
    return res.json({ prs: clientPrs(data), fetchedAt: prsCache.fetchedAt, stale: false });
  } catch (e) {
    console.error("gh error:", e.message);
    if (e.stderr) console.error(e.stderr);
    // Fall back to a stale cache rather than failing the page.
    if (prsCache) {
      return res.json({
        prs: clientPrs(prsCache.data),
        fetchedAt: prsCache.fetchedAt,
        stale: true,
        error: "refresh failed",
      });
    }
    res.status(500).json({ error: "Failed to fetch PRs" });
  }
});

// Lightweight scores/status for every reviewed PR (no comment bodies), plus the
// state of the latest calibration pass.
app.get("/api/reviews", (req, res) => {
  const out = {};
  for (const [key, r] of Object.entries(reviews)) {
    out[key] = {
      status: r.status,
      risk: r.risk ?? null,
      reviewable: r.reviewable ?? null,
      // Calibrated scores (comparable across PRs); null until a pass runs.
      calibratedRisk: effectiveScore(r, "risk"),
      calibratedReviewable: effectiveScore(r, "reviewable"),
      isCalibrated: !!(r.calibrated && (r.calibrated.risk != null || r.calibrated.reviewable != null)),
      // Counts exclude dismissed comments so they don't affect ranking.
      commentCount: Array.isArray(r.comments) ? activeComments(r).length : null,
      blockingCount: activeComments(r).filter(
        (c) => c.severity === "blocking" || c.severity === "blocker"
      ).length,
      postedCount: activeComments(r).filter((c) => c.posted).length,
      reviewedAt: r.reviewedAt || null,
    };
  }
  res.json({ reviews: out, calibration: { ...calibration, running: calibrationRunning } });
});

// Trigger a calibration pass on demand.
app.post("/api/calibrate", (req, res) => {
  if (calibrationRunning) {
    return res.json({ status: "running" });
  }
  if (doneReviewItems().length < 2) {
    return res.json({ status: "not-enough", message: "Need at least 2 reviewed PRs to calibrate." });
  }
  calibrationDirty = true;
  runCalibration();
  res.json({ status: "started" });
});

// Full review for a single PR, including suggested comments.
app.get("/api/reviews/:key", (req, res) => {
  const key = req.params.key;
  const r = reviews[key];
  if (!r) {
    return res.json({ status: "unprocessed" });
  }
  res.json({ key, ...r });
});

// Force a re-review of a PR (e.g. after new commits).
app.post("/api/reviews/:key/refresh", (req, res) => {
  const key = req.params.key;
  const hashIdx = key.lastIndexOf("#");
  if (hashIdx === -1) {
    return res.status(400).json({ error: "invalid key" });
  }

  const repo = key.slice(0, hashIdx);
  const number = Number(key.slice(hashIdx + 1));
  if (!repo || !Number.isFinite(number)) {
    return res.status(400).json({ error: "invalid key" });
  }

  // Drop the cached result so enqueueReview reprocesses it.
  delete reviews[key];
  enqueueReview({ repository: { nameWithOwner: repo }, number, title: "", body: "", labels: [] });
  res.json({ status: "queued" });
});

// Post one of a review's suggested comments to the PR as an inline review
// comment, via the GitHub API (`gh api`). Body: { index } into r.comments.
app.post("/api/reviews/:key/comment", async (req, res) => {
  const key = req.params.key;
  const r = reviews[key];
  const idx = Number(req.body && req.body.index);

  if (!r || !Array.isArray(r.comments) || !Number.isInteger(idx) || !r.comments[idx]) {
    return res.status(400).json({ error: "no such comment" });
  }

  const hashIdx = key.lastIndexOf("#");
  const repo = key.slice(0, hashIdx);
  const number = key.slice(hashIdx + 1);
  const c = r.comments[idx];

  // Already posted — don't post it again.
  if (c.posted) {
    return res.status(409).json({
      status: "already-posted",
      url: c.posted.url || null,
      at: c.posted.at || null,
    });
  }
  if (!c.file || c.line == null) {
    return res.status(400).json({ error: "comment is not anchored to a file and line" });
  }
  if (!r.sha) {
    return res.status(400).json({ error: "no reviewed commit on record — re-review the PR first" });
  }

  try {
    // POST /repos/{owner}/{repo}/pulls/{n}/comments creates an inline review
    // comment. `line` is on the new version of the file (side=RIGHT) and must be
    // part of the PR diff, or GitHub returns 422.
    const created = await execGhJson([
      "api",
      "-X", "POST",
      `/repos/${repo}/pulls/${number}/comments`,
      "-f", `body=${c.comment}`,
      "-f", `commit_id=${r.sha}`,
      "-f", `path=${c.file}`,
      "-F", `line=${c.line}`,
      "-f", "side=RIGHT",
    ]);
    // Record that we posted it so it isn't accidentally re-posted (survives
    // restarts via reviews.json).
    c.posted = { at: new Date().toISOString(), url: created.html_url || null };
    persistReviews();
    log(`posted inline comment on ${key} (${c.file}:${c.line})`);
    return res.json({ status: "posted", url: c.posted.url, at: c.posted.at });
  } catch (e) {
    const msg = (e.stderr || e.message || "unknown error").trim().slice(0, 500);
    log(`failed to post comment on ${key} (${c.file}:${c.line}): ${msg}`);
    return res.status(502).json({ error: msg });
  }
});

// Dismiss (or restore) a suggested comment. Dismissed comments stay visible in
// the detail view but are excluded from all ranking/calibration counts. Body:
// { index, dismissed } (dismissed defaults to true).
app.post("/api/reviews/:key/dismiss", (req, res) => {
  const key = req.params.key;
  const r = reviews[key];
  const idx = Number(req.body && req.body.index);

  if (!r || !Array.isArray(r.comments) || !Number.isInteger(idx) || !r.comments[idx]) {
    return res.status(400).json({ error: "no such comment" });
  }

  const dismissed = req.body.dismissed !== false;
  if (dismissed) {
    r.comments[idx].dismissed = true;
  } else {
    delete r.comments[idx].dismissed;
  }
  persistReviews();
  return res.json({ status: "ok", dismissed });
});

app.get("/api/sleep", (req, res) => {
  res.json(getActiveSleep());
});

app.post("/api/sleep", (req, res) => {
  const { keys, days } = req.body;
  if (!Array.isArray(keys) || !days) {
    return res.status(400).json({ error: "keys (array) and days (number) required" });
  }

  const sleep = getActiveSleep();
  const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  for (const key of keys) {
    sleep[key] = { until };
  }

  writeJson(SLEEP_FILE, sleep);
  res.json(sleep);
});

app.delete("/api/sleep/:key", (req, res) => {
  const sleep = getActiveSleep();
  delete sleep[req.params.key];
  writeJson(SLEEP_FILE, sleep);
  res.json(sleep);
});

// Recent log lines, for the in-app log viewer.
app.get("/api/log", (req, res) => {
  const n = Math.min(Number(req.query.n) || 300, 2000);
  res.json({ lines: tail(n), inFlight: inFlight.size, calibrating: calibrationRunning });
});

const server = app.listen(PORT, () => {
  log(`server running at http://localhost:${PORT}`);
  log(`reviewing with claude "${modelDisplay()}" (effort ${REVIEW_EFFORT}), ${REVIEW_CONCURRENCY} at a time`);

  // Auto-resume: re-enqueue cached PRs so reviews pick back up after a restart
  // without waiting for the browser to hit /api/prs again.
  if (prsCache && Array.isArray(prsCache.data) && prsCache.data.length) {
    for (const pr of prsCache.data) enqueueReview(pr);
    log(`auto-resume: enqueued ${inFlight.size} reviews from cached PR list`);
  }

  // Refresh the PR list from GitHub on a fixed interval (hourly by default) so
  // newly-opened PRs get queued and ones you've reviewed / that closed drop off,
  // even when no browser is polling.
  setInterval(() => {
    refreshPrs().catch((e) => console.error("Scheduled PR refresh failed:", e.message));
  }, PRS_REFRESH_INTERVAL_MS).unref();
});

// Graceful shutdown (e.g. `node --watch` restart on file edit, or Ctrl-C):
// flush state to disk and kill child claude/git processes so nothing is left
// orphaned and the next process starts from a clean, consistent state.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  // Flush immediately rather than waiting on the debounce timer.
  if (persistTimer) clearTimeout(persistTimer);
  try {
    writeJson(REVIEWS_FILE, reviews);
    writeJson(CALIBRATION_FILE, calibration);
  } catch {
    // best effort
  }

  const killed = killAll("SIGTERM");
  log(`received ${signal}, shutting down: flushed state, signalled ${killed} child process(es)`);

  // Force-kill any children that ignore SIGTERM so none are left orphaned.
  setTimeout(() => killAll("SIGKILL"), 800).unref();

  server.close(() => process.exit(0));
  // Don't hang forever if a connection is slow to close (after the SIGKILL pass).
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
