# Project memory for AI agents

This file is the durable architecture map for `ncm-comment-finder`. Read it before changing code. Keep it factual and compact; it describes the current system, not a changelog.

## Product and runtime shapes

The app finds NetEase Cloud Music comments authored by a numeric user UID. It has three entry shapes over the same TypeScript core:

- CLI: `src/cli.ts`, run with `npm run start -- <command>`.
- Local web dashboard: `src/server.ts` serves `web/` on `127.0.0.1`; run with `npm run web`.
- Electron desktop: `src/electron-main.ts` starts the dashboard on an ephemeral loopback port and loads it in a sandboxed window. Packaged runtime data lives under Electron's `app.getPath("userData")`, not the repository.

There is no database. Durable scan state is JSON; matches are append-only JSONL. Generated/runtime directories (`dist/`, `release/`, `.ncm/`, `data/`, `tmp/`) are ignored and must not be committed.

The code version is authoritative in `package.json` and `package-lock.json`. Do not infer a successful GitHub Release from local files; verify the live tag, commit, and assets when releasing or evaluating an update.

## Architecture and data flow

Two scan engines exist and must not be conflated:

1. User-source scan (`scan`, `/api/job`, `runPooledCommentFinder`)
   - Read candidate songs from listening rank (`user_record`), likes (`likelist`), or both.
   - Liked-song discovery requires a saved NetEase login session. Treat upstream status/code `301` as authentication failure, not proxy failure: fail once with a re-login prompt and never fan the same request across pool lanes.
   - Merge songs by ID while preserving record-first order and source metadata.
   - Page each song through `comment_new` with a descending time cursor, match `comment.user.userId` exactly, and write results. The default page size is 1000 and the accepted range is 1..2000.
   - When `hasMore` is true, the next cursor must be strictly older than the prior cursor. An empty page may still continue when `hasMore` is true and the cursor advances; non-progress or an exception remains recoverable work and must not be reported as complete.
   - `auto` in the CLI may select `user_comment_history` only when the logged-in account UID equals the target. The GUI deliberately uses `strategy: "scan"`.
   - With a verified pool, one lane is created per task-selected distinct egress. Automatic task selection (`maxProxyLanes=0`) uses every verified egress; a positive limit selects only the ordered prefix without changing the shared pool. A song page is one queue item; after a successful page, unfinished songs are requeued so Workers fairly rotate instead of one Worker monopolizing a long song.
   - At pooled-source startup, unfinished songs are pre-sharded round-robin until initial work reaches `min(lanes * workersPerLane, transportGate.currentMaxConcurrent)` (or all configured Workers without a gate), subject to page caps and shard limits. This also expands a resumed song's small set of unfinished persisted shards to the new target by repeatedly splitting the largest remaining cursor range; both split halves preserve that shard's current `pageNo`. Newly sharded cursors inherit the song's current `commentPageNo`, so resume never relabels an unfinished request as page 1.
   - If Workers are waiting after a song cursor advances, that song's unread `[2000-01-01, nextCursor)` range is promoted to non-overlapping half-open `commentShards`. This keeps a one-song source scan and the few-song tail parallel across lanes. Further unread shard ranges use the same adaptive split math as the single-song engine.
   - Source shard IDs are local to a song, so scheduler events include `songId`. `pageInSong` is the aggregate successful-page count across all shards; the UI never substitutes a shard-local `pageNo` for it.
   - `maxCommentPagesPerSong` is an aggregate successful-page cap across a song's cursor and all shards. Per-song permits include in-flight requests; a failed request releases its permit and cannot prematurely mark the song truncated. After the accepted page that reaches the cap, natural end-of-cursor or shard completion is applied first; the song is marked truncated only if uncovered work still remains. The global request budget is reserved separately before dispatch.

2. Single-song parallel scan (`scan-song`, `/api/parallel/job`, `runParallelSongScan`)
   - Read the song metadata, split `[startTime, endTime)` into non-overlapping time shards, newest first, and paginate `comment_new` using descending cursors. One shard page is one queue item.
   - After a page advances, if Workers are waiting, the unread range `[shard.startTime, nextCursor)` is bisected into two non-overlapping half-open shards and both are requeued. The original configured `shardCount` remains the checkpoint compatibility key, while `state.shards.length` and report progress grow with adaptive splits.
   - Failed/cooling lanes return unfinished work to the shared queue for healthy lanes. An adaptive split or failover must never duplicate/skip a time range; JSONL de-duplication is a final idempotency guard, not a substitute for correct range math.
   - Cursor pages are filtered back to the shard's half-open range before UID matching. The endpoint is intentionally called without a login cookie.
   - Dashboard global percentage is cursor-weighted time coverage, computed from the remaining time in every unfinished shard. It therefore survives adaptive splits without the artificial regression caused by `shardsComplete / shards`; it is time coverage, not an estimate of uniformly distributed comments.

Common result flow:

`EnhancedNcmClient` -> scanner -> `JsonlResultWriter` -> JSONL on disk -> optional `onMatch` callback -> server SSE -> `web/app.js` live table. Alongside it, source/parallel request and scheduler activity feed a best-effort `TaskLogger` and the dashboard log view.

`comment_new` success is strict: a non-object/empty/truncated body, non-200 body code, missing object `data`, non-array `comments`, non-boolean `hasMore`, any unnormalizable comment, or `hasMore` without a finite cursor strictly older than the request is a retryable 502-style malformed response, never an empty completed page or cursor advance. Both resolved and rejected upstream responses use numeric `body.code` as the effective status even when HTTP status is 200; sanitized parse/timeout summaries may be logged, but never raw bodies or proxy credentials.

Both scanners give Workers stable invocation-local IDs (`lane-name:worker-number`) and start them with `workerIndex` as the outer loop and lanes as the inner loop, so worker 1 is offered across exits before worker 2 on any exit. Page-request `start`/`success`/`failure` activity includes the Worker plus song ID/name. Source `JobManager` keeps each in-flight request and its page in `activeSongByWorker`, then de-duplicates rows by song ID; the row's requesting page is the minimum among that song's still-active Workers, while successful-page progress is stored independently. Single-song `ParallelJobManager` uses one O(1) Worker-ID set and attaches the task's global page/comment/total plus cursor-weighted `coveragePercent`. Both clear activity on every terminal path. Source's legacy-compatible `currentSong` remains aggregate progress only; live activity comes from `activeSongs`.

