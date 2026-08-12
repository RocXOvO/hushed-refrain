#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { RequestGovernor } from "./governor";
import { executeProxyRequest, ProxyTransportGate } from "./proxy-transport-gate";
import {
  defaultMihomoPoolOptions,
  importExternalProxyPool,
  proxyPoolRunning,
  readProxyPool,
  startMihomoPool,
  stopMihomoPool,
  verifyProxyPool,
} from "./mihomo-pool";
import {
  loadParallelState,
  runParallelSongScan,
  type ParallelCommentLane,
} from "./parallel-scanner";
import { runCommentFinder } from "./scanner";
import {
  migrateLegacyWeekState,
  SOURCE_COVERAGE_VERSION,
  SOURCE_RESULT_VERSION,
  SOURCE_STATE_VERSION,
} from "./state";
import type { CommentScope, ScanOptions, SourceSelection, Strategy } from "./types";

const help = `
ncm-comments / hushed-refrain - Hushed Refrain · 网易云评论检索 CLI

Commands:
  auth-qr             Log in with a QR code and save the session cookie
  scan --uid UID      Find comments by UID through rankings, liked songs, or user playlists
  scan-song            Scan one song with parallel time shards and match a UID
  proxy-pool           Start, inspect, or stop a verified Mihomo egress pool
  web                  Start the local browser dashboard

Scan options:
  --strategy auto|scan|history       default: auto
  --source record|likes|playlists|both|all  default: both
  --record-scope all|week|both       default: all
  --cookie-file PATH                 default: .ncm/cookie.txt
  --output PATH                      default: data/comments-UID-target-v3.jsonl
  --state PATH                       default: data/state-UID-SOURCE-target-v4.json
  --coverage PATH                    default: data/song-coverage-UID-target-v4.json
  --comment-page-size N              default: 1000, maximum: 2000
  --history-page-size N              default: 50
  --max-comment-pages-per-song N     default: 0 (all top-level pages; floor replies use request budget)
  --max-songs N                      default: 0 (all source songs)
  --request-budget N                 default: 250 per run
  --min-delay-ms N                   default: 300 between starts on one exit
  --jitter-ms N                      default: 100 (actual range 300-399 ms)
  --max-retries N                    default: 3 (network/5xx only)
  --forbidden-cooldown-ms N          default: 900000
  --no-comment-floors                scan top-level comments only
  --proxy URL                         optional static HTTP/HTTPS proxy
  --stop-after-first
  --dry-run
  --fresh

Parallel song options:
  --uid UID                          target public user ID
  --song-id ID                      song to scan
  --proxy URL                       repeat for each Clash/Mihomo listener
  --proxy-list URL,URL              comma-separated listener list
  --workers-per-proxy N             default: 3
  --shards N                        default: 96 time ranges
  --comment-page-size N             default: 1000, maximum: 2000
  --start-time TIME                 epoch milliseconds or ISO date
  --end-time TIME                   epoch milliseconds or ISO date
  --request-budget N                default: 5000
  --max-pages N                     default: 0 (all top-level pages; floor replies use request budget)
  --min-delay-ms N                  default: 300 between starts on one exit
  --jitter-ms N                     default: 100 (actual range 300-399 ms)
  --no-comment-floors               scan top-level comments only
  --stop-after-first
  --fresh

Proxy pool commands:
  npm run start -- proxy-pool start    build and verify network-diverse egress listeners
  npm run start -- proxy-pool import   verify and use external HTTP proxy endpoints
  npm run start -- proxy-pool status   show the active pool and verified IPs
  npm run start -- proxy-pool stop     stop the dedicated Mihomo process
  --size N                             default: 8, maximum: 32
  --candidates N                       default: 48, maximum: 128

Examples:
  npm run start -- auth-qr
  npm run start -- scan --uid 123456 --source record --dry-run
  npm run start -- scan --uid 123456 --source both
  npm run start -- scan-song --uid 123456 --song-id 186016 --proxy http://127.0.0.1:17891 --proxy http://127.0.0.1:17892
`;

