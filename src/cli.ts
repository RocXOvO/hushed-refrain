#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { RequestGovernor } from "./governor";
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
import type { ScanOptions, SourceSelection, Strategy } from "./types";

const help = `
ncm-comments - checkpointed NetEase Cloud Music comment finder

Commands:
  auth-qr             Log in with a QR code and save the session cookie
  scan --uid UID      Find comments by UID through listening records or liked songs
  scan-song            Scan one song with parallel time shards and match a UID
  proxy-pool           Start, inspect, or stop a verified Mihomo egress pool
  web                  Start the local browser dashboard

Scan options:
  --strategy auto|scan|history       default: auto
  --source record|likes|both         default: both
  --record-scope all|week            default: all
  --cookie-file PATH                 default: .ncm/cookie.txt
  --output PATH                      default: data/comments-UID.jsonl
  --state PATH                       default: data/state-UID-SOURCE.json
  --comment-page-size N              default: 100
  --history-page-size N              default: 50
  --max-comment-pages-per-song N     default: 0 (all pages)
  --max-songs N                      default: 0 (all source songs)
  --request-budget N                 default: 250 per run
  --min-delay-ms N                   default: 2500
  --jitter-ms N                      default: 800
  --max-retries N                    default: 3 (network/5xx only)
  --forbidden-cooldown-ms N          default: 900000
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
  --max-pages N                     default: 0 (all pages)
  --min-delay-ms N                  default: 333 per worker
  --jitter-ms N                     default: 100 per worker
  --stop-after-first
  --fresh

Proxy pool commands:
  npm run start -- proxy-pool start    build and verify network-diverse egress listeners
  npm run start -- proxy-pool import   verify and use external HTTP proxy endpoints
  npm run start -- proxy-pool status   show the active pool and verified IPs
  npm run start -- proxy-pool stop     stop the dedicated Mihomo process

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
      "source-config": { type: "string", default: defaults.sourceConfigPath },
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
    sourceConfigPath: resolve(parsed.values["source-config"]!),
    mihomoPath: resolve(parsed.values.mihomo!),
    workDirectory: resolve(parsed.values["work-dir"]!),
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
      "min-delay-ms": { type: "string", default: "333" },
      "jitter-ms": { type: "string", default: "100" },
      "max-retries": { type: "string", default: "2" },
      "forbidden-cooldown-ms": { type: "string", default: "900000" },
      output: { type: "string" },
      state: { type: "string" },
      "stop-after-first": { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
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
  const statePath = resolve(
    parsed.values.state ?? `data/parallel-state-${uid}-${songId}.json`,
  );
  const outputPath = resolve(
    parsed.values.output ?? `data/parallel-comments-${uid}-${songId}.jsonl`,
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
  const lanes: ParallelCommentLane[] = endpoints.map((proxy, index) => ({
    name: proxy ? `proxy-${index + 1}` : "direct",
    client: new EnhancedNcmClient({ proxy }),
    governor: new RequestGovernor({
      requestBudget: Math.max(1_000, requestBudget * 2),
      concurrency: workersPerLane,
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
    const song = await lanes[0].governor.execute(`song_detail:${songId}`, () =>
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
      "comment-page-size": { type: "string", default: "100" },
      "history-page-size": { type: "string", default: "50" },
      "max-comment-pages-per-song": { type: "string", default: "0" },
      "max-songs": { type: "string", default: "0" },
      "request-budget": { type: "string", default: "250" },
      "min-delay-ms": { type: "string", default: "2500" },
      "jitter-ms": { type: "string", default: "800" },
      "max-retries": { type: "string", default: "3" },
      "forbidden-cooldown-ms": { type: "string", default: "900000" },
      proxy: { type: "string" },
      "stop-after-first": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
    },
    strict: true,
  });

  const uid = parsed.values.uid?.trim();
  if (!uid || !/^\d+$/.test(uid)) throw new Error("--uid must be a numeric user ID.");
  const source = oneOf(parsed.values.source, ["record", "likes", "both"] as const, "source");
  const strategy = oneOf(parsed.values.strategy, ["auto", "scan", "history"] as const, "strategy");
  const recordScope = oneOf(parsed.values["record-scope"], ["all", "week"] as const, "record-scope");
  const cookiePath = resolve(parsed.values["cookie-file"]!);
  const cookie = await readCookie(cookiePath);

  const options: ScanOptions = {
    uid,
    strategy: strategy as Strategy,
    source: source as SourceSelection,
    recordScope,
    cookie,
    statePath: resolve(parsed.values.state ?? `data/state-${uid}-${source}.json`),
    outputPath: resolve(parsed.values.output ?? `data/comments-${uid}.jsonl`),
    commentPageSize: integer(parsed.values["comment-page-size"], "comment-page-size", 1, 100),
    historyPageSize: integer(parsed.values["history-page-size"], "history-page-size", 1, 100),
    maxCommentPagesPerSong: integer(parsed.values["max-comment-pages-per-song"], "max-comment-pages-per-song", 0),
    maxSongs: integer(parsed.values["max-songs"], "max-songs", 0),
    stopAfterFirst: parsed.values["stop-after-first"]!,
    fresh: parsed.values.fresh!,
    dryRun: parsed.values["dry-run"]!,
  };

  const governor = new RequestGovernor({
    requestBudget: integer(parsed.values["request-budget"], "request-budget", 1),
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