Both scanners publish lightweight counter snapshots through `onCheckpoint` when their in-memory checkpoint counters advance, immediately before the corresponding durable write. Dashboard pooled-source writes are coalesced to about 350 ms and parallel writes to about 500 ms; the serial source runner still checkpoints directly. The managers use those callbacks for running dashboard status; `GET .../job` must not repeatedly read/parse the checkpoint while a task is active. Disk state is still authoritative for resume and may be read once to reconcile a terminal snapshot. Status callbacks are best-effort presentation and must never affect persistence or scheduling.

The writer serializes concurrent appends and de-duplicates by `commentId`, including IDs already on disk. Its startup scan streams JSONL in 64 KiB chunks and periodically yields to the event loop; do not restore a whole-file `readFile().split()` path that can stall Electron when results are large. SSE/UI failure must never interrupt persistence.

Song identity is a domain concern, not renderer decoration. Listening-rank entries normally include names, but `likelist` supplies IDs only. `EnhancedNcmClient.getSongInfos` de-duplicates IDs and calls `song_detail` with comma-separated IDs; `hydrateMissingSongMetadata` first builds one `missing song ID -> candidate references` map, then processes its IDs in batches of at most 500 without rescanning the full candidate list per batch or disturbing source/discovery order. Each successful batch updates only its indexed candidate references immediately. If a later batch fails, the scanner counts the already-applied names and still forces a checkpoint, so partial metadata work survives while remaining IDs retain their fallback. Serial and pooled source scans run this hydration after discovery and when resuming older unnamed checkpoints, persist newly found names/artists in the existing state, and publish the catalog to `JobManager`. Its in-memory ID/name map enriches source SSE and result-list rows when needed. Metadata failure is non-fatal except cancellation, must retain an ID-based fallback, and must never become renderer-side per-row/per-poll requests.

## Task snapshots, live progress, and terminal settlement

The dashboard keeps separate in-memory snapshots for source and parallel history, but a shared `TaskCoordinator` permits only one active source scan, parallel scan, or pool mutation at a time. Every accepted `POST .../job` receives a new UUID. The renderer polls both snapshots about every 1.5 seconds while result rows arrive independently over SSE. Status polling is single-flight (never overlapping), slows while the document is hidden, and resumes immediately when visible.

Renderer button disabling during pool selection is only UX. `TaskCoordinator` leases and HTTP 409 responses are the authoritative mutual-exclusion boundary. Every renderer path that changes task availability must converge through `syncTaskStartAvailability`; individual render functions must not independently re-enable a start button.

- Result descriptors are generation-consistent. Source start computes local next state/output paths, completes every awaited preflight, then publishes `statePath`, `outputPath`, and the snapshot job ID synchronously with no intervening `await`; a rejected start leaves the previous result descriptor intact. Source and parallel `results()` capture `jobId` plus `outputPath` before awaiting the JSONL read, and source also clones its song-name map, so one response cannot mix generations.
- Source and parallel live activity comes from request activity keyed by Worker. `activeSongs` describes only requests currently in flight, de-duplicates songs by ID, and sums their active Workers; it is not a completion list, queue snapshot, or promise that a missing song is finished. Source `pagesProcessed`/`pageInSong` counts only successful pages. Its one-based `requestingPage` belongs to each Worker request; a song row shows the minimum page among its still-active Workers and removes it when those requests settle, without overwriting successful-page progress. Each row may also carry `commentsProcessed`, `totalComments`, and `progressPercent`; source percent is comments/known total. The single parallel song sets `progressBasis: "time"` and uses split-stable cursor-weighted `coveragePercent`: that percentage is time-range coverage, never total-comment completion, even when `totalComments` is known.
- Checkpoint counters remain authoritative for durable progress (`songsProcessed`, pages/shards, requests, and matches). `onCheckpoint` mirrors those counters into memory without a hot-path disk read; request activity may be newer than the latest coalesced checkpoint, but neither callback may mutate checkpoint cursor semantics.
- The workspace has one task-total progress bar. Source global progress is completed songs over selected songs; parallel global progress is cursor-weighted time coverage. The central `activity` output tab separately lists in-flight songs and Worker counts without inventing per-song completion. `totalComments` remains optional scanner/report data, and `mergeCommentTotal` keeps the maximum of stored total, latest credible total, and processed count; UI percentages never determine task completion.
- Both snapshot shapes expose the same task-timing contract: `startedAt`, optional `finishedAt`, and non-negative `elapsedMs`. While status is `running`/`stopping`, elapsed time is `now - startedAt`; after a terminal transition it is frozen at `finishedAt - startedAt`. Polling a finished task must not keep increasing its duration.
- `finishedAt` is assigned once when the manager settles a report or error. Use the manager's snapshot timestamps for UI timing in both modes rather than mixing them with scanner-local report timers, which start at slightly different points.
- The renderer's single runtime clock is resynchronized from the active snapshot on each accepted poll, then advanced with `performance.now()` once per second only while status is `running`/`stopping`; it skips identical text and freezes at the terminal value. Do not create timers inside render functions, and clear the singleton timer on `pagehide`.
- Both managers reset a `CommentRateTracker` per job and feed it only page activity published as successful after descending-cursor validation, using the actual returned comment count. Snapshot `commentsPerSecond` is the one-decimal rolling rate over at most 10 seconds (minimum one-second observation), decays to zero when no successful comments remain in the window, and is forced to zero after the job stops. Invalid cursors publish `failure` status 502 and never inflate rate or progress. This is measured throughput, distinct from matches, requests, estimates, and durable progress.
- Combined job/pool refreshes are single-flight: timer, visibility, mode-switch, and manual refresh triggers share the same pending Promise, so an older overlapping poll cannot roll progress, status, pool state, or the runtime clock backward.
- Repeated identical job and active-song snapshots do not rewrite their DOM. SSE matches are buffered into short render batches and the visible-result map remains bounded. Result APIs return the descriptor's captured `jobId`; a changed job generation clears old rows. During one snapshot request, newly arrived SSE IDs stay first, followed by the snapshot's newest-first order and then retained older IDs, without sorting by historical comment time. A high match rate must not rebuild the whole results table once per comment. The log tab refreshes at most about every three seconds and skips identical table payloads.
- Dashboard-terminal statuses are `complete`, `matched`, `paused`, `cooldown`, `dry-run`, `stopped`, and `error`. `idle`, `running`, and `stopping` must not produce a settlement screen. Paused/cooldown/stopped are resumable but still end the current invocation and therefore get a settlement.
- The task-end settlement UI is keyed by scan mode plus snapshot UUID and opens at most once for that task, even though polling repeatedly renders the same terminal snapshot. Starting a new UUID clears the prior task's presentation state; dismissing a settlement must not let the next poll reopen it.
- Settlement values come from the terminal snapshot: duration from `elapsedMs` and total hits from `matches`. Never derive hits from the renderer's visible-result map, which is capped and mode-local. `matches` is checkpoint-cumulative across resumptions; `elapsedMs` is for the current UUID/invocation. If product copy ever promises cross-restart cumulative runtime, add a persisted duration field to the state schema instead of relabeling this value.
- The settlement is a presentation layer over the existing task/results view: results stay persisted and accessible, zero matches is a valid successful outcome, and error/cooldown notes remain visible. Render server text with `textContent`, give a dialog/overlay correct focus and close behavior, and honor `prefers-reduced-motion`.
- Preserve behavioral tests for live/frozen elapsed time, progress math, scanner checkpoint callbacks, Worker-keyed activity, discovery-order rendering, stale-refresh rejection, and renderer settlement de-duplication; a static HTML text assertion alone is insufficient evidence.

