# Project memory for AI agents

This file is the durable architecture map for `ncm-comment-finder`. Read it before changing code. Keep it factual and compact; it describes the current system, not a changelog.

## Product and runtime shapes

The app finds NetEase Cloud Music comments authored by a numeric user UID. It has three entry shapes over the same TypeScript core:

- CLI: `src/cli.ts`, run with `npm run start -- <command>`.
- Local web dashboard: `src/server.ts` serves `web/` on `127.0.0.1`; run with `npm run web`.
- Electron desktop: `src/electron-main.ts` starts the dashboard on an ephemeral loopback port and loads it in a sandboxed window. Packaged runtime data lives under Electron's `app.getPath("userData")`, not the repository.

There is no database. Durable scan state is JSON; matches are append-only JSONL. Generated/runtime directories (`dist/`, `release/`, `.ncm/`, `data/`, `tmp/`) are ignored and must not be committed.

The code version is authoritative in `package.json` and `package-lock.json`. The current work is for the next, not-yet-published release; do not record a tentative version here or infer a successful GitHub Release from local files. Verify the live tag, commit, and assets only when releasing or evaluating an update.

## Architecture and data flow

Two scan engines exist and must not be conflated:

1. User-source scan (`scan`, `/api/job`, `runPooledCommentFinder`)
   - Read candidate songs from listening rank (`user_record`), likes (`likelist`), or both.
   - Merge songs by ID while preserving record-first order and source metadata.
   - Page each song through `comment_new` with a descending time cursor, match `comment.user.userId` exactly, and write results. The default page size is 1000 and the accepted range is 1..2000.
   - When `hasMore` is true, the next cursor must be strictly older than the prior cursor. An empty page may still continue when `hasMore` is true and the cursor advances; non-progress or an exception remains recoverable work and must not be reported as complete.
   - `auto` in the CLI may select `user_comment_history` only when the logged-in account UID equals the target. The GUI deliberately uses `strategy: "scan"`.
   - With a verified pool, one lane is created per distinct egress IP. A song page is one queue item; after a successful page, unfinished songs are requeued so Workers fairly rotate instead of one Worker monopolizing a long song.

2. Single-song parallel scan (`scan-song`, `/api/parallel/job`, `runParallelSongScan`)
   - Read the song metadata, split `[startTime, endTime)` into non-overlapping time shards, newest first, and paginate `comment_new` using descending cursors. One shard page is one queue item.
   - After a page advances, if Workers are waiting, the unread range `[shard.startTime, nextCursor)` is bisected into two non-overlapping half-open shards and both are requeued. The original configured `shardCount` remains the checkpoint compatibility key, while `state.shards.length` and report progress grow with adaptive splits.
   - Failed/cooling lanes return unfinished work to the shared queue for healthy lanes. An adaptive split or failover must never duplicate/skip a time range; JSONL de-duplication is a final idempotency guard, not a substitute for correct range math.
   - Cursor pages are filtered back to the shard's half-open range before UID matching. The endpoint is intentionally called without a login cookie.
   - Dashboard global percentage is cursor-weighted time coverage, computed from the remaining time in every unfinished shard. It therefore survives adaptive splits without the artificial regression caused by `shardsComplete / shards`; it is time coverage, not an estimate of uniformly distributed comments.

Common result flow:

`EnhancedNcmClient` -> scanner -> `JsonlResultWriter` -> JSONL on disk -> optional `onMatch` callback -> server SSE -> `web/app.js` live table. Alongside it, source/parallel request activity and parallel scheduler activity feed a best-effort `TaskLogger` and the dashboard log view.

During a user-source scan, every worker reports its latest song/page through `onSongProgress`; `JobManager` keeps the most recently active song in its in-memory snapshot so dashboard polling does not confuse the first unfinished checkpoint entry with the song currently being requested.

The writer serializes concurrent appends and de-duplicates by `commentId`, including IDs already on disk. SSE/UI failure must never interrupt persistence.

