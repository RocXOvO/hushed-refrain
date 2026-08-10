# Project memory for AI agents

This is the compact, durable map for `ncm-comment-finder`. It records current contracts, not development history. Read it before editing and replace stale facts instead of appending a changelog.

## Current baseline and authorities

- Current release line: `v1.1.7`. `package.json` and root `package-lock.json` are the version authorities; GitHub Release/tag/assets must still be checked separately when publication state matters.
- Display brand: `乐评寻踪 / MUSIC COMMENT TRACE`; `productName=乐评寻踪`.
- Stable technical identity: package `ncm-comment-finder`, appId `cn.local.ncm.commentfinder`, repository `RocXOvO/ncm-comment-finder`, artifact stem `NCM-Comment-Finder`, Electron data directory `appData/ncm-comment-finder`. Do not change these as part of a visual rename.
- Current web cache-busters are `styles.css?v=64`, `platform-wave.js?v=15`, `pointer-silk-trail.js?v=6`, and `app.js?v=75`; keep them synchronized with `web/index.html`.
- Current unresolved findings and acceptance boundaries live in `docs/code-audit.md`. Detailed QQ truth lives in `docs/qq-music-architecture.md`; QQ performance in `docs/qq-music-performance-review.md`; GUI/search/transition truth in `docs/platform-gui-architecture.md`. `docs/qq-music-integration-design.md` is historical only.

## Product and runtime shapes

The application locates public comments authored by a target user on NetEase Cloud Music or QQ Music.

- NetEase matches a numeric UID exactly.
- QQ resolves a numeric QQ, official profile URL, or opaque EncryptUin to a canonical EncryptUin and matches the complete opaque author value.
- Runtime shapes are the NetEase CLI (`src/cli.ts`), QQ CLI (`src/qq-cli.ts`), loopback web dashboard (`src/server.ts`), and Electron desktop (`src/electron-main.ts`).
- Keep the dashboard on `127.0.0.1`. The server does not yet enforce a complete remote-mode Host/Origin/CSRF boundary.
- Packaged runtime data is under stable Electron `userData`; source CLI/web defaults use repository-local `.ncm/` and `data/`.
- There is no database. Checkpoints are JSON and results/logs are JSONL. Generated/runtime `dist/`, `release/`, `.ncm/`, `data/`, and `tmp/` are ignored and must not be committed.
- The dashboard has four independent view keys: `netease:parallel`, `netease:source`, `qq:song`, and `qq:likes`. Jobs, generations, results, SSE, logs, estimates, settlements, selected mode, and output tabs must remain keyed by the complete view.

## Scan engines and ownership

The three engines share infrastructure, not pagination or state semantics.

### NetEase user-source scan

Entry points: `scan`, `/api/job`, `runPooledCommentFinder`.

- `source` is `record | likes | playlists | both | all`: `both` remains rank + liked songs, while `all` adds the target UID's owned public non-liked playlists. `recordScope` is `all | week | both`; dual scope retains distinct `record` and `record-week` evidence.
- Never use `likelist` for another user. Page `user_playlist(uid)`, accept a playlist only when `creator.userId` explicitly equals the target UID, split owned `specialType=5` into likes, and ignore subscriptions or entries with absent/mismatched owner evidence. Revalidate the owner on every `playlist_detail`; a requested UID is never an evidence-free alias for a playlist creator.
- Liked and ordinary playlist catalogs are strict: `trackIds` must be an explicit array of valid, unique positive-decimal IDs. A present list/detail `trackCount` must be a non-negative integer; null/empty is unknown, not zero. The two declarations are separate snapshots and need not agree, but each may trail the validated ID vector by at most one song. Fewer IDs than either declaration proves truncation; a declaration lag over one, a duplicate/invalid ID, a missing vector, an owner mismatch, a duplicate/nonadvancing list page, or `more=true` with no entries is a source error and is not checkpointed as complete.
- Merge all successful selected catalogs by song ID and scan one copy. Preserve the union in `sources[]` and per-source rank/play-count/score evidence in `memberships[]`; legacy state without memberships is synthesized during reconciliation. A failed record scope or playlist detail may retain other successful sources plus a source error, but an independently selected source that wholly fails must fail the scan.
- Page `comment_new` with a strictly descending time cursor, default page size 1000, accepted range 1..2000. A `hasMore` page must advance; an empty advancing page is valid.
- Only the unsharded newest-page chain may start with `pageNo=1`. Every newly created, resumed-capacity, or adaptively split explicit-cursor time shard starts a fresh non-first-page chain at `pageNo=2`; never inherit `1` or an unrelated predecessor page number.
- Work is page-granular and fairly requeued. Pooled scans pre-shard unfinished song ranges to available Worker/transport capacity, then adaptively split unread half-open ranges when Workers wait.
- Per-song completion and UI progress are owned by durable half-open time coverage, not the upstream live `totalComments` count. Each song persists its immutable `commentEndTime`, so a catalog song added to an older checkpoint cannot inherit the task's stale creation-time bound. A naturally completed row stays visible as `已完成`/100% while the task still runs (subject to the bounded activity list) instead of disappearing at a stale read/total ratio. A configured per-song page cap is a distinct `truncated` terminal state and must say `达到页数上限`; it must never be promoted to 100% coverage.
- `pageInSong` and `maxCommentPagesPerSong` are aggregate across a song's cursor and all shards. In-flight permits count toward the cap; failed requests release their permit. Natural completion wins over truncation on the last allowed page.
- A normal start refreshes and reconciles the selected catalog by song ID. Preserve prior cursor/shard progress, retain removed historical entries, and scan only genuinely new IDs. `--fresh` bypasses checkpoint/coverage reuse but does not clear canonical results.