## Concurrency and rate-control invariants

- A lane is one client/proxy endpoint plus one `RequestGovernor`; every proxy-backed lane in one scan also shares the task's `ProxyTransportGate`.
- `workersPerLane` (UI name: `workersPerProxy`, label: "each IP concurrency") is the number of async workers created for every lane. Total workers are `lanes * workersPerLane`.
- The governor serializes request **start slots** per lane using `ceil((minDelayMs + random jitter) / workersPerLane)`; requests already in flight may overlap. The configured per-IP concurrency therefore increases that lane's start rate while preserving one shared scheduler for the IP.
- `hostConcurrency` is the configured per-task proxy transport ceiling, accepted by source/parallel start and estimate APIs as `1..32` with default 8. The shared `ProxyTransportGate` starts at that ceiling, with 80 ms plus 0..40 ms jitter between first-hop starts. Three transient failures (undefined status, 408, 425, or 5xx) within 10 seconds halve the effective ceiling (`18 -> 9`, floor `min(4, configured)`) and scale the base start interval by `configured/effective`. After at least 20 successful gated requests and five seconds since the last adjustment, it restores one slot at a time. Retries reacquire the gate; waits do not hold capacity; snapshots expose `proxyTransportEffectiveConcurrent` so the UI can distinguish configured and auto-reduced capacity.
- Topology settings travel through the full runtime path: toolbar form -> source/parallel payload -> server validation -> lane selection/gate construction -> snapshot/log/resume -> toolbar and estimator. `workersPerLane` and selected exits determine configured Worker-array cardinality; `hostConcurrency` is only a shared upper bound and never creates Workers. The renderer shows selected/available exits and active/configured Worker counts, and warns when configured Workers are below the host ceiling.
- Managed-pool capacity and per-task exit selection are separate. `maxProxyLanes` accepts `0..32`: `0` automatically selects all ordered verified exits; a positive value caps the task subset, always bounded by availability. Its selection metadata records requested versus actual lanes. Extra Workers wait behind the shared host gate, so using all exits does not bypass `hostConcurrency`; it improves egress rotation and failover. Static-proxy/direct source scans still use one lane and do not shrink or rebuild the shared pool.
- `estimateCommentScan` models the configured per-lane cycle and proxy ceiling: start delay plus jitter (0/half/full for optimistic/expected/conservative) or network latency divided by `hostConcurrency`. It reports configured Workers separately from `effectiveWorkers = min(totalWorkers, hostConcurrency)`; this planning estimate does not predict a future adaptive downshift, while live snapshots report the current effective gate.
- GUI request budget `0` means unlimited. A positive pooled budget is enforced by the shared scheduler for comment-page reservations; source discovery happens before that reservation, and governor-internal retries do not consume the aggregate reservation, so this is not an absolute hard limit on every actual HTTP request. This is a known follow-up optimization point. CLI `scan` uses the governor budget directly.
- Every `EnhancedNcmClient` request carries a 30-second upstream timeout by default. Network/`5xx`/408/425 failures first receive bounded Governor retry; a final ordinary lane failure requeues the exact work and applies exponential 1..30 second `LaneRecovery`. Five consecutive final failures mark the lane unavailable, but source and parallel scanners track `activeLaneRequests` and do not declare total exhaustion until all in-flight lane work settles. A late success resets recovery, removes the unavailable mark, and `recordSuccess()` wakes Workers waiting on the obsolete backoff. Cooldown supersedes ordinary unavailability. Determine exhaustion with `lanes.every(blocked || unavailable)`, never by adding set sizes; mixed/repeated-failure exhaustion settles as `paused`, while all-cooldown remains `cooldown`. Required work uses `RequestGovernor.execute`; optional enrichment uses non-poisoning `executeBestEffort` without weakening required `403/429` behavior.
- Each task Manager owns an `AbortController`. Stop aborts the scanner signal and cancels Governors/gate; the scanner listener closes the queue, cancels every `LaneRecovery`, and wakes other internal waiters before another remote start. Default recovery timers are cleared when cancellation wakes them. Remove the abort listener at scanner exit and clear the controller on all setup/terminal paths.
- Pooled metadata hydration creates one local session per hydration run with a rotating `nextLaneIndex` and a local `cooldownLanes` set. Successful batches advance the starting lane so healthy metadata-capable exits share work. A `CooldownRequired` marks that lane only in this optional session and later metadata batches skip it; ordinary failures may try the next lane but are not permanently skipped. This local set must never be reused as, copied into, or allowed to mutate the pooled comment scanner's correctness-critical `blockedLanes`; the non-latching Governor policy alone is not a substitute for that scope separation.
- `AsyncWorkQueue` is the pooled scanners' completion detector: `take()` waits while work remains in flight; every taken item calls `complete()` exactly once; `stop()` wakes waiters and rejects requeue. Each scanner registers exactly one `whenClosed()` continuation that cancels all lane recoveries; Workers await recovery normally, then check `isClosed()` before taking work. Do not create one closure reaction per page/Worker. Queue removal uses an amortized O(1) head cursor and compacts only after at least 1,024 consumed slots and half the backing array; preserve FIFO across compaction/requeue and never restore repeated `Array.shift()`.
- The global `TaskCoordinator` lease is released idempotently on setup failure and in each async task's `finally`. Pool build/import/stop and background rechecks must not overlap an active scan, and source/parallel scans must not run together in the dashboard process.
- Do not use routine tests to create high real-world traffic. Unit/integration tests use stubs and loopback servers; real NetEase or proxy-pool checks must be explicit and low-risk.