## Task snapshots, live progress, and terminal settlement

The dashboard keeps separate in-memory snapshots for source and parallel history, but a shared `TaskCoordinator` permits only one active source scan, parallel scan, or pool mutation at a time. Every accepted `POST .../job` receives a new UUID. The renderer polls both snapshots about every 1.5 seconds while result rows arrive independently over SSE.

- Source live activity comes from `ScanOptions.onSongProgress`. It describes the latest request started by any Worker, so `currentSong` is an activity indicator, not the first unfinished checkpoint item and not a promise that other Workers are idle. Page numbering shown to users is one-based.
- Checkpoint counters remain authoritative for durable progress (`songsProcessed`, pages/shards, requests, and matches). In-memory activity may be newer than the latest coalesced checkpoint, but must never mutate checkpoint cursor semantics.
- The dashboard has two progress bars. Source global progress is completed songs over selected songs; its second bar is the latest active song's `commentsProcessed / totalComments`. Parallel global progress is cursor-weighted time coverage; its second bar is `commentsInspected / totalComments` for the song. `totalComments` is optional and may change between responses, so `mergeCommentTotal` keeps the maximum of the stored total, the latest credible total, and processed count. Unknown totals use an indeterminate bar while active; UI clamping never determines task completion.
- Both snapshot shapes expose the same task-timing contract: `startedAt`, optional `finishedAt`, and non-negative `elapsedMs`. While status is `running`/`stopping`, elapsed time is `now - startedAt`; after a terminal transition it is frozen at `finishedAt - startedAt`. Polling a finished task must not keep increasing its duration.
- `finishedAt` is assigned once when the manager settles a report or error. Use the manager's snapshot timestamps for UI timing in both modes rather than mixing them with scanner-local report timers, which start at slightly different points.
- The renderer's single runtime clock is resynchronized from the active snapshot on each accepted poll, then advanced with `performance.now()` every 250 ms only while status is `running`/`stopping`; terminal display is frozen. Do not create timers inside render functions, and clear the singleton intervals on `pagehide`.
- Combined job/pool refreshes use an increasing request sequence. A response may render only if it is still the newest request, so an older overlapping poll cannot roll progress, status, pool state, or the runtime clock backward.
- Dashboard-terminal statuses are `complete`, `matched`, `paused`, `cooldown`, `dry-run`, `stopped`, and `error`. `idle`, `running`, and `stopping` must not produce a settlement screen. Paused/cooldown/stopped are resumable but still end the current invocation and therefore get a settlement.
- The task-end settlement UI is keyed by scan mode plus snapshot UUID and opens at most once for that task, even though polling repeatedly renders the same terminal snapshot. Starting a new UUID clears the prior task's presentation state; dismissing a settlement must not let the next poll reopen it.
- Settlement values come from the terminal snapshot: duration from `elapsedMs` and total hits from `matches`. Never derive hits from the renderer's visible-result map, which is capped and mode-local. `matches` is checkpoint-cumulative across resumptions; `elapsedMs` is for the current UUID/invocation. If product copy ever promises cross-restart cumulative runtime, add a persisted duration field to the state schema instead of relabeling this value.
- The settlement is a presentation layer over the existing task/results view: results stay persisted and accessible, zero matches is a valid successful outcome, and error/cooldown notes remain visible. Render server text with `textContent`, give a dialog/overlay correct focus and close behavior, and honor `prefers-reduced-motion`.
- Preserve behavioral tests for live/frozen elapsed time, progress math, stale-refresh rejection, and renderer settlement de-duplication; a static HTML text assertion alone is insufficient evidence.

## Concurrency and rate-control invariants