### NetEase single-song parallel scan

Entry points: `scan-song`, `/api/parallel/job`, `runParallelSongScan`.

- Split `[startTime,endTime)` into non-overlapping half-open time shards and paginate each with descending `comment_new` cursors, without a login cookie.
- Fresh physical shard count is bounded by configured `shardCount`, actual Worker loops, and current transport capacity. The configured count remains the compatibility key; persisted/adaptive physical shard arrays are authoritative on resume.
- Adaptive splitting bisects only unread ranges and must never duplicate or skip coverage. Filter returned comments to the shard interval; JSONL de-duplication is a final idempotency guard, not a substitute for correct range math.
- Progress is cursor-weighted time coverage, not `completedShards / shards` and not a comment-density estimate.

### QQ SeqNo scan

Entry points: `/api/qq/job`, `runQQMusicScan`; modes are `song` and `likes`.

- QQ state, results, pagination, transport gate, and writer are independent of NetEase time cursors and target-v3 storage.
- Song IDs and SeqNo values stay decimal strings; never convert them through JavaScript `Number`. The requested song ID remains the task primary key even when metadata supplies a MID or another response ID.
- Comment pages are 1..25 (default 25); public-liked discovery pages are 1..500 (default 500).
- The raw final normalized row is the next SeqNo cursor. Equal/local disorder inside a page is retained, but every resumed-page row must be older than the requested cursor. An unsafe page leaves that song unadvanced while other liked songs may continue.
- `song` always has one in-flight SeqNo chain. `likes` parallelizes different songs only.
- QQ results de-duplicate by `(songId,commentId)`. The writer completes `write + fsync` before match publication and state ownership; cancellation is checked again before cursor/checkpoint commit.
- One logical comment page is passed to `appendBatch`, which de-duplicates its composite keys and persists the page with one write and one fsync before publication. Both modes checkpoint after 400 ms or 4 dirty pages; likes Workers await every revision to keep the checkpoint-slot bound hard, while the serial song chain may replay at most four already-durable JSONL pages after a crash. Final, stop, cooldown, and failure paths force the outstanding flush.
- `QQJobManager` caches exact metadata returned by lookup/search (bounded to 32 entries). Song scans consume it only when its ID exactly equals `requestedSongId`; Scanner never performs an optional metadata request and never replaces the requested decimal-string primary key.
- Canonical identity and presentation are separate. Numeric and reversible classic QQ forms may display full `QQ <number>`; a reversible 28-character WeChat-login token displays only `微信用户`; accepted opaque targets display `EncryptUin <value>`. The user-visible default PDF filename deliberately includes the complete canonical UID/EncryptUin; logs, errors, diagnostics, fixtures, and release examples stay redacted/synthetic.

## Lookup and proxy boundary