## State, checkpoints, and coverage

- `src/state.ts` owns source-scan state. Source/parallel state, the GUI resume descriptor, and proxy-pool status all use `src/atomic-file.ts`: same-directory unique temporary names, fsync, and bounded `EPERM`/`EBUSY`/`EACCES` rename retry. A failed final rename never deletes the formal file and leaves the completed temp recoverable. Reads skip only unreadable/malformed JSON while choosing the newest syntactically complete formal/new-style/legacy candidate; once parsed, its decode/schema result is authoritative and failure must never fall back to older state. Proxy-pool recovery is covered explicitly because an interrupted rename must not lose managed-process identity.
- Current source state is version 2 and records `commentPagination: "cursor-v1"` and `commentPageSize`, plus UID, strategy/source/scope, candidates, per-song cursors/page counts/optional `commentShards`, seen IDs, request/match totals, truncation, source errors, cooldown, and coverage. Version-1 cursor state is upgraded on read; changing page size requires `--fresh` (or a new state path). Writing version 2 makes older clients reject shard-aware state instead of silently ignoring it.
- Candidate names/artists are optional fields in the existing source-state schema. Metadata hydration updates each successful batch in place and forces a checkpoint when discovery or any hydration batch changed the catalog, even if a later optional batch failed. Old unnamed liked-song checkpoints therefore gain and retain partial titles without a state-version bump or source rediscovery.
- Legacy offset checkpoints are migrated only by safely rescanning songs that were unfinished or truncated: each starts at the task's immutable `createdAt` cursor, and JSONL `commentId` de-duplication makes the intentional overlap idempotent. Completed, non-truncated songs are not rescanned merely for migration.
- `src/parallel-scanner.ts` owns `kind: "parallel-song"`, version 1 state with immutable scan range/shard/page-size identity plus per-shard cursor and counters. Writes are coalesced to about 500 ms and forced at task end.
- Adaptive child shards are appended to and persisted in the same parallel checkpoint with fresh monotonically increasing IDs. Resume loads that expanded shard list; it must not reconstruct only the original configured shard count.
- Source song progress and parallel state may persist optional `totalComments`. Pooled and serial source runners both consume unfinished source shards, so changing entry shape never silently restarts the pre-split cursor range. In both source and parallel scanners, comments without a usable `time` are inspected and assigned to the shard response that returned them rather than dropped; cursor-boundary math uses only finite timestamps, and `commentId` de-duplication guards repeated delivery. Parallel `coveragePercent` is derived from persisted shard bounds/cursors at status time rather than stored as a compatibility field.
- Reusing state with a different UID/source/scope/strategy, source cursor page size, or parallel range/shard/page-size is rejected. Use `--fresh` or a new state path.
- `--fresh` ignores the checkpoint; it does not clear the JSONL output, which still de-duplicates existing comment IDs.
- `coverageComplete` is true only when all selected work finished without source failures or configured truncation. A task may have status `complete` while coverage remains incomplete.
- GUI tasks intentionally force `stopAfterFirst: false` so scanning continues until completion, cooldown, budget, failure, or manual stop.
- `data/resume-task.json` is a separate version-1, atomically written descriptor containing the most recent accepted GUI mode and non-sensitive primitive form parameters, including `maxProxyLanes` and `hostConcurrency`. It is not a checkpoint and never replaces state compatibility checks; topology used by a prior invocation is not scan-state compatibility. Save failure is logged but must not stop scanning or checkpoint persistence.
- `GET /api/resume` returns `{ task: descriptor | null }`. At boot the renderer restores only an explicit per-mode allowlist, forces both `fresh` controls off, and waits for the user to start; it never auto-runs a recovered task. Unknown descriptor versions/malformed JSON are ignored safely. Because Electron keeps `userData` across installation, the descriptor restores parameters across versions while the existing scan JSON restores cursor/shard progress.

## Structured task diagnostics

- Each accepted GUI run writes `data/logs/{source|parallel}-{uuid}.jsonl`; packaged Electron resolves this under `userData`. Entries contain `timestamp`, `level`, `event`, `mode`, `runId`, a human message, and optional structured details.
- Stable event meanings are `task_started`, `task_finished`, `task_error`, `page_start`, `page_success`, `page_failure`, `rate_limited`, `adaptive_split`, and `resume_descriptor_failure`. Request details may include lane, song/page/shard, elapsed time, count, `hasMore`, and remote status; never include Cookie, proxy credentials, tokens, or raw private configuration.
- `TaskLogger` serializes appends. Callback/logger failures are deliberately swallowed: diagnostics must never affect request scheduling, checkpoints, results, status, or coverage.
- `GET /api/logs?mode=source|parallel&limit=N` reads the current snapshot's log path, newest first. Log and result-list endpoints use `readJsonlTail`, scanning backward in 64 KiB blocks only until the requested number of newest nonempty lines is reached, then skipping malformed JSON. This bounded UI read does not replace `JsonlResultWriter.initialize()`'s full-file ID scan for durable de-duplication. Old files persist locally but are not an arbitrary-path API; the renderer uses `textContent` for untrusted diagnostics.

## Proxy-pool design

`src/mihomo-pool.ts` supports two pool sources:

- Clash Verge: discover its merged config/profile YAML and `verge-mihomo`; accept one or more allowlisted profiles; validate, fairly interleave, de-duplicate, and conflict-rename inline leaf nodes; generate one config/process/controller with one loopback mixed listener per candidate; then verify it. Provider-backed or chained nodes are rejected explicitly because their relative/cache/reference semantics cannot be safely flattened.
- External: normalize supplied HTTP/HTTPS proxy URLs and verify them directly; no managed PID is required.