- A lane is one client/proxy endpoint plus one `RequestGovernor`; every proxy-backed lane in one scan also shares the task's `ProxyTransportGate`.
- `workersPerLane` (UI name: `workersPerProxy`, label: "each IP concurrency") is the number of async workers created for every lane. Total workers are `lanes * workersPerLane`.
- The governor serializes request **start slots** per lane using `ceil((minDelayMs + random jitter) / workersPerLane)`; requests already in flight may overlap. The configured per-IP concurrency therefore increases that lane's start rate while preserving one shared scheduler for the IP.
- `ProxyTransportGate` independently protects the first hop seen by the upstream proxy provider: across all proxy lanes in one task it permits at most 8 in-flight requests and spaces actual starts by at least 80 ms. It runs inside the lane governor's request callback, so retries reacquire the gate and delay/backoff waits do not hold capacity. Cancellation rejects queued gate work; an already in-flight call is bounded by the API timeout.
- UI topology settings must travel through the entire chain: form control -> `payload()` -> server input validation -> scanner options -> actual worker-array cardinality -> status/report. A speed-estimate-only change is not a runtime concurrency change. Add a test that observes overlapping requests when touching this chain.
- `estimateCommentScan` models both layers: the per-lane cycle and, for proxy transport, the slower of the 80 ms aggregate start interval or network latency divided by 8. It reports configured Workers separately from `effectiveWorkers = min(totalWorkers, 8)`. The dashboard estimate reads the selected mode's page size/delay/jitter/concurrency plus verified lane count and measured NetEase latency.
- GUI request budget `0` means unlimited. A positive pooled budget is enforced by the shared scheduler for comment-page reservations; source discovery happens before that reservation, and governor-internal retries do not consume the aggregate reservation, so this is not an absolute hard limit on every actual HTTP request. This is a known follow-up optimization point. CLI `scan` uses the governor budget directly.
- Every `EnhancedNcmClient` request carries a 30-second upstream timeout by default. Network/`5xx`/408/425 failures first receive bounded Governor retry; a final ordinary lane failure is requeued through `LaneRecovery` with exponential 1..30 second backoff and a later success resets that lane. `403`/`429` are latched by the shared lane Governor, wake its waiters, and block that lane for the invocation instead of entering ordinary recovery; unfinished work remains checkpointed. Operator stop wakes Governor delay/backoff waiters and cancels queued transport work before another remote start.
- `AsyncWorkQueue` is the completion detector for pooled scanners: `take()` waits when the visible queue is empty but work remains in flight; every taken item must call `complete()` exactly once; `stop()` wakes waiters and rejects further requeue. Do not replace it with a plain `shift()` loop, which recreates tail under-utilization.
- The global `TaskCoordinator` lease is released idempotently on setup failure and in each async task's `finally`. Pool build/import/stop and background rechecks must not overlap an active scan, and source/parallel scans must not run together in the dashboard process.
- Do not use routine tests to create high real-world traffic. Unit/integration tests use stubs and loopback servers; real NetEase or proxy-pool checks must be explicit and low-risk.

## State, checkpoints, and coverage

