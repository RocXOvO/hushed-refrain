# Project memory for AI agents

This file is the durable architecture map for `ncm-comment-finder`. Read it before changing code. Keep it factual and compact; it describes the current system, not a changelog.

## Product and runtime shapes

The app finds NetEase Cloud Music comments authored by a numeric user UID. It has three entry shapes over the same TypeScript core:

- CLI: `src/cli.ts`, run with `npm run start -- <command>`.
- Local web dashboard: `src/server.ts` serves `web/` on `127.0.0.1`; run with `npm run web`.
- Electron desktop: `src/electron-main.ts` starts the dashboard on an ephemeral loopback port and loads it in a sandboxed window. Packaged runtime data lives under Electron's `app.getPath("userData")`, not the repository.

There is no database. Durable scan state is JSON; matches are append-only JSONL. Generated/runtime directories (`dist/`, `release/`, `.ncm/`, `data/`, `tmp/`) are ignored and must not be committed.

## Architecture and data flow

Two scan engines exist and must not be conflated:

1. User-source scan (`scan`, `/api/job`, `runPooledCommentFinder`)
   - Read candidate songs from listening rank (`user_record`), likes (`likelist`), or both.
   - Merge songs by ID while preserving record-first order and source metadata.
   - Page each song through `comment_music`, match `comment.user.userId` exactly, and write results.
   - `auto` in the CLI may select `user_comment_history` only when the logged-in account UID equals the target. The GUI deliberately uses `strategy: "scan"`.
   - With a verified pool, one lane is created per distinct egress IP and songs are distributed across lane workers.

2. Single-song parallel scan (`scan-song`, `/api/parallel/job`, `runParallelSongScan`)
   - Read the song metadata, split `[startTime, endTime)` into non-overlapping time shards, newest first, and paginate `comment_new` using descending cursors.
   - A worker owns one shard at a time. Failed/cooling lanes return unfinished shards to the shared queue for healthy lanes.
   - Cursor pages are filtered back to the shard's half-open range before UID matching. The endpoint is intentionally called without a login cookie.

Common result flow:

`EnhancedNcmClient` -> scanner -> `JsonlResultWriter` -> JSONL on disk -> optional `onMatch` callback -> server SSE -> `web/app.js` live table.

The writer serializes concurrent appends and de-duplicates by `commentId`, including IDs already on disk. SSE/UI failure must never interrupt persistence.

## Concurrency and rate-control invariants

- A lane is one client/proxy endpoint plus one `RequestGovernor`.
- `workersPerLane` (UI name: `workersPerProxy`, label: "each IP concurrency") is the number of async workers created for every lane. Total workers are `lanes * workersPerLane`.
- The governor serializes request **start slots** per lane using `ceil((minDelayMs + random jitter) / workersPerLane)`; requests already in flight may overlap. The configured per-IP concurrency therefore increases that lane's start rate while preserving one shared scheduler for the IP.
- UI topology settings must travel through the entire chain: form control -> `payload()` -> server input validation -> scanner options -> actual worker-array cardinality -> status/report. A speed-estimate-only change is not a runtime concurrency change. Add a test that observes overlapping requests when touching this chain.
- `estimateCommentScan` must model the same topology: per-lane cycle is `max(spacingMs, networkMs) / workersPerLane`, then divide pages across lanes. The dashboard estimate reads the currently selected mode's page size/delay/jitter/concurrency plus the active pool's verified lane count and average NetEase latency (source scan pages are fixed at 100; parallel pages are configurable).
- GUI request budget `0` means unlimited. Positive pooled budgets are enforced by the shared scanner scheduler; generous per-lane governor budgets prevent concurrent reservation races from silently lowering the configured aggregate budget. CLI `scan` uses the governor budget directly.
- Network/`5xx`/408/425 failures receive bounded exponential retry. `403` and `429` never loop-retry: they produce a persisted cooldown. Operator stop cancels governors before the next remote request.
- Do not use routine tests to create high real-world traffic. Unit/integration tests use stubs and loopback servers; real NetEase or proxy-pool checks must be explicit and low-risk.

## State, checkpoints, and coverage