Verification has two gates: query the public egress IP, then call a real NetEase comment endpoint. Entries are sorted by combined IP-check and NetEase latency, de-duplicated by real egress IP, and only verified distinct IPs survive. Scans re-verify an active pool at task start.

Dashboard scan starts are fail-closed for proxies. Parallel mode requires a running, fully reverified pool. Source mode requires that pool or an explicit static proxy; without either it rejects the start unless the user explicitly enables `allowDirect`, which is saved in the non-secret resume descriptor. An expected pool that fails verification never silently falls back to direct. This boundary applies to scan jobs: `/api/song` and `/api/user` remain direct when no optional proxy is supplied, and CLI proxy behavior remains explicit to each command.

Managed pool selection treats an IPv4 `/24` or IPv6 `/48` as one network: only the fastest verified entry from each network may be selected, and a requested managed size must be filled. External import treats `size` as an upper bound and succeeds with at least one verified entry. While a pool is running and no coordinator lease is active, dashboard status schedules a non-overlapping background recheck about every 60 seconds; successful full rounds persist fresh latency/IP data and a temporary failure keeps the last known-good entries for a later retry.

The frequently-polled pool status route uses only the managed PID's cheap liveness signal and caches Clash Verge discovery for about 30 seconds. It must not spawn `ps`/PowerShell or reparse profile YAML on every renderer poll. Scan start and refresh first attempt the full executable-plus-config identity check; if OS command-line lookup is temporarily unavailable, they may accept a still-live PID only after every listener is reverified and every real egress IP exactly matches its saved entry. Stop/kill always requires the full identity check. Windows command-line lookup writes raw PowerShell console output so long AppData paths cannot be wrapped into a false mismatch.

Default managed pool: 8 selected exits from 48 candidates, listeners beginning at port 17891, controller on 19097. The dashboard exposes both counts (selected exits 1..32, candidates 1..128); these are defaults, not assumptions for scan logic. Startup listener probes use at most 16 concurrent waits and share one 15-second deadline across every bounded batch; queued ports never receive a fresh timeout.

Security rules:

- Generated listeners bind only to `127.0.0.1`; LAN, TUN, IPv6, and DNS are disabled in the generated Mihomo config.
- Clash profile paths accepted by the dashboard must be in one cached discovery allowlist; one to 32 paths may be selected. `readClashVergeProfiles` additionally confines profile files to the profile directory and accepts only YAML remote/local entries. All selected YAML and a staging `mihomo -t` validation must pass before replacing a live managed process.
- Proxy URLs may contain credentials. Pool/config files use mode `0600` off Windows, dashboard responses mask credentials, and logs/errors must not expose them.
- Scan traffic starts under the configured `hostConcurrency` ceiling and 80..120 ms aggregate spacing, then AIMD may lower effective concurrency and lengthen the base interval after clustered transient failures. Pool build/import/verify/refresh retains its separate 4-request/80-ms gate. These controls reduce burstiness but cannot hide the host IP from the upstream proxy provider or guarantee that a provider will never rate-limit the account; low latency is a health signal, not stealth.
- Task startup may reuse pool entries checked within the last 90 seconds only when the pool is still marked running, every entry is NetEase-verified, and all egress networks remain distinct. Stale or inconsistent entries still require full live verification; this avoids making every Start click repeat the background pool recheck.
- Never commit or print `.ncm/cookie.txt`, QR images, proxy-pool files, profile contents, tokens, `.env`, or user result/state data.

## Desktop and updates

- `src/electron-main.ts`: app/window lifecycle, loopback dashboard, navigation restrictions, IPC handlers, and Windows updater initialization.
- `src/electron-preload.ts`: the only renderer bridge. Keep `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`; expose narrowly scoped methods only.
- `src/window-shell.ts`: frameless Windows policy, desktop URL marker, and shared IPC channel constants. The sandboxed preload duplicates channel strings intentionally because it cannot require local modules at runtime.
- Renderer navigation/popups are denied and opened via the OS external browser. Static responses set a self-only CSP and prevent path traversal.
- `src/update.ts`: generic GitHub latest-release lookup and platform asset selection for web/macOS/manual fallback; API responses are cached for five minutes by the server.
- `src/windows-updater.ts`: packaged-Windows-only state machine around `electron-updater`. Auto-download/install are off; the UI checks and downloads with progress/integrity verification.
- Before installing a downloaded Windows update, `web/app.js` identifies the globally active scan, calls its stop endpoint, and polls every 250 ms until the status leaves `running`/`stopping`. Cancellation stops new queue scheduling and wakes Governor, transport-spacing, and lane-recovery waits; task exit then forces its final checkpoint. Only then may the renderer invoke silent restart/install. A 45-second timeout or any stop/status error cancels installation rather than risking an unconfirmed checkpoint.
- Release notes received from `electron-updater` are normalized into readable plain text before being sent to the renderer. This is intentionally defensive: GitHub-authored HTML such as headings/lists and encoded entities must never render as literal markup in the update dialog.
- `electron-updater` is loaded lazily only when packaged Windows initializes native updates. Never use its nonexistent default export, and keep updater initialization failure non-fatal so the dashboard can fall back to manual release checks. Desktop startup/updater/renderer failures are written under `userData/logs/desktop.log`.
- Windows auto-update releases require all three matching artifacts: the NSIS `.exe`, its `.exe.blockmap`, and `latest.yml`. The metadata names/version/hash must match the final installer. A client older than the first updater-capable release still needs one manual upgrade.

## File map