- `src/state.ts` owns source-scan state. State is written to a sibling `.tmp` and atomically renamed.
- Current source state records `commentPagination: "cursor-v1"` and `commentPageSize`, plus UID, strategy/source/scope, candidates, per-song cursors/page counts, seen IDs, request/match totals, truncation, source errors, cooldown, and coverage. Changing its page size requires `--fresh` (or a new state path).
- Legacy offset checkpoints are migrated only by safely rescanning songs that were unfinished or truncated: each starts at the task's immutable `createdAt` cursor, and JSONL `commentId` de-duplication makes the intentional overlap idempotent. Completed, non-truncated songs are not rescanned merely for migration.
- `src/parallel-scanner.ts` owns `kind: "parallel-song"`, version 1 state with immutable scan range/shard/page-size identity plus per-shard cursor and counters. Writes are coalesced to about 500 ms and forced at task end.
- Adaptive child shards are appended to and persisted in the same parallel checkpoint with fresh monotonically increasing IDs. Resume loads that expanded shard list; it must not reconstruct only the original configured shard count.
- Source song progress and parallel state may persist optional `totalComments`; old version-1 checkpoints without it remain valid. The parallel `coveragePercent` is derived from persisted shard bounds/cursors at status time rather than stored as a compatibility field.
- Reusing state with a different UID/source/scope/strategy, source cursor page size, or parallel range/shard/page-size is rejected. Use `--fresh` or a new state path.
- `--fresh` ignores the checkpoint; it does not clear the JSONL output, which still de-duplicates existing comment IDs.
- `coverageComplete` is true only when all selected work finished without source failures or configured truncation. A task may have status `complete` while coverage remains incomplete.
- GUI tasks intentionally force `stopAfterFirst: false` so scanning continues until completion, cooldown, budget, failure, or manual stop.
- `data/resume-task.json` is a separate version-1, atomically written descriptor containing the most recent accepted GUI mode and non-sensitive primitive form parameters. It is not a checkpoint and never replaces state compatibility checks. Save failure is logged but must not stop scanning or checkpoint persistence.
- `GET /api/resume` returns `{ task: descriptor | null }`. At boot the renderer restores only an explicit per-mode allowlist, forces both `fresh` controls off, and waits for the user to start; it never auto-runs a recovered task. Unknown descriptor versions/malformed JSON are ignored safely. Because Electron keeps `userData` across installation, the descriptor restores parameters across versions while the existing scan JSON restores cursor/shard progress.

## Structured task diagnostics

- Each accepted GUI run writes `data/logs/{source|parallel}-{uuid}.jsonl`; packaged Electron resolves this under `userData`. Entries contain `timestamp`, `level`, `event`, `mode`, `runId`, a human message, and optional structured details.
- Stable event meanings are `task_started`, `task_finished`, `task_error`, `page_start`, `page_success`, `page_failure`, `rate_limited`, `adaptive_split`, and `resume_descriptor_failure`. Request details may include lane, song/page/shard, elapsed time, count, `hasMore`, and remote status; never include Cookie, proxy credentials, tokens, or raw private configuration.
- `TaskLogger` serializes appends. Callback/logger failures are deliberately swallowed: diagnostics must never affect request scheduling, checkpoints, results, status, or coverage.
- `GET /api/logs?mode=source|parallel&limit=N` reads the current snapshot's log path, newest first. Log and result-list endpoints use `readJsonlTail`, scanning backward in 64 KiB blocks only until the requested number of newest nonempty lines is reached, then skipping malformed JSON. This bounded UI read does not replace `JsonlResultWriter.initialize()`'s full-file ID scan for durable de-duplication. Old files persist locally but are not an arbitrary-path API; the renderer uses `textContent` for untrusted diagnostics.

## Proxy-pool design

`src/mihomo-pool.ts` supports two pool sources:

- Clash Verge: discover its merged config/profile YAML and `verge-mihomo`, choose region-diverse candidates, generate one loopback mixed listener per node, start a detached dedicated Mihomo process, then verify it.
- External: normalize supplied HTTP/HTTPS proxy URLs and verify them directly; no managed PID is required.

Verification has two gates: query the public egress IP, then call a real NetEase comment endpoint. Entries are sorted by combined IP-check and NetEase latency, de-duplicated by real egress IP, and only verified distinct IPs survive. Scans re-verify an active pool at task start.

Dashboard scan starts are fail-closed for proxies. Parallel mode requires a running, fully reverified pool. Source mode requires that pool or an explicit static proxy; without either it rejects the start unless the user explicitly enables `allowDirect`, which is saved in the non-secret resume descriptor. An expected pool that fails verification never silently falls back to direct. This boundary applies to scan jobs: `/api/song` and `/api/user` remain direct when no optional proxy is supplied, and CLI proxy behavior remains explicit to each command.

Pool selection treats an IPv4 `/24` or IPv6 `/48` as one network: only the fastest verified entry from each network may be selected. A managed or external pool that cannot fill its requested size with separate networks fails rather than using concentrated substitutes. While a pool is running and no coordinator lease is active, dashboard status schedules a non-overlapping background recheck about every 60 seconds; successful full rounds persist fresh latency/IP data and a temporary failure keeps the last known-good entries for a later retry.