- Ordinary dashboard lookups are low-frequency control traffic and always use a bounded local direct Lane: NetEase `/api/user`, `/api/user/profile`, `/api/song`, `/api/song/search`; QQ `/api/qq/user`, `/api/qq/song`, `/api/qq/song/search`, numeric canonical resolution, verification, and optional nickname/avatar enrichment.
- These routes ignore the running pool, manual-proxy fields, and forged proxy query inputs. QQ ordinary queries use a 4-second bound; NetEase UID preview overlaps profile, record, likes, and a shared first playlist page through one 100 ms Governor with two-second per-request bounds. Only confirmed liked-playlist privacy renders `已开启隐私`; an inconclusive ordinary preflight failure renders `暂时无法确认`, and cooldown remains separate.
- Opaque QQ canonical targets remain local. `微信用户` performs no profile enrichment and keeps fixed metadata/default avatar.
- Only formal high-volume comment/source pagination consumes the configured pool/static proxy. When a proxy path is selected it is fail-closed and never silently falls back to direct.
- Dashboard parallel requires a running verified pool. Source requires a verified pool, explicit static proxy, or explicit `allowDirect`. The shared pool proves egress and NetEase reachability, not QQ-domain reachability.
- UI button disabling is convenience only; server validation and `TaskCoordinator` leases are the in-process authority.

## Concurrency, rate control, and cancellation

- A Lane is one client/proxy endpoint plus one Lane-owned `RequestGovernor`. All requests using that exit share its literal `minDelayMs + jitter` start-slot schedule; Worker count never divides that interval.
- NetEase `workersPerLane` is a per-exit permit bound. Actual Worker loops are `min(lanes * workersPerLane, hostConcurrency)`; `hostConcurrency` is 1..32, default 8.
- QQ `song` has one Worker. QQ `likes` uses `hostConcurrency` Workers and derives `workersPerLane = ceil(hostConcurrency / selectedLanes)`.
- All page Workers acquire a Lane from one fair round-robin `LaneAllocator`; a host cap must not be implemented by slicing away selected exits.
- Proxy-backed tasks also share one task transport gate. Healthy aggregate starts are separated by at least 50 ms, a real ceiling of about 20 starts/second before per-Lane/network limits. For QQ, a request first acquires Gate capacity and its aggregate start gap, then reserves the selected Lane Governor slot at the actual remote-start boundary; retries use the same path. NetEase AIMD halves effective transport capacity after clustered transient failures and gradually restores it; it does not destroy Worker loops.
- Pool build/import/verify/refresh uses a separate 4-request/80-ms gate.
- Final ordinary Lane failures requeue unchanged work and enter cancellable exponential recovery. Five consecutive final failures mark that invocation's Lane unavailable; a late in-flight success may revive it. Do not declare exhaustion while a request can still restore a Lane.
- Each Manager owns an `AbortController`. Stop closes queues, aborts Governors/gates, cancels LaneRecovery and allocator/checkpoint waiters, prevents new remote starts, then forces the final checkpoint before releasing the lease.
- Request budgets count logical comment pages, not every source/control request or retry attempt. GUI `0` means unlimited.

## State, persistence, generations, and presentation

- `src/atomic-file.ts` owns unique same-directory temporary files, fsync, bounded Windows rename retry, and newest-complete recovery. Once a JSON candidate parses, schema/decode failure is authoritative and must not fall back to older state.
- NetEase source state is version 3 with `commentPagination:"cursor-v1"`, page-size compatibility, per-song cursors/shards, source catalog version 3, totals, cooldown, truncation, and coverage. Dashboard paths are target-v3 per UID/source; sources share only the canonical per-UID JSONL and coverage ledger.
- Scoped record paths include non-default `recordScope`. The one legacy weekly checkpoint that occupied an all-time path is migrated under a shared file lock: accept only exact UID/source/week identity, atomically establish or preserve the matching scoped target, reread it for durable verification, then remove only the conflicting legacy document and its owned recovery files. Identity conflict leaves the legacy file intact and fails safely.
- Parallel state is version 1 and binds immutable range/configured-shard/page-size identity. Adaptive child shards are persisted and resumed.
- QQ state is version 1, `kind:"qq-comment-scan"`, `commentPagination:"seqno-v1"`, in `data/qq/`; its result writer has the stronger current fsync/repair ordering.
- `data/resume-task.json` is an atomically written private version-3 form descriptor with `requestIntervalSemantics:"per-start-v1"`. It never replaces checkpoint compatibility, stores no credentials, restores with `fresh=false`, and never auto-starts.
- Generation-bound REST/SSE/log/report reads must validate platform, mode, UUID, canonical target, and owned paths before and after asynchronous reads. UI snapshots/progress are presentation, never completion authority. NetEase source reports expose `catalogLoaded` from durable `sourcesLoaded`: `false` with zero means the catalog has not been read and its size is unknown; only `true` with zero is a confirmed empty catalog.
- The NetEase source selector owns one geometry-driven sliding highlight. Switching to `likes` or `playlists` collapses the record-scope region through a reversible CSS grid transition while semantic `aria-hidden`/`inert` state changes immediately; rapid reversal, resize, BFCache, platform switching, and reduced-motion must converge without queued animations or layout jumps.
- `web/pointer-silk-trail.js` is optional presentation only: `PointerSilkTrail.create({host,platform,enabled})` owns one lazy WebGL2 surface inside `#mainWorkspace`, accepts fine mouse input only, and exposes `setEnabled`, `setPlatform`, reason-based `suspend`/`resume`, and `destroy`. Its MIT-attributed Makio Follow dynamics use four independent 20-point chains with deterministic samples spanning the reference ranges; increasing springs pair with decreasing friction to avoid high-spring/high-momentum resonance, each frame propagates points 19→1 from prior-frame predecessors before updating the head, and head lag has a 32 px soft cap. For 100 px circular input over 240 frames at 0.18, 0.20, 0.215, and 0.265 rad/frame, every point on all four lines must remain within a 160 px envelope. World-space width and offsets project into CSS pixels, capped at 22 px and 26 px respectively; material opacity is 0.76. One preallocated upload feeds four anti-aliased `TRIANGLE_STRIP` draws, with no textures, FBOs, randomness, blur, post-processing, or business-DOM capture. All RAF stops after the 72+348=420 ms idle tail; DPR stays at or below 1.25 and the color buffer at or below 800,000 pixels. Dialogs, platform transitions, hidden/blur/pagehide and reduced motion clear or release it; BFCache restore rebuilds it. Desktop settings v2 persist `cursorTrailEnabled` (default true), migrate v1 without losing `closeBehavior`, and accept partial updates; browser mode is session-only and never uses localStorage or a preferences API.
- Match/logger/UI callbacks are best effort. They must not alter scheduling, results, checkpoint advancement, coverage, or task terminal status.
- Current NetEase result durability is an unresolved P1: `src/results.ts` still uses append-only writes without the QQ writer's fsync/tail-repair contract. Do not describe NetEase result/checkpoint durability as solved.