| Path | Responsibility |
| --- | --- |
| `src/types.ts` | Shared domain, state, option, and report contracts. |
| `src/atomic-file.ts` | Recoverable same-directory atomic JSON/text writes, Windows rename retry, newest-parseable recovery, and authoritative decode/schema validation. |
| `src/api.ts` | Adapter over pinned `@neteasecloudmusicapienhanced/api`; timeout, effective-status/error normalization, strict comment-page validation, and de-duplicated song detail calls. |
| `src/auth.ts` | QR login polling and private cookie persistence. |
| `src/governor.ts`, `src/errors.ts` | Start spacing, budgets, retries, sticky required-work cooldown/cancel signals, and non-latching best-effort execution for optional work. |
| `src/proxy-transport-gate.ts` | Task-wide proxy first-hop AIMD concurrency/start smoothing plus required and best-effort Governor wrappers. |
| `src/comment-rate.ts` | Bounded rolling rate of comments returned by successful page requests. |
| `src/proxy-lane-selection.ts` | Pure auto/manual task-lane subset selection and observable selection metadata. |
| `src/lane-recovery.ts` | Per-lane failure count/backoff, success reset, and cancellable default timer. |
| `src/scanner.ts`, `src/state.ts` | User-source/history scans, pooled workers, checkpoints/coverage, and task-local optional-metadata lane rotation. |
| `src/parallel-scanner.ts` | Cursor time shards, adaptive splitting, lane failover, parallel checkpoints. |
| `src/song-metadata.ts` | Indexed candidate-reference lookup and bounded batch hydration of missing song names/artists while preserving candidate order. |
| `src/time-shards.ts` | Shared half-open time-shard creation and adaptive split state transitions. |
| `src/clash-profile-merge.ts` | Pure multi-profile validation, fair candidate ordering, de-duplication, and conflict naming. |
| `src/progress.ts` | Comment-total reconciliation and split-stable parallel time coverage. |
| `src/work-queue.ts` | Waitable, requeueable FIFO work queue, amortized O(1) head removal/compaction, and completion detection. |
| `src/cursor-pagination.ts` | Shared strict descending-cursor validation. |
| `src/task-coordinator.ts` | Global source/parallel/pool lease and frozen elapsed-time calculation. |
| `src/task-log.ts` | Serialized per-run structured JSONL diagnostics and reads. |
| `src/jsonl-tail.ts` | Bounded reverse-block reads for newest JSONL rows. |
| `src/results.ts` | Serialized JSONL append, de-duplication, NetEase comment URL. |
| `src/mihomo-pool.ts` | Clash discovery, managed Mihomo, external pools, egress verification. |
| `src/estimate.ts` | Pure throughput/duration estimator. |
| `src/server.ts` | Loopback HTTP API, coordinated job/auth/pool managers, callback-fed live snapshots/active-song aggregation, resume descriptors, logs, SSE, validation, static files. |
| `src/cli.ts` | `auth-qr`, `scan`, `scan-song`, `proxy-pool`, and `web` commands. |
| `src/update.ts` | GitHub release check and manual asset selection. |
| `src/windows-updater.ts` | Native Windows update controller/state machine. |
| `src/electron-main.ts`, `src/electron-preload.ts`, `src/window-shell.ts` | Desktop host and isolated renderer bridge. |
| `web/index.html` | Accessible controls/dialog structure; no inline scripts/styles because of CSP. |
| `web/app.js` | Navigation/drawer/tab state, versioned async view switching, polling/SSE result ownership, topology estimates, and native update UX. |
| `web/styles.css` | Sticky/fixed 16 px-root workspace surfaces, activity tables, integrated scrollbars, responsive layout, and reduced-motion handling. |
| `test/` | Node test-runner coverage by source module; upstream and network behavior are stubbed. |
| `build/` | Icons and electron-builder macOS metadata hook. |
| `scripts/build-mac.cjs` | Builds ad-hoc-signed, non-notarized DMGs in a temp directory, then copies artifacts to `release/`. |
| `.github/workflows/windows-package.yml` | Manual validation workflow: runs tests and packaged smoke, builds NSIS assets, and uploads a short-lived Actions artifact; release publication is a separate explicit step. |

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
- User-source and single-song paths both use descending `comment_new` cursors and shared half-open shard math, but retain different state/report/source-discovery lifecycles. Source comment pages default to 1000 and accept 1..2000; pooled source pre-shards unfinished ranges at startup to fill available transport capacity, then adaptively splits further when Workers become idle.
- The GUI defaults to continuous scanning (`requestBudget=0`, no stop-after-first); CLI `scan` retains its finite per-run default and resumes from JSON checkpoints. `403/429`, explicit truncation, partial source failure, and operator stop affect status/coverage exactly as documented in this memory.
- Pooled scheduling is page-granular; both source and parallel modes adaptively bisect unread ranges when Workers are waiting. Structured events distinguish ordinary failures, explicit rate limits, and scheduler splits.
- The dashboard shows one global progress bar: source counts completed songs and parallel uses cursor-weighted time coverage. A dedicated central "parallel songs" table lists distinct songs currently in flight with Worker counts; it is activity, not completion authority. Comment totals remain optional API data. The runtime timer freezes at the terminal elapsed value, while the live speed metric is the server's rolling count of comments actually returned by successful pages and returns to zero at task end.
- There is no database. Results are de-duplicated JSONL and durable state is atomic JSON. CLI/web defaults use repository-local `.ncm/` and `data/`; packaged Electron uses its `userData` directory.
- Cross-version GUI recovery uses both `data/resume-task.json` (form parameters only) and the mode-specific scan checkpoint (progress). Restore does not auto-start and must leave `fresh` disabled. Windows installation stops the active scan, waits for terminal status/final checkpoint, and aborts on timeout before calling the updater.
- An old offset checkpoint is migrated by rescanning only unfinished/truncated songs from its immutable creation-time cursor. Changing cursor page size requires a fresh state, while existing JSONL still de-duplicates IDs.
- A lane is a verified proxy endpoint/egress; per-IP Workers share one Governor. Proxy-backed lanes share an adaptive task gate whose configured ceiling is `hostConcurrency`: clustered transient failures halve effective concurrency and increase aggregate start spacing, then stable success restores capacity gradually. Ordinary final failures still requeue/back off and use invocation-local lane recovery. This never deletes a lane from the managed pool. Managed/external pools are verified against both public egress IP and NetEase, isolated by IPv4 `/24` or IPv6 `/48`, configurable from the dashboard (current defaults 8 exits from 48 candidates), and rechecked in non-overlapping background rounds. `maxProxyLanes=0` uses all ordered verified exits; a positive value caps the task subset without changing pool capacity, while the host gate still limits simultaneous proxy transport.
- Liked-song IDs and old unnamed source checkpoints are hydrated through best-effort batched backend song-detail calls (maximum 500 IDs per batch). Candidate order and successful earlier batches are preserved/checkpointed even if a later metadata batch fails. Pooled batches rotate across healthy metadata lanes and locally skip a lane after its optional `403/429`, without latching or blocking that lane for required comments. Current/result displays never launch per-row lookup requests. Live results are job-scoped and never re-sorted by the comment's historical publish time.
- Proxy credentials, cookies, QR data, state, and results are local sensitive runtime data and never release assets. The application is a loopback-local dashboard; routine tests do not exercise high-volume real traffic.
- Forecast speed is an estimate based on page size, configured concurrency/spacing, lanes, and latency; it does not predict AIMD. “当前读取速度” is instead a rolling measurement of comments returned by successful pages. Neither is a completion guarantee, and cooldowns, discovery, retries, or empty pages can make either differ from long-run throughput.
- Windows packaged clients support in-app updates only from updater-capable versions onward and a valid Release needs `.exe`, `.exe.blockmap`, and `latest.yml`. Web/macOS use the manual-release path; public macOS distribution still needs proper Developer ID signing/notarization beyond the local ad-hoc build.
- Source requires Node.js 20+ and keeps `@neteasecloudmusicapienhanced/api` pinned. The documented check/test/build commands and Windows package-validation workflow are release gates.
- Concrete version numbers, filenames, tags, download links, and "latest release" statements must match `package.json` and live GitHub state at publication time; prefer version-neutral instructions in long-lived prose.

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

