# ranked-reviews

A local app that ranks the GitHub pull requests you've been asked to review by
**AI-generated scores**, and shows **suggested inline comments** when you open a PR.

It's a descendant of [theirprs](https://github.com/bobrenjc93/theirprs): same set
of PRs (open, review requested from `@me`, not your own, not a draft, and not ones
that already have an overall decision — approved or changes-requested — nor ones
you've personally reviewed already, unless your review was re-requested), but
instead of a flat list you get a sortable table driven by an automated review.

For each PR, `ranked-reviews` checks the PR out into a git worktree and runs
`claude -p` over it to produce:

- **Risk** (0–100) — higher for PRs more likely to break things or need to be
  reverted (touching critical paths, core logic, migrations, concurrency, or
  security, especially without tests); lower for isolated, well-tested changes.
- **Reviewable** (0–100) — higher when there are many obvious comments to make
  (bugs, missing tests, poor naming, edge cases); 0 for a perfect PR with
  nothing to comment on.
- **Suggested comments** — a list of actionable review notes, each with a file
  name and line number.

The two scores show up in the main table. The comments show up when you click a
PR open.

## How it works

1. `GET /api/prs` lists the PRs needing your review (via `gh`) and **enqueues**
   each one for review.
2. Reviews run progressively in the background under a **semaphore** (a few at a
   time, configurable) so a large backlog doesn't fan out into hundreds of
   `claude` processes at once.
3. Each review: clone the repo (blobless, cached under `~/.ranked-reviews`) →
   fetch the PR head into its own ref → add a detached git worktree → run
   `claude -p` in that worktree → parse the JSON result → remove the worktree.
4. The UI shows status per PR (`queued`, `reviewing`, a score, or `error`) and
   polls every few seconds, so unprocessed PRs render immediately and fill in
   their scores as the reviews complete.

Results are cached in `reviews.json` (keyed by PR + head commit), so restarts and
refreshes don't re-run reviews. Use the **Re-review** button in a PR's detail
view to force a fresh review (e.g. after new commits land).

## Memory & calibration

Scores are only meaningful relative to each other, and a PR reviewed in isolation
has nothing to compare against. `ranked-reviews` handles this two ways:

1. **Memory in each review.** `reviews.json` is a growing memory of every PR ever
   reviewed (it keeps titles, scores, and summaries even after a PR closes). When
   a new PR is reviewed, a score-diverse sample of that memory is passed into the
   prompt as **anchors**, so `claude` scores the new PR on the same scale as the
   existing corpus instead of from scratch.

2. **A calibration pass.** Independent reviews still drift, so once the review
   queue drains, a calibration pass feeds the whole memory to `claude` at once and
   asks it to assign **calibrated** risk/reviewable scores that are comparable
   across all PRs (risky PRs out-rank safe ones; the full 0–100 range gets
   used). It also returns a short note describing what it corrected.

The table shows calibrated scores when available (raw scores until the first pass
runs); a PR's detail view shows both the calibrated and raw values plus the
calibration reason. The pass runs automatically when the queue drains, or on
demand via the **Recalibrate** button. Calibration state is stored in
`calibration.json`.

## Requirements

- Node.js
- `git`
- `gh` CLI, authenticated via `gh auth login`
- `claude` CLI, authenticated and on your `PATH`

## Install

```bash
npm install
```

## Run

```bash
npm start     # normal run — use this
# or
npm run dev   # hot-reloading (restarts on file edits)
```

Open <http://localhost:3002>.

> **Note:** prefer `npm start`. `npm run dev` restarts the server on every file
> edit, and a restart **kills any in-progress reviews** (each `claude` review can
> take minutes), so reviews never finish while you're editing. Use `dev` only
> when changing the code, not while reviews are running.

## Logs

Activity (reviews starting/finishing/failing, clones, calibration) is written to
`ranked-reviews.log` and printed to the console. Tail it with:

```bash
tail -f ranked-reviews.log
```

Or click **Logs** in the app to watch it live (it also shows how many reviews are
currently in flight).

## Configuration

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3002` | HTTP port |
| `PRS_TTL_MS` | `60000` | How long the cached PR list is considered fresh before background revalidation |
| `PRS_REFRESH_INTERVAL_MS` | `3600000` | How often the server re-fetches the PR list from GitHub (hourly) |
| `REVIEW_CONCURRENCY` | `3` | Max reviews running at once (the semaphore) |
| `REVIEW_MODEL` | `opus` | Model passed to `claude --model` (resolves to Opus 4.8) |
| `REVIEW_EFFORT` | `xhigh` | Reasoning effort passed to `claude --effort` (low/medium/high/xhigh/max) |
| `REVIEW_TIMEOUT_MS` | `720000` | Per-review timeout (12 min) |
| `REVIEW_MAX_DIFF_CHARS` | `150000` | Diff is truncated past this length in the prompt |
| `REVIEW_MEMORY_SAMPLE` | `25` | Number of past-review anchors fed into each review |
| `CALIBRATION_MAX_ITEMS` | `120` | Max PRs included in a calibration pass |
| `CALIBRATION_TIMEOUT_MS` | `600000` | Calibration pass timeout (10 min) |

Example:

```bash
REVIEW_CONCURRENCY=5 REVIEW_MODEL=opus npm start
```

## Notes

- Reviews run `claude -p` with `--permission-mode bypassPermissions` so it can
  read files non-interactively. It is prompted only to **review** (not edit), but
  it does check out and read PR code, so run this against repositories you trust.
- Worktrees and repo clones live under `~/.ranked-reviews/`. They're cleaned up
  after each review; clones are kept and reused.
- The "sleep" feature from theirprs is preserved: select PRs and snooze them for
  a week. Sleeping PRs are stored in `sleep.json`.
- The table renders in pages of 50 with infinite scroll (plus a "Load more"
  button), so a large review backlog stays responsive. Already-reviewed and
  currently-reviewing PRs are always sorted to the top.
- The PR list is cached locally in `prs.json` with stale-while-revalidate: pages
  load (and refresh) instantly from cache while the slow `gh` calls run in the
  background, after which the fresh snapshot is swapped in automatically. Set
  `PRS_TTL_MS` to control how long the cache is considered fresh.
- The list also refreshes on a fixed interval — hourly by default, set by
  `PRS_REFRESH_INTERVAL_MS` (both server-side, so reviews stay current with no
  browser open, and client-side, so an open tab drops PRs you've reviewed and
  picks up new ones). The header shows when the list was last updated.