## Proxy pool and desktop safety

- `src/mihomo-pool.ts` supports managed Clash Verge generations and external HTTP/HTTPS proxies. Only loopback listeners are generated; credentials and controller secrets remain private and masked from APIs/logs.
- Verification requires public egress plus a real NetEase comment probe. Select one fastest entry per IPv4 `/24` or IPv6 `/48`; only distinct verified egresses are scan Lanes.
- Managed replacement is new-before-old and descriptor-atomic. Killing/stopping a PID requires full executable plus exact generation-config identity. The frequent `/api/pool` status poll uses cheap liveness only and is not connectivity proof; task start re-verifies.
- Default pool sizing is 8 selected exits from 48 candidates. `maxProxyLanes=0` selects all verified exits for one task; a positive value caps only that task and never shrinks the shared pool.
- When Inspector is collapsed, pool `starting` or background `refreshing` has one explicit global notice that opens the pool view. It must reserve the collapsed Inspector rail/peek area at desktop, overlay, and narrow breakpoints rather than covering the right-side control. A stable building/refreshing/hidden signature prevents repeated live-region writes or replayed arrival animation during polling; expanded Inspector keeps the notice hidden.
- Electron keeps `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, a narrow preload bridge, and a single-instance lock. Single-instance UX does not protect CLI/Web processes from sharing a logical scan root; that cross-process lease remains open audit work.
- Main-window close requests use the renderer-owned `closeAppDialog`, not a native OS message box. A validated main-window-only IPC decision returns `cancel`, `background`, or `exit`; stale/duplicate decisions are ignored. Remembering a choice updates only `closeBehavior`. Exit keeps the dialog visible with checkpoint-safe progress while the existing bounded graceful-quit path stops the active task and waits for the final checkpoint; an unavailable renderer cancels the close instead of guessing.
- Windows update installation first blocks new work, stops the real globally active task, waits up to 45 seconds for terminal status/final checkpoint, and installs only after QQ lookup/pool barriers settle. Timeout or stop/status failure cancels installation.
- Native Windows auto-update needs one matching `.exe`, `.exe.blockmap`, and `latest.yml`. Generic GitHub update checking and `electron-updater` are separate paths.
- Desktop PDF export reports a monotonic cumulative `elapsedMs` from the start of export, including save-dialog time; stage-to-stage deltas may be derived but are not stored as independent durations. `resultReportFilename` uses the complete canonical target as intentional user-visible output, then `sanitizeWindowsPdfFilename` replaces Windows-forbidden/control characters, removes trailing dots/spaces, avoids reserved device stems, caps the stem at 180 characters, and fixes the extension to `.pdf`. Filename regressions must cover both platforms, exact target visibility, forbidden/control characters, trailing dots/spaces, reserved device names, length, and extension. Packaged smoke must traverse renderer `window.ncmDesktop` → preload → IPC → hidden Chromium load/fonts/print → atomic write and observe `save-dialog, load-report, fonts, print, write, saved`, then verify the selected path and `%PDF-` header.

## Key module index

- Scanners/state: `src/scanner.ts`, `src/parallel-scanner.ts`, `src/state.ts`, `src/time-shards.ts`, `src/qq-music/`.
- Scheduling: `src/governor.ts`, `src/proxy-transport-gate.ts`, `src/lane-allocator.ts`, `src/lane-recovery.ts`, `src/worker-topology.ts`, `src/work-queue.ts`.
- Durability/results: `src/atomic-file.ts`, `src/checkpoint-coordinator.ts`, `src/results.ts`, `src/result-accumulator.ts`, `src/song-coverage.ts`, `src/jsonl-snapshot.ts`.
- Application layer: `src/server.ts`, `src/qq-job-manager.ts`, `src/task-coordinator.ts`, `src/task-log.ts`.
- Pool/desktop/update: `src/mihomo-pool.ts`, `src/electron-main.ts`, `src/electron-preload.ts`, `src/windows-updater.ts`, `src/update.ts`.
- Renderer/report: `web/app.js`, `web/platform-wave.js`, `web/styles.css`, `src/result-report.ts`, `src/desktop-result-export.ts`.
- Tests mirror these modules under `test/`; do not edit generated `dist/`.

## Verification and release baseline

Node.js 20+ is required and `@neteasecloudmusicapienhanced/api` stays pinned exactly.

```bash
npm ci
npm run check
npm test
npm run build
npm run bench:qq
node --check web/app.js
node --check web/platform-wave.js
node --check web/pointer-silk-trail.js
npm run desktop:smoke:mac
git diff --check
```

- Before handoff, run at least check, test, build, and diff-check; add the focused tests for changed behavior. Desktop/preload/updater/build changes also require the relevant desktop smoke/package path. Tests currently lack a strict `check:test` TypeScript gate; do not treat transpile-only execution as type coverage.
- Routine tests use stubs and loopback services. Real NetEase/QQ/proxy traffic must be explicit, bounded, and never a default gate.
- The `v1.1.7` release baseline is 541/541 tests with check, build, benchmark, all three renderer syntax checks, macOS desktop smoke, and diff-check passing; real browser QA covered retained per-song completion rows and the collapsed-Inspector pool notice at 1440×900, 1280×800, 900×640, 821×700, 820×844, and 390×844 with positive right-side clearance, no new horizontal overflow, and zero console errors. GitHub publication still requires the exact commit/tag/assets checks below.
- Windows packaging is a manual `workflow_dispatch`: it checks/tests, builds unpacked and NSIS forms, runs packaged startup/PDF smoke, and uploads a seven-day Actions artifact. It does not publish a GitHub Release.
- Release from one exact final commit/version. Verify tag, `origin/main`, workflow `headSha`, manifests, and assets all agree. Validate `latest.yml` version/path/size/SHA-512 against the installer; build both macOS architectures from the same commit.
- Publish only exact current-version files from a clean staging set. Local `release/` is non-authoritative and may contain historical files.
- macOS DMGs are ad-hoc signed and not notarized. Windows currently has no Authenticode configuration and may trigger SmartScreen; updater SHA-512 metadata is not code signing.

## Current audit TODO

See `docs/code-audit.md` for acceptance details. Current high-priority open work includes:

- Align NetEase JSONL durability/tail repair and checkpoint commit ordering with the QQ writer.
- Add a cross-process logical-task lease for Electron/Web/CLI sharing the same state/output root.
- Stop rendering full `authorEncryptUin` in QQ real-time result rows.
- Enforce complete loopback/Host/Origin/Content-Type/CSRF boundaries before remote dashboard use.
- Bound QQ proxy response bodies, rotate logs, add private file modes where missing, and add strict test typechecking.
- Remove hot-path full-ledger rewrites, per-entry `appendFile`, and pathological whole-state checkpoint clone/write costs without weakening correctness.

## Maintaining this memory

After every code-modification pass, reread the final diff and update this file in the same change. Keep only current ownership, boundaries, invariants, performance limits, release/test gates, and open audit facts. Put detailed GUI, QQ-domain, benchmark, or historical design material in its named topic document and link it here instead of duplicating it.