Final verification for the structural-review fixes is 45/45 in the latest scanner/server focused suite and 164/164 in the full suite, with `npm run build` and `npm run desktop:smoke:mac` also passing.

For topology/metadata/performance changes, focused evidence must cover lane selection, metadata/cooldown isolation, activity/checkpoints, FIFO behavior, clustered-failure recovery, listener deadline, and atomic schema rejection. Malformed-comment tests must reject truncated/incomplete pages, an unnormalizable row, and a non-descending cursor; scanner tests must show invalid cursors emit `start` then `failure`, never `success`. AIMD tests cover 18-to-9 reduction, interval scaling, paced recovery, and an 18-request transient-failure burst; rate tests cover rolling calculation, decay, and reset; source concurrency tests must not cap 18 configured Workers/songs at an old UI constant. Server asset assertions prove only progress/topology/LED wiring and idle zero. In a real browser, verify de-duplicated song rows, active/configured Worker copy, topology warnings, LED/disabled pool control, speed, focus/ARIA, and responsive layout.

## Release checklist

1. Before the next release, choose its semantic version and set the same value in `package.json` and `package-lock.json`. Update README statements that name a concrete artifact/version; source changes alone do not mean the release exists.
2. Run the full verification above and build platform artifacts from the final source/version.
3. For Windows, dispatch `Windows package validation`, require its packaged-app smoke test to pass, and use its uploaded Actions artifact. Inspect `latest.yml` and ensure its version/path/size/SHA-512 match the final `.exe`, and that the matching `.exe.blockmap` exists. Do not rename one without regenerating metadata.
4. Commit/push the source, create tag `vX.Y.Z` on that exact commit, and publish a **stable** GitHub Release with the platform assets. The repository configured in `package.json` and `src/update.ts` is `RocXOvO/ncm-comment-finder`.
5. Verify the public Release assets and hashes after upload, and confirm the latest stable Release points to the intended version. `release/` is non-authoritative and may contain historical artifacts; upload only exact current-version files from a clean staging set, never a wildcard over that directory. Do not mark a broken build as latest; preserve an explicit upgrade path for users whose updater cannot start.

Local verification, the Windows workflow, and post-upload checks are all release gates; one does not replace the others.

## Common traps

- Editing only the estimator/UI can make a concurrency number look changed while execution still uses an old/default worker count. Trace and test the full topology path.
- Changing the managed pool's build size is not the same as choosing a smaller lane subset for one scan. Do not rebuild or destructively shrink the shared pool merely to honor `maxProxyLanes`; `0` means automatic use of all verified exits, while only a positive value caps one task's subset.
- `likelist` returns IDs without song titles. Do not render those IDs as if they were names, and do not fix the display with repeated renderer-side `/api/song` calls; hydrate/cache metadata in the backend and preserve the ID fallback when lookup genuinely fails.
- Best-effort metadata isolation is deliberately narrow. Letting required comment/source calls use `executeBestEffort` would hide real rate limits; letting optional metadata use ordinary `execute` would let a title lookup's `403/429` cancel otherwise valid comment coverage.
- The metadata session's `cooldownLanes` is disposable enrichment state, not scan health. Sharing it with the pooled scanner's `blockedLanes` would incorrectly turn a failed title lookup into lost comment coverage; omitting it would repeatedly hit a known-cooled metadata lane on every 500-ID batch.
- Source scan and `scan-song` both use `comment_new` time cursors, but they retain different scheduling, state, defaults, and privacy/login behavior. `comment_music` is legacy compatibility only: endpoint evidence showed `limit=100` returned 100 records while 200/500/1000 returned only 20, which is why old offset pagination must not be extended for large pages.
- Multiple workers share one governor per lane. Giving every worker its own governor would accidentally multiply the per-IP start rate.
- Per-IP Governors and the task-wide proxy gate protect different boundaries. Do not remove either, place the gate outside Governor delay/backoff, or present configured Workers/`hostConcurrency` as guaranteed live capacity: AIMD may temporarily lower `proxyTransportEffectiveConcurrent` and increase start spacing.
- A normal network failure is recoverable lane work, not permanent pool removal. Requeue unfinished work exactly once and mark the invocation-local lane unavailable at five consecutive final failures, but wait for its other active requests before stopping the task: a late success revives the lane, clears the count/unavailable mark, and wakes obsolete recovery waits. Check cooldown/unavailable state before waiting, after recovery, and again after `queue.take()` so a retired lane cannot start new remote work. Use the scanner's single queue-closure listener to cancel recovery waits; do not attach repeated `Promise.race` reactions in the Worker loop.
- Pool entry count is not proof of independent capacity; only verified distinct egress IPs count as lanes.
- Source `both` may finish with partial coverage when one source is restricted. Keep `sourceErrors` and coverage semantics visible.
- A finished checkpoint returns immediately. When testing a changed configuration, use a fresh temp state path; do not silently mutate compatibility fields in old state.
- The resume descriptor only restores UI parameters; the checkpoint remains authoritative. Do not mark a restored task `fresh`, auto-start it, store secrets in the descriptor, or silently coerce an incompatible checkpoint.
- Dynamic parallel splits make `state.shards.length` larger than the configured `shardCount`. Status/settlement must report the actual array, while compatibility still compares the original configured count.
- The global progress bar and `activeSongs` list are presentation, not completion authority. Concurrent activity can change on every request, API comment totals can change, and parallel shard counts grow after a split; preserve checkpoint completion, monotonic total reconciliation, and time-coverage math rather than forcing UI state into durable scan semantics.
- Concurrent dashboard refresh triggers are normal. Keep the single-flight guard before the combined fetch so they share one request rather than creating stale responses or extra server load.
- Do not reintroduce interval-driven overlapping fetches, per-match whole-table rendering, decorative perpetual pool-row rotation, or full managed-process identity checks in `/api/pool`; these previously caused visible Electron stutter, especially from repeated PowerShell startup on Windows.
- A logger callback is observability only. Never branch scan correctness on successful logging, and never expose a caller-supplied log path through the HTTP API.
- Runtime paths differ: source/CLI defaults use the project root; packaged Electron uses `userData`. Never hardcode repository runtime paths in desktop code.
- `dist/` is generated from `src/` and ignored. Edit TypeScript sources, not compiled JavaScript.
- GitHub's generic latest-release check and native Windows `electron-updater` are separate paths. Test both when changing update UX. In particular, verify HTML release notes become plain text in the native updater state, not merely in a browser-only view.
- A source page-size control in the UI or estimate is not evidence that source scanning safely uses it. Trace the setting through CLI/UI, server, scanner, `comment_new` cursor update, state compatibility, and the legacy-checkpoint `createdAt` rescan path.