async function main(): Promise<void> {
  process.env.DOTENV_CONFIG_QUIET ??= "true";
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(help);
    return;
  }

  if (command === "auth-qr") {
    await authCommand(process.argv.slice(3));
    return;
  }
  if (command === "scan") {
    await scanCommand(process.argv.slice(3));
    return;
  }
  if (command === "scan-song") {
    await scanSongCommand(process.argv.slice(3));
    return;
  }
  if (command === "proxy-pool") {
    await proxyPoolCommand(process.argv.slice(3));
    return;
  }
  if (command === "web") {
    await webCommand(process.argv.slice(3));
    return;
  }
  throw new Error(`Unknown command: ${command}\n${help}`);
}

async function proxyPoolCommand(args: string[]): Promise<void> {
  const defaults = defaultMihomoPoolOptions(resolve(__dirname, ".."));
  const parsed = parseArgs({
    args,
    options: {
      "source-config": { type: "string", multiple: true, default: defaults.sourceConfigPaths },
      mihomo: { type: "string", default: defaults.mihomoPath },
      "work-dir": { type: "string", default: defaults.workDirectory },
      output: { type: "string", default: defaults.poolPath },
      "base-port": { type: "string", default: String(defaults.basePort) },
      size: { type: "string", default: String(defaults.size) },
      candidates: { type: "string", default: String(defaults.candidateCount) },
      "controller-port": { type: "string", default: String(defaults.controllerPort) },
      proxy: { type: "string", multiple: true },
      "proxy-list": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const action = parsed.positionals[0] ?? "status";
  const poolPath = resolve(parsed.values.output!);
  const poolWorkDirectory = resolve(parsed.values["work-dir"]!);
  if (action === "stop") {
    const stopped = await stopMihomoPool(poolPath);
    process.stdout.write(`${JSON.stringify({ status: stopped ? "stopped" : "not-running", poolPath }, null, 2)}\n`);
    return;
  }
  if (action === "status") {
    const pool = await readProxyPool(poolPath);
    process.stdout.write(`${JSON.stringify({
      status: proxyPoolRunning(pool) ? "running" : "not-running",
      poolPath,
      pid: pool?.pid,
      entries: pool?.entries ?? [],
    }, null, 2)}\n`);
    return;
  }
  if (action === "import") {
    const endpoints = proxyList(parsed.values.proxy, parsed.values["proxy-list"]);
    const pool = await importExternalProxyPool(
      endpoints,
      poolPath,
      integer(parsed.values.size, "size", 0, 64),
    );
    process.stdout.write(`${JSON.stringify({ status: "running", ...pool }, null, 2)}\n`);
    return;
  }
  if (action !== "start") {
    throw new Error("proxy-pool action must be start, import, status, or stop.");
  }
  const pool = await startMihomoPool({
    sourceConfigPaths: parsed.values["source-config"]!.map((path) => resolve(path)),
    mihomoPath: resolve(parsed.values.mihomo!),
    workDirectory: poolWorkDirectory,
    poolPath,
    basePort: integer(parsed.values["base-port"], "base-port", 1, 65_535),
    size: integer(parsed.values.size, "size", 1, 32),
    candidateCount: integer(parsed.values.candidates, "candidates", 1, 128),
    controllerPort: integer(
      parsed.values["controller-port"],
      "controller-port",
      1,
      65_535,
    ),
  });
  process.stdout.write(`${JSON.stringify({ status: "running", ...pool }, null, 2)}\n`);
}

async function scanSongCommand(args: string[]): Promise<void> {
  const { EnhancedNcmClient } = await import("./api");
  const parsed = parseArgs({
    args,
    options: {
      uid: { type: "string" },
      "song-id": { type: "string" },
      "song-name": { type: "string" },
      proxy: { type: "string", multiple: true },
      "proxy-list": { type: "string" },
      "proxy-pool-file": { type: "string", default: ".ncm/proxy-pool.json" },
      "workers-per-proxy": { type: "string", default: "3" },
      shards: { type: "string", default: "96" },
      "comment-page-size": { type: "string", default: "1000" },
      "start-time": { type: "string" },
      "end-time": { type: "string" },
      "request-budget": { type: "string", default: "5000" },
      "max-pages": { type: "string", default: "0" },
      "min-delay-ms": { type: "string", default: "300" },
      "jitter-ms": { type: "string", default: "100" },
      "max-retries": { type: "string", default: "2" },
      "forbidden-cooldown-ms": { type: "string", default: "900000" },
      output: { type: "string" },
      state: { type: "string" },
      "stop-after-first": { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      "no-comment-floors": { type: "boolean", default: false },
    },
    strict: true,
  });

  const uid = numericId(parsed.values.uid, "uid");
  const songId = numericId(parsed.values["song-id"], "song-id");
  const workersPerLane = integer(
    parsed.values["workers-per-proxy"],
    "workers-per-proxy",
    1,
    16,
  );
  const shardCount = integer(parsed.values.shards, "shards", 1, 512);
  const pageSize = integer(
    parsed.values["comment-page-size"],
    "comment-page-size",
    1,
    2_000,
  );
  const requestBudget = integer(parsed.values["request-budget"], "request-budget", 1);
  const maxPages = integer(parsed.values["max-pages"], "max-pages", 0);
  const minDelayMs = integer(parsed.values["min-delay-ms"], "min-delay-ms", 0);
  const jitterMs = integer(parsed.values["jitter-ms"], "jitter-ms", 0);
  const maxRetries = integer(parsed.values["max-retries"], "max-retries", 0);
  const forbiddenCooldownMs = integer(
    parsed.values["forbidden-cooldown-ms"],
    "forbidden-cooldown-ms",
    1_000,
  );
  const commentScope: CommentScope = parsed.values["no-comment-floors"]
    ? "root-only-v1"
    : "root-and-floor-v1";
  const scopeSuffix = commentScope === "root-only-v1" ? "-root-only" : "";
  const statePath = resolve(
    parsed.values.state ?? `data/parallel-state-${uid}-${songId}${scopeSuffix}-v2.json`,
  );
  const outputPath = resolve(
    parsed.values.output ?? `data/parallel-comments-${uid}-${songId}${scopeSuffix}.jsonl`,
  );
  const previous = parsed.values.fresh ? undefined : await loadParallelState(statePath);
  let proxies = proxyList(parsed.values.proxy, parsed.values["proxy-list"]);
  if (proxies.length === 0) {
    const pool = await readProxyPool(resolve(parsed.values["proxy-pool-file"]!));
    if (proxyPoolRunning(pool)) {
      const verified = await verifyProxyPool(pool!);
      proxies = verified.map((entry) => entry.endpoint);
    }
  }
  const endpoints: Array<string | undefined> = proxies.length > 0 ? proxies : [undefined];
  const transportGate = endpoints.some(Boolean) ? new ProxyTransportGate() : undefined;
  const lanes: ParallelCommentLane[] = endpoints.map((proxy, index) => ({
    name: proxy ? `proxy-${index + 1}` : "direct",
    client: new EnhancedNcmClient({ proxy }),
    transportGate,
    governor: new RequestGovernor({
      requestBudget: Math.max(1_000, requestBudget * 2),
      minDelayMs,
      jitterMs,
      maxRetries,
      forbiddenCooldownMs,
    }),
  }));

  let songName = parsed.values["song-name"]?.trim() || previous?.songName;
  let startTime = parsed.values["start-time"]
    ? timestamp(parsed.values["start-time"], "start-time")
    : previous?.startTime;
  if (!songName || startTime === undefined) {
    const song = await executeProxyRequest(lanes[0], `song_detail:${songId}`, () =>
      lanes[0].client.getSongInfo(songId)
    );
    songName ??= song.name;
    startTime ??= song.publishTime;
  }
  startTime ??= Date.UTC(2000, 0, 1);
  const endTime = parsed.values["end-time"]
    ? timestamp(parsed.values["end-time"], "end-time")
    : previous?.endTime ?? Date.now();

  const report = await runParallelSongScan(lanes, {
    uid,
    songId,
    songName,
    startTime,
    endTime,
    shardCount,
    pageSize,
    workersPerLane,
    commentScope,
    requestBudget,
    maxPages,
    stopAfterFirst: parsed.values["stop-after-first"]!,
    fresh: parsed.values.fresh!,
    statePath,
    outputPath,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function authCommand(args: string[]): Promise<void> {
  const { qrLogin } = await import("./auth");
  const parsed = parseArgs({
    args,
    options: {
      "cookie-file": { type: "string", default: ".ncm/cookie.txt" },
      "qr-file": { type: "string", default: ".ncm/login-qr.png" },
      "timeout-seconds": { type: "string", default: "300" },
    },
    strict: true,
  });
  const cookiePath = resolve(parsed.values["cookie-file"]!);
  const qrPath = resolve(parsed.values["qr-file"]!);
  const timeoutSeconds = integer(parsed.values["timeout-seconds"], "timeout-seconds", 30);

  await qrLogin({
    cookiePath,
    qrPath,
    timeoutSeconds,
    onReady: (qrUrl, imagePath) => {
      process.stdout.write(`QR image: ${imagePath}\nQR URL: ${qrUrl}\n`);
    },
    onStatus: (code) => {
      const labels: Record<number, string> = {
        800: "expired",
        801: "waiting for scan",
        802: "scanned; waiting for confirmation",
        803: "authorized",
      };
      process.stdout.write(`QR status: ${labels[code] ?? code}\n`);
    },
  });
  process.stdout.write(`Cookie saved: ${cookiePath}\n`);
}

async function scanCommand(args: string[]): Promise<void> {
  const { EnhancedNcmClient } = await import("./api");
  const parsed = parseArgs({
    args,
    options: {
      uid: { type: "string" },
      strategy: { type: "string", default: "auto" },
      source: { type: "string", default: "both" },
      "record-scope": { type: "string", default: "all" },
      "cookie-file": { type: "string", default: ".ncm/cookie.txt" },
      output: { type: "string" },
      state: { type: "string" },
      coverage: { type: "string" },
      "comment-page-size": { type: "string", default: "1000" },
      "history-page-size": { type: "string", default: "50" },
      "max-comment-pages-per-song": { type: "string", default: "0" },
      "max-songs": { type: "string", default: "0" },
      "request-budget": { type: "string", default: "250" },
      "min-delay-ms": { type: "string", default: "300" },
      "jitter-ms": { type: "string", default: "100" },
      "max-retries": { type: "string", default: "3" },
      "forbidden-cooldown-ms": { type: "string", default: "900000" },
      proxy: { type: "string" },
      "stop-after-first": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      "no-comment-floors": { type: "boolean", default: false },
    },
    strict: true,
  });

  const uid = parsed.values.uid?.trim();
  if (!uid || !/^\d+$/.test(uid)) throw new Error("--uid must be a numeric user ID.");
  const source = oneOf(parsed.values.source, ["record", "likes", "playlists", "both", "all"] as const, "source");
  const strategy = oneOf(parsed.values.strategy, ["auto", "scan", "history"] as const, "strategy");
  const recordScope = oneOf(parsed.values["record-scope"], ["all", "week", "both"] as const, "record-scope");
  const commentScope: CommentScope = parsed.values["no-comment-floors"]
    ? "root-only-v1"
    : "root-and-floor-v1";
  const scopeSuffix = commentScope === "root-only-v1" ? "-root-only" : "";
  const cookiePath = resolve(parsed.values["cookie-file"]!);
  const cookie = await readCookie(cookiePath);

  const options: ScanOptions = {
    uid,
    strategy: strategy as Strategy,
    source: source as SourceSelection,
    recordScope,
    commentScope,
    cookie,
    statePath: resolve(parsed.values.state ?? `data/state-${uid}-${source}${(source === "record" || source === "both" || source === "all") && recordScope !== "all" ? `-record-${recordScope}` : ""}${scopeSuffix}-target-v${SOURCE_STATE_VERSION}.json`),
    outputPath: resolve(parsed.values.output ?? `data/comments-${uid}${scopeSuffix}-target-v${SOURCE_RESULT_VERSION}.jsonl`),
    coveragePath: resolve(parsed.values.coverage ?? `data/song-coverage-${uid}${scopeSuffix}-target-v${SOURCE_COVERAGE_VERSION}.json`),
    commentPageSize: integer(parsed.values["comment-page-size"], "comment-page-size", 1, 2_000),
    historyPageSize: integer(parsed.values["history-page-size"], "history-page-size", 1, 100),
    requestBudget: integer(parsed.values["request-budget"], "request-budget", 1),
    maxCommentPagesPerSong: integer(parsed.values["max-comment-pages-per-song"], "max-comment-pages-per-song", 0),
    maxSongs: integer(parsed.values["max-songs"], "max-songs", 0),
    stopAfterFirst: parsed.values["stop-after-first"]!,
    fresh: parsed.values.fresh!,
    dryRun: parsed.values["dry-run"]!,
  };
  if (!parsed.values.state && commentScope === "root-and-floor-v1" && (source === "record" || source === "both")) {
    const legacyPath = resolve(`data/state-${uid}-${source}-target-v${SOURCE_STATE_VERSION}.json`);
    const scopedPath = resolve(`data/state-${uid}-${source}-record-week-target-v${SOURCE_STATE_VERSION}.json`);
    await migrateLegacyWeekState(legacyPath, scopedPath, uid, source);
  }

  const governor = new RequestGovernor({
    // The source scanner owns the public logical-page budget. The Governor
    // remains responsible for physical retry pacing without double-charging
    // catalog, hydration, or failover requests.
    requestBudget: 0,
    minDelayMs: integer(parsed.values["min-delay-ms"], "min-delay-ms", 0),
    jitterMs: integer(parsed.values["jitter-ms"], "jitter-ms", 0),
    maxRetries: integer(parsed.values["max-retries"], "max-retries", 0),
    forbiddenCooldownMs: integer(parsed.values["forbidden-cooldown-ms"], "forbidden-cooldown-ms", 1_000),
  });
  const proxy = validateProxy(parsed.values.proxy);
  const report = await runCommentFinder(new EnhancedNcmClient({ proxy }), governor, options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function webCommand(args: string[]): Promise<void> {
  const { startDashboard } = await import("./server");
  const parsed = parseArgs({
    args,
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "4173" },
    },
    strict: true,
  });
  const host = parsed.values.host!;
  const port = integer(parsed.values.port, "port", 1, 65_535);
  await startDashboard({ host, port });
  process.stdout.write(`Dashboard: http://${host}:${port}\n`);
}

async function readCookie(path: string): Promise<string | undefined> {
  if (process.env.NCM_COOKIE?.trim()) return process.env.NCM_COOKIE.trim();
  try {
    const value = (await readFile(path, "utf8")).trim();
    return value || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function integer(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`--${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function oneOf<const T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  name: string,
): T[number] {
  if (value && allowed.includes(value)) return value as T[number];
  throw new Error(`--${name} must be one of: ${allowed.join(", ")}.`);
}

function validateProxy(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--proxy must use http:// or https://.");
  }
  return url.toString();
}

function proxyList(values: string[] | undefined, commaSeparated: string | undefined): string[] {
  const candidates = [
    ...(values ?? []),
    ...(commaSeparated?.split(",") ?? []),
  ].map((value) => value.trim()).filter(Boolean);
  return [...new Set(candidates.map((value) => validateProxy(value)!))];
}

function numericId(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) {
    throw new Error(`--${name} must be a numeric ID.`);
  }
  return normalized;
}

function timestamp(value: string, name: string): number {
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) && /^\d+$/.test(value.trim())
    ? numeric
    : Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${name} must be an epoch millisecond value or an ISO date.`);
  }
  return Math.trunc(parsed);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