- `src/state.ts` owns source-scan state version 1. State is written to a sibling `.tmp` and atomically renamed.
- Source state records UID, strategy/source/scope, candidates, per-song offsets/page counts, seen IDs, request/match totals, truncation, source errors, cooldown, and coverage.
- `src/parallel-scanner.ts` owns `kind: "parallel-song"`, version 1 state with immutable scan range/shard/page-size identity plus per-shard cursor and counters. Writes are coalesced to about 500 ms and forced at task end.
- Reusing state with a different UID/source/scope/strategy or parallel range/shard/page-size is rejected. Use `--fresh` or a new state path.
- `--fresh` ignores the checkpoint; it does not clear the JSONL output, which still de-duplicates existing comment IDs.
- `coverageComplete` is true only when all selected work finished without source failures or configured truncation. A task may have status `complete` while coverage remains incomplete.
- GUI tasks intentionally force `stopAfterFirst: false` so scanning continues until completion, cooldown, budget, failure, or manual stop.

## Proxy-pool design

`src/mihomo-pool.ts` supports two pool sources:

- Clash Verge: discover its merged config/profile YAML and `verge-mihomo`, choose region-diverse candidates, generate one loopback mixed listener per node, start a detached dedicated Mihomo process, then verify it.
- External: normalize supplied HTTP/HTTPS proxy URLs and verify them directly; no managed PID is required.

Verification has two gates: query the public egress IP, then call a real NetEase comment endpoint. Entries are sorted by combined IP-check and NetEase latency, de-duplicated by real egress IP, and only verified distinct IPs survive. Scans re-verify an active pool at task start.

Default managed pool: 4 selected exits from 24 candidates, listeners beginning at port 17891, controller on 19097. These are defaults, not assumptions for scan logic.

Security rules:

- Generated listeners bind only to `127.0.0.1`; LAN, TUN, IPv6, and DNS are disabled in the generated Mihomo config.
- Clash profile paths accepted by the dashboard must be in the discovered allowlist. `readClashVergeProfiles` additionally confines profile files to the profile directory and accepts only YAML remote/local entries.
- Proxy URLs may contain credentials. Pool/config files use mode `0600` off Windows, dashboard responses mask credentials, and logs/errors must not expose them.
- Never commit or print `.ncm/cookie.txt`, QR images, proxy-pool files, profile contents, tokens, `.env`, or user result/state data.

## Desktop and updates

- `src/electron-main.ts`: app/window lifecycle, loopback dashboard, navigation restrictions, IPC handlers, and Windows updater initialization.
- `src/electron-preload.ts`: the only renderer bridge. Keep `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`; expose narrowly scoped methods only.
- `src/window-shell.ts`: frameless Windows policy, desktop URL marker, and shared IPC channel constants. The sandboxed preload duplicates channel strings intentionally because it cannot require local modules at runtime.
- Renderer navigation/popups are denied and opened via the OS external browser. Static responses set a self-only CSP and prevent path traversal.
- `src/update.ts`: generic GitHub latest-release lookup and platform asset selection for web/macOS/manual fallback; API responses are cached for five minutes by the server.
- `src/windows-updater.ts`: packaged-Windows-only state machine around `electron-updater`. Auto-download/install are off; the UI checks, downloads with progress/integrity verification, then explicitly calls silent restart/install.
- `electron-updater` is loaded lazily only when packaged Windows initializes native updates. Never use its nonexistent default export, and keep updater initialization failure non-fatal so the dashboard can fall back to manual release checks. Desktop startup/updater/renderer failures are written under `userData/logs/desktop.log`.
- Windows auto-update releases require all three matching artifacts: the NSIS `.exe`, its `.exe.blockmap`, and `latest.yml`. The metadata names/version/hash must match the final installer. A client older than the first updater-capable release still needs one manual upgrade.

## File map