## Maintaining this memory

After every code-modification pass, recalibrate this file in the same commit against the resulting code and tests. Replace or delete stale facts instead of appending a changelog; record durable ownership, contracts, invariants, and verification routes rather than incidental implementation history. Keep `README.md` synchronized when user-visible behavior changes, and remove redundant memory so this file remains a compact navigation aid.

## Workspace GUI direction

The `codex/ui-v0.13-scroll-concurrency` branch is the active user-requested UI/concurrency iteration, kept in its own worktree so unrelated conversations cannot overwrite it. Preserve these characteristics until review and release verification.

- Treat the dashboard as one operational surface, not separate routes. The desktop topbar and 58 px icon rail are sticky; the initially closed task drawer is fixed to the viewport (up to 336 px), so all controls remain reachable after document scrolling and Settings scrolls inside the drawer rather than to an old document coordinate.
- Search, Settings, and Pool are toggle entries: repeating the active open entry collapses its drawer/inspector. The toolbar drawer and inspector buttons do the same. Starting a task and every central output tab (`results`, `activity`, `logs`, `pool`, `estimate`, including already-active/programmatic paths) closes the task drawer. State changes synchronize titles plus `aria-current`/`aria-expanded`/`aria-hidden`/`aria-controls`; hidden-drawer focus moves to the toolbar button.
- The top task bar owns target/mode, `hostConcurrency` (1..32), task exit upper bound (`0` automatic = all verified exits), topology text, and start/stop. Topology copy distinguishes selected/available exits, configured Workers, host ceiling, and live AIMD downshift; when Workers are fewer than the ceiling, show that exits or per-IP concurrency—not a larger ceiling alone—are needed to fill it.
- The center owns total progress, six compact metrics, and output tabs. `commentsPerSecond` renders as “当前读取速度” for both modes. The `activity` table de-duplicates active songs by ID, shows per-song read progress, and separately reports summed active versus configured Workers; it must not imply that song count equals concurrency. Neither speed/activity UI nor result rows determine durable completion.
- Output tabs use `aria-controls`/`aria-labelledby`, one roving `tabindex=0`, and Left/Right/Home/End keyboard activation. One `tabSwitchVersion` owns animated, already-active, and programmatic paths; stale transitions must converge through `syncTaskTabVisibility()` so exactly the active panel remains visible.
- Clash configuration lists discovered profiles with one select-all/cancel-all action; the synthetic merged/current choice is gone. An explicit selection `Set` preserves intentional empty selection across refreshes, discovery loss clears stale checkbox DOM, and the discovered default config appears only when no profile list exists. On first render of a running pool, initialize selection from its active profile-path subset instead of all discovered profiles. Disable selection while the pool is active.
- The pool header is an accessible live status with one small LED: offline, building, background-checking, ready, degraded/recheck-pending, or build-error. Its state follows the accepted mutation response and authoritative `status`/`refreshing`/`refreshError`; `poolMutationVersion` prevents stale polls from overwriting a mutation. While `refreshing`, disable pool start/stop and scan starts so a background recheck cannot overlap a mutation/task. Green “ready” means the returned pool is running, not that later upstream requests cannot fail.
- Mode switching immediately clears old result/log presentation and reconnects the mode-scoped SSE stream. Result APIs carry `jobId`, so a new job generation clears the previous task's rows; accepted snapshots merge behind SSE items received during that request and ahead of retained older items. Result/log request generations suppress stale data and errors without toasts. Mode/pool-source animations, task-start responses, and pool status mutations have version ownership so old work cannot overwrite the current view/state.
- On desktop the proxy inspector is sticky beneath the header; at `<=1120px` it becomes a collapsible fixed overlay. The toolbar context remains visible and wraps through the 900..1120 px range. At `<=820px`, the sticky rail becomes a six-item top row while drawer/inspector stay viewport overlays. Current cache-busters are `styles.css?v=31` and `app.js?v=33`; bump the affected asset token on every change.
- User-triggered drawer/mode/pool transitions use short transform/opacity motion; only the tiny building/checking LED may pulse during polled activity. Never animate dense live lists, and honor `prefers-reduced-motion` for every animation.
- Keep neutral surfaces, one accent, thin borders, moderate radii, 16 px root type, integrated scrollbars, single-flight polling, snapshot signatures, bounded/batched results, and log throttling. Renderer refactors must preserve distinct scanner/checkpoint semantics, CSP/static routes, accessible focus/state, and low-cost rendering.