Default managed pool: 8 selected exits from 48 candidates, listeners beginning at port 17891, controller on 19097. The dashboard exposes both counts (selected exits 1..32, candidates 1..128); these are defaults, not assumptions for scan logic.

Security rules:

- Generated listeners bind only to `127.0.0.1`; LAN, TUN, IPv6, and DNS are disabled in the generated Mihomo config.
- Clash profile paths accepted by the dashboard must be in the discovered allowlist. `readClashVergeProfiles` additionally confines profile files to the profile directory and accepts only YAML remote/local entries.
- Proxy URLs may contain credentials. Pool/config files use mode `0600` off Windows, dashboard responses mask credentials, and logs/errors must not expose them.
- The 8-request/80-ms transport gate reduces aggregate bursts but cannot hide the host IP from the upstream proxy provider or guarantee that a provider will never rate-limit the account.
- Never commit or print `.ncm/cookie.txt`, QR images, proxy-pool files, profile contents, tokens, `.env`, or user result/state data.

## Desktop and updates

- `src/electron-main.ts`: app/window lifecycle, loopback dashboard, navigation restrictions, IPC handlers, and Windows updater initialization.
- `src/electron-preload.ts`: the only renderer bridge. Keep `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`; expose narrowly scoped methods only.
- `src/window-shell.ts`: frameless Windows policy, desktop URL marker, and shared IPC channel constants. The sandboxed preload duplicates channel strings intentionally because it cannot require local modules at runtime.
- Renderer navigation/popups are denied and opened via the OS external browser. Static responses set a self-only CSP and prevent path traversal.
- `src/update.ts`: generic GitHub latest-release lookup and platform asset selection for web/macOS/manual fallback; API responses are cached for five minutes by the server.
- `src/windows-updater.ts`: packaged-Windows-only state machine around `electron-updater`. Auto-download/install are off; the UI checks and downloads with progress/integrity verification.
- Before installing a downloaded Windows update, `web/app.js` identifies the globally active scan, calls its stop endpoint, and polls every 250 ms until the status leaves `running`/`stopping`. Scanner cancellation stops new queue scheduling and task exit forces its final checkpoint. Only then may the renderer invoke silent restart/install. A 45-second timeout or any stop/status error cancels installation rather than risking an unconfirmed checkpoint; receiving the initial stop response alone is not sufficient.
- Release notes received from `electron-updater` are normalized into readable plain text before being sent to the renderer. This is intentionally defensive: GitHub-authored HTML such as headings/lists and encoded entities must never render as literal markup in the update dialog.
- `electron-updater` is loaded lazily only when packaged Windows initializes native updates. Never use its nonexistent default export, and keep updater initialization failure non-fatal so the dashboard can fall back to manual release checks. Desktop startup/updater/renderer failures are written under `userData/logs/desktop.log`.
- Windows auto-update releases require all three matching artifacts: the NSIS `.exe`, its `.exe.blockmap`, and `latest.yml`. The metadata names/version/hash must match the final installer. A client older than the first updater-capable release still needs one manual upgrade.

## File map