| Path | Responsibility |
| --- | --- |
| `src/types.ts` | Shared domain, state, option, and report contracts. |
| `src/api.ts` | Adapter over pinned `@neteasecloudmusicapienhanced/api`; response/error normalization. |
| `src/auth.ts` | QR login polling and private cookie persistence. |
| `src/governor.ts`, `src/errors.ts` | Start spacing, budgets, retries, cooldown/cancel signals. |
| `src/scanner.ts`, `src/state.ts` | User-source/history scans, pooled workers, checkpoints, coverage. |
| `src/parallel-scanner.ts` | Cursor time shards, lane failover, parallel checkpoints. |
| `src/results.ts` | Serialized JSONL append, de-duplication, NetEase comment URL. |
| `src/mihomo-pool.ts` | Clash discovery, managed Mihomo, external pools, egress verification. |
| `src/estimate.ts` | Pure throughput/duration estimator. |
| `src/server.ts` | Loopback HTTP API, job/auth/pool managers, SSE, validation, static files. |
| `src/cli.ts` | `auth-qr`, `scan`, `scan-song`, `proxy-pool`, and `web` commands. |
| `src/update.ts` | GitHub release check and manual asset selection. |
| `src/windows-updater.ts` | Native Windows update controller/state machine. |
| `src/electron-main.ts`, `src/electron-preload.ts`, `src/window-shell.ts` | Desktop host and isolated renderer bridge. |
| `web/index.html` | Accessible controls/dialog structure; no inline scripts/styles because of CSP. |
| `web/app.js` | UI state, API calls, polling/SSE, estimates, native update UX. |
| `web/styles.css` | Responsive/desktop styling and reduced-motion handling. |
| `test/` | Node test-runner coverage by source module; upstream and network behavior are stubbed. |
| `build/` | Icons and electron-builder macOS metadata hook. |
| `scripts/build-mac.cjs` | Builds signed DMGs in a temp directory, then copies artifacts to `release/`. |
| `.github/workflows/windows-package.yml` | Runs tests, launches the packaged Windows app in smoke mode, builds NSIS assets, and uploads them for release. |

## Dashboard HTTP surface

- Health/update: `GET /api/health`, `GET /api/update`.
- User-source job: `GET|POST /api/job`, `POST /api/job/stop`, `GET /api/results`, `GET /api/results/stream`.
- Parallel job: `GET|POST /api/parallel/job`, `POST /api/parallel/job/stop`, `GET /api/parallel/results`, `GET /api/parallel/results/stream`.
- Pool: `GET /api/pool`, `POST /api/pool/start|import|stop`.
- Lookups/tools: `GET /api/user`, `GET /api/song`, `GET /api/estimate`.
- Auth: `GET /api/auth`, `POST /api/auth/qr`, `GET /api/auth/qr.png`.

Inputs are bounded in `src/server.ts`; body size is capped at 64 KiB; IDs must be decimal digits; proxy schemes are HTTP/HTTPS only. Preserve these boundaries when adding endpoints.

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

1. Bump the same semantic version in `package.json` and `package-lock.json` (for example with `npm version X.Y.Z --no-git-tag-version`). Update README statements that name a concrete artifact/version.
2. Run the full verification above and build platform artifacts from the final source/version.
3. For Windows, dispatch `Windows package validation`, require its packaged-app smoke test to pass, and use its uploaded artifacts. Inspect `latest.yml` and ensure the final `.exe`, `.exe.blockmap`, and `latest.yml` all exist. Do not rename one without regenerating metadata.
4. Commit/push the source, create tag `vX.Y.Z` on that exact commit, and publish a **stable** GitHub Release with the platform assets. The repository configured in `package.json` and `src/update.ts` is `RocXOvO/ncm-comment-finder`.
5. Verify the public Release assets and hashes after upload, and confirm the latest stable Release points to the intended version. Do not mark a broken build as latest; preserve an explicit upgrade path for users whose updater cannot start.

Local verification, the Windows workflow, and post-upload checks are all release gates; one does not replace the others.

## Common traps

- Editing only the estimator/UI can make a concurrency number look changed while execution still uses an old/default worker count. Trace and test the full topology path.
- `scan` (`comment_music` offsets) and `scan-song` (`comment_new` time cursors) have different pagination, state, defaults, and privacy/login behavior.
- Multiple workers share one governor per lane. Giving every worker its own governor would accidentally multiply the per-IP start rate.
- Pool entry count is not proof of independent capacity; only verified distinct egress IPs count as lanes.
- Source `both` may finish with partial coverage when one source is restricted. Keep `sourceErrors` and coverage semantics visible.
- A finished checkpoint returns immediately. When testing a changed configuration, use a fresh temp state path; do not silently mutate compatibility fields in old state.
- Runtime paths differ: source/CLI defaults use the project root; packaged Electron uses `userData`. Never hardcode repository runtime paths in desktop code.
- `dist/` is generated from `src/` and ignored. Edit TypeScript sources, not compiled JavaScript.
- GitHub's generic latest-release check and native Windows `electron-updater` are separate paths. Test both when changing update UX.

## Maintaining this memory

Update this file in the same commit whenever a change alters module ownership, entry points, routes, state schema/compatibility, concurrency/rate semantics, proxy validation, security boundaries, build commands, artifacts, or release/update behavior. Verify claims against current code and tests, remove stale statements instead of appending history, and keep user instructions in `README.md` synchronized. If only implementation details change without affecting how a future agent navigates or reasons about the system, no memory edit is needed.