| Path | Responsibility |
| --- | --- |
| `src/types.ts` | Shared domain, state, option, and report contracts. |
| `src/api.ts` | Adapter over pinned `@neteasecloudmusicapienhanced/api`; 30-second default timeout and response/error normalization. |
| `src/auth.ts` | QR login polling and private cookie persistence. |
| `src/governor.ts`, `src/errors.ts` | Start spacing, budgets, retries, cooldown/cancel signals. |
| `src/proxy-transport-gate.ts` | Task-wide proxy first-hop concurrency and start smoothing. |
| `src/lane-recovery.ts` | Recoverable per-lane failure backoff and success reset. |
| `src/scanner.ts`, `src/state.ts` | User-source/history scans, pooled workers, checkpoints, coverage. |
| `src/parallel-scanner.ts` | Cursor time shards, adaptive splitting, lane failover, parallel checkpoints. |
| `src/progress.ts` | Comment-total reconciliation and split-stable parallel time coverage. |
| `src/work-queue.ts` | Waitable, requeueable async work queue and completion detection. |
| `src/cursor-pagination.ts` | Shared strict descending-cursor validation. |
| `src/task-coordinator.ts` | Global source/parallel/pool lease and frozen elapsed-time calculation. |
| `src/task-log.ts` | Serialized per-run structured JSONL diagnostics and reads. |
| `src/jsonl-tail.ts` | Bounded reverse-block reads for newest JSONL rows. |
| `src/results.ts` | Serialized JSONL append, de-duplication, NetEase comment URL. |
| `src/mihomo-pool.ts` | Clash discovery, managed Mihomo, external pools, egress verification. |
| `src/estimate.ts` | Pure throughput/duration estimator. |
| `src/server.ts` | Loopback HTTP API, coordinated job/auth/pool managers, resume descriptors, logs, SSE, validation, static files. |
| `src/cli.ts` | `auth-qr`, `scan`, `scan-song`, `proxy-pool`, and `web` commands. |
| `src/update.ts` | GitHub release check and manual asset selection. |
| `src/windows-updater.ts` | Native Windows update controller/state machine. |
| `src/electron-main.ts`, `src/electron-preload.ts`, `src/window-shell.ts` | Desktop host and isolated renderer bridge. |
| `web/index.html` | Accessible controls/dialog structure; no inline scripts/styles because of CSP. |
| `web/app.js` | UI state, API calls, polling/SSE, estimates, native update UX. |
| `web/styles.css` | Responsive/desktop styling, integrated thin transparent-track scrollbars, and reduced-motion handling. |
| `test/` | Node test-runner coverage by source module; upstream and network behavior are stubbed. |
| `build/` | Icons and electron-builder macOS metadata hook. |
| `scripts/build-mac.cjs` | Builds signed DMGs in a temp directory, then copies artifacts to `release/`. |
| `.github/workflows/windows-package.yml` | Runs tests, launches the packaged Windows app in smoke mode, builds NSIS assets, and uploads them for release. |

## Dashboard HTTP surface

- Health/update: `GET /api/health`, `GET /api/update`.
- Recovery/diagnostics: `GET /api/resume`, `GET /api/logs?mode=source|parallel&limit=N`.
- User-source job: `GET|POST /api/job`, `POST /api/job/stop`, `GET /api/results`, `GET /api/results/stream`.
- Parallel job: `GET|POST /api/parallel/job`, `POST /api/parallel/job/stop`, `GET /api/parallel/results`, `GET /api/parallel/results/stream`.
- Pool: `GET /api/pool`, `POST /api/pool/start|import|stop`.
- Lookups/tools: `GET /api/user`, `GET /api/song`, `GET /api/estimate`.
- Auth: `GET /api/auth`, `POST /api/auth/qr`, `GET /api/auth/qr.png`.

Inputs are bounded in `src/server.ts`; body size is capped at 64 KiB; IDs must be decimal digits; proxy schemes are HTTP/HTTPS only. Preserve these boundaries when adding endpoints.

## README factual contract

The README may be reorganized or shortened, but a rewrite must preserve these user-visible truths and must not turn estimates or external release state into guarantees:

- The target is a numeric NetEase user UID. The dashboard has an adjacent UID tutorial; the ID comes from the user's profile URL, not the nickname.
- For another user, the app discovers candidate songs from public listening rank and/or likes, then matches normalized comment author IDs exactly. Logged-in self lookup may use comment history. Source visibility still depends on privacy settings and login state.
- User-source and single-song paths both use descending `comment_new` cursors now, but source scheduling/checkpoints and parallel half-open time shards remain different. Source comment pages default to 1000 and accept 1..2000.
- The GUI defaults to continuous scanning (`requestBudget=0`, no stop-after-first); CLI `scan` retains its finite per-run default and resumes from JSON checkpoints. `403/429`, explicit truncation, partial source failure, and operator stop affect status/coverage exactly as documented in this memory.
- Pooled scheduling is page-granular; parallel mode adaptively bisects unread ranges when Workers are waiting. Structured events distinguish ordinary failures, explicit rate limits, and scheduler splits.
- The dashboard shows global and current-song progress separately. Source global progress counts completed songs; parallel global progress is cursor-weighted time coverage. Comment totals are optional live API estimates, not completion authority, and the runtime timer freezes at the server's terminal elapsed value.
- There is no database. Results are de-duplicated JSONL and durable state is atomic JSON. CLI/web defaults use repository-local `.ncm/` and `data/`; packaged Electron uses its `userData` directory.
- Cross-version GUI recovery uses both `data/resume-task.json` (form parameters only) and the mode-specific scan checkpoint (progress). Restore does not auto-start and must leave `fresh` disabled. Windows installation stops the active scan, waits for terminal status/final checkpoint, and aborts on timeout before calling the updater.
- An old offset checkpoint is migrated by rescanning only unfinished/truncated songs from its immutable creation-time cursor. Changing cursor page size requires a fresh state, while existing JSONL still de-duplicates IDs.
- A lane is a verified proxy endpoint/egress; per-IP Workers share one Governor. Proxy-backed scan lanes also share the fixed host gate (8 in flight, 80 ms between starts), and ordinary lane failures back off and recover instead of permanently shrinking the pool. Managed/external pools are verified against both public egress IP and NetEase, isolated by IPv4 `/24` or IPv6 `/48`, configurable from the dashboard (current defaults 8 exits from 48 candidates), and rechecked in non-overlapping background rounds while online.
- Proxy credentials, cookies, QR data, state, and results are local sensitive runtime data and never release assets. The application is a loopback-local dashboard; routine tests do not exercise high-volume real traffic.
- Speed figures are estimates based on page size, thread spacing/jitter, verified lanes, Worker count, and measured latency. Cooldowns, source discovery, retries, and remote behavior can make reality slower.
- Windows packaged clients support in-app updates only from updater-capable versions onward and a valid Release needs `.exe`, `.exe.blockmap`, and `latest.yml`. Web/macOS use the manual-release path; public macOS distribution still needs proper Developer ID signing/notarization beyond the local ad-hoc build.
- Source requires Node.js 20+ and keeps `@neteasecloudmusicapienhanced/api` pinned. The documented check/test/build commands and Windows package-validation workflow are release gates.
- Concrete version numbers, filenames, tags, download links, and "latest release" statements must match `package.json` and live GitHub state at publication time. The current work is an upcoming release, not evidence of publication; prefer version-neutral instructions in long-lived prose.

## Development and verification

Node.js 20+ is required. The upstream API dependency is pinned exactly; do not loosen it casually because resumed scans must not change semantics mid-checkpoint.

```bash
npm ci                 # clean dependency install
npm run check          # strict TypeScript, no emit
npm test               # node:test through tsx
npm run build          # compile src/ to ignored dist/
npm run web            # browser dashboard on 127.0.0.1:4173
npm run desktop        # build and run Electron
npm run desktop:smoke:mac
npm run dist:win       # x64 NSIS installer + blockmap + latest.yml
npm run dist:mac       # arm64 DMG
npm run dist:mac:all   # arm64 and x64 DMGs
```

Before handing off a code change, run at least `npm run check && npm test && npm run build`, plus the relevant desktop smoke/package command when Electron, preload, updater, build config, or packaged assets change. Also run `git diff --check`. Add or update the focused test file for changed behavior; do not accept a UI-only assertion as proof of backend/runtime behavior.

## Release checklist

1. Before the next release, choose its semantic version and set the same value in `package.json` and `package-lock.json`. Update README statements that name a concrete artifact/version; source changes alone do not mean the release exists.
2. Run the full verification above and build platform artifacts from the final source/version.
3. For Windows, dispatch `Windows package validation`, require its packaged-app smoke test to pass, and use its uploaded artifacts. Inspect `latest.yml` and ensure the final `.exe`, `.exe.blockmap`, and `latest.yml` all exist. Do not rename one without regenerating metadata.
4. Commit/push the source, create tag `vX.Y.Z` on that exact commit, and publish a **stable** GitHub Release with the platform assets. The repository configured in `package.json` and `src/update.ts` is `RocXOvO/ncm-comment-finder`.
5. Verify the public Release assets and hashes after upload, and confirm the latest stable Release points to the intended version. Do not mark a broken build as latest; preserve an explicit upgrade path for users whose updater cannot start.

Local verification, the Windows workflow, and post-upload checks are all release gates; one does not replace the others.

## Common traps

- Editing only the estimator/UI can make a concurrency number look changed while execution still uses an old/default worker count. Trace and test the full topology path.
- Source scan and `scan-song` both use `comment_new` time cursors, but they retain different scheduling, state, defaults, and privacy/login behavior. `comment_music` is legacy compatibility only: endpoint evidence showed `limit=100` returned 100 records while 200/500/1000 returned only 20, which is why old offset pagination must not be extended for large pages.
- Multiple workers share one governor per lane. Giving every worker its own governor would accidentally multiply the per-IP start rate.
- Per-IP Governors and the task-wide proxy gate protect different boundaries. Do not remove either, place the gate outside Governor delay/backoff, or count configured Workers above 8 as guaranteed simultaneous proxy capacity.
- A normal network failure is recoverable lane work, not permanent lane removal; only the explicit cooldown path blocks a lane for the run. Always requeue its unfinished page exactly once while applying `LaneRecovery`.
- Pool entry count is not proof of independent capacity; only verified distinct egress IPs count as lanes.
- Source `both` may finish with partial coverage when one source is restricted. Keep `sourceErrors` and coverage semantics visible.
- A finished checkpoint returns immediately. When testing a changed configuration, use a fresh temp state path; do not silently mutate compatibility fields in old state.
- The resume descriptor only restores UI parameters; the checkpoint remains authoritative. Do not mark a restored task `fresh`, auto-start it, store secrets in the descriptor, or silently coerce an incompatible checkpoint.
- Dynamic parallel splits make `state.shards.length` larger than the configured `shardCount`. Status/settlement must report the actual array, while compatibility still compares the original configured count.
- Neither progress bar is completion authority. Source's latest active song can change under multiple Workers, API comment totals can change, and parallel shard counts grow after a split; preserve monotonic total reconciliation and time-coverage math rather than forcing UI percentages into state.
- Overlapping dashboard polls are normal. Keep the newest-request sequence guard before any render/clock synchronization so a slow older response cannot rewind live state.
- A logger callback is observability only. Never branch scan correctness on successful logging, and never expose a caller-supplied log path through the HTTP API.
- Runtime paths differ: source/CLI defaults use the project root; packaged Electron uses `userData`. Never hardcode repository runtime paths in desktop code.
- `dist/` is generated from `src/` and ignored. Edit TypeScript sources, not compiled JavaScript.
- GitHub's generic latest-release check and native Windows `electron-updater` are separate paths. Test both when changing update UX. In particular, verify HTML release notes become plain text in the native updater state, not merely in a browser-only view.
- A source page-size control in the UI or estimate is not evidence that source scanning safely uses it. Trace the setting through CLI/UI, server, scanner, `comment_new` cursor update, state compatibility, and the legacy-checkpoint `createdAt` rescan path.

## Maintaining this memory

Update this file in the same commit whenever a change alters module ownership, entry points, routes, state schema/compatibility, concurrency/rate semantics, proxy validation, security boundaries, build commands, artifacts, or release/update behavior. Verify claims against current code and tests, remove stale statements instead of appending history, and keep user instructions in `README.md` synchronized. If only implementation details change without affecting how a future agent navigates or reasons about the system, no memory edit is needed.
