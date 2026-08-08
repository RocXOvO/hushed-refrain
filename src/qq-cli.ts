#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { RequestGovernor } from "./governor";
import {
  DEFAULT_QQ_MUSIC_COMMENT_PAGE_SIZE,
  QQ_MUSIC_COMMENT_PAGE_SIZE_MAX,
  QQMusicClient,
} from "./qq-music/client";
import { runQQMusicScan } from "./qq-music/scanner";
import { stableQQMusicTaskKey } from "./qq-music/state";
import {
  cancelQQMusicLanes,
  QQMusicTransportGate,
  qqMusicTransportProfile,
} from "./qq-music/transport-gate";
import type { QQCommentLane, QQMusicScanOptions } from "./qq-music/types";

const help = `
qq-music-comments - 乐评寻踪·QQ 音乐评论检索 CLI

Commands:
  resolve-user --user VALUE          resolve a QQ number/profile URL to EncryptUin
  song-info --song-id ID             inspect public song metadata
  scan-song --user VALUE --song-id ID
                                      scan one song for comments by the target user
  scan-likes --user VALUE            discover public liked songs, then scan each song

User VALUE may be a numeric QQ number, a QQ Music profile URL, or EncryptUin.

Scan options:
  --comment-page-size N              new task default: 25 (current API maximum); legacy resume values above 25 migrate to 25
  --liked-page-size N                new task default: 500 (API maximum); resume keeps checkpoint value
  --max-songs N                      default: 0 (all visible liked songs)
  --max-comment-pages-per-song N     default: 0 (all pages)
  --workers-per-lane N               default: 4; parallelizes songs, not pages of one song
  --max-workers N                    default: 8; hard cap 1..32
  --request-budget N                 default: 250; task-wide logical comment pages; 0 means unlimited
  --min-delay-ms N                   default: 300 between starts on one exit
  --jitter-ms N                      default: 100 (actual range 300-399 ms)
  --max-retries N                    default: 2
  --forbidden-cooldown-ms N          default: 900000
  --state PATH                       default: data/qq/state-<stable-task-key>.json
  --output PATH                      default: data/qq/comments-<stable-task-key>.jsonl
  --stop-after-first
  --fresh

Examples:
  npx tsx src/qq-cli.ts resolve-user --user 123456
  npx tsx src/qq-cli.ts scan-song --user 123456 --song-id 102065756
  npx tsx src/qq-cli.ts scan-likes --user 7eEFNeSlNKns --max-songs 20
`;

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(help);
    return;
  }

  const client = new QQMusicClient();
  if (command === "resolve-user") {
    const parsed = parseArgs({
      args: process.argv.slice(3),
      options: { user: { type: "string" } },
      strict: true,
    });
    process.stdout.write(`${JSON.stringify(await client.resolveUser(required(parsed.values.user, "user")), null, 2)}\n`);
    return;
  }

  if (command === "song-info") {
    const parsed = parseArgs({
      args: process.argv.slice(3),
      options: { "song-id": { type: "string" } },
      strict: true,
    });
    process.stdout.write(`${JSON.stringify(await client.getSongInfo(numericId(parsed.values["song-id"], "song-id")), null, 2)}\n`);
    return;
  }

  if (command !== "scan-song" && command !== "scan-likes") {
    throw new Error(`Unknown QQ Music command: ${command}\n${help}`);
  }

  const parsed = parseArgs({
    args: process.argv.slice(3),
    options: {
      user: { type: "string" },
      "song-id": { type: "string" },
      "comment-page-size": {
        type: "string",
        default: String(DEFAULT_QQ_MUSIC_COMMENT_PAGE_SIZE),
      },
      "liked-page-size": { type: "string", default: "500" },
      "max-songs": { type: "string", default: "0" },
      "max-comment-pages-per-song": { type: "string", default: "0" },
      "workers-per-lane": { type: "string", default: "4" },
      "max-workers": { type: "string", default: "8" },
      "request-budget": { type: "string", default: "250" },
      "min-delay-ms": { type: "string", default: "300" },
      "jitter-ms": { type: "string", default: "100" },
      "max-retries": { type: "string", default: "2" },
      "forbidden-cooldown-ms": { type: "string", default: "900000" },
      state: { type: "string" },
      output: { type: "string" },
      "stop-after-first": { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
    },
    strict: true,
  });

  const target = required(parsed.values.user, "user");
  const mode = command === "scan-song" ? "song" : "likes";
  const songId = mode === "song" ? numericId(parsed.values["song-id"], "song-id") : undefined;
  const workersPerLane = integer(
    parsed.values["workers-per-lane"],
    "workers-per-lane",
    1,
    16,
  );
  const maxWorkers = integer(parsed.values["max-workers"], "max-workers", 1, 32);
  const requestBudget = integer(parsed.values["request-budget"], "request-budget", 0);
  const pageSize = integer(
    parsed.values["comment-page-size"],
    "comment-page-size",
    1,
    QQ_MUSIC_COMMENT_PAGE_SIZE_MAX,
  );
  const likedPageSize = integer(parsed.values["liked-page-size"], "liked-page-size", 1, 500);
  const maxSongs = integer(parsed.values["max-songs"], "max-songs", 0);
  const maxCommentPagesPerSong = integer(
    parsed.values["max-comment-pages-per-song"],
    "max-comment-pages-per-song",
    0,
  );
  const transportProfile = qqMusicTransportProfile(
    mode,
    1,
    mode === "song" ? 1 : Math.min(workersPerLane, maxWorkers),
  );
  const transportGate = new QQMusicTransportGate({
    maxConcurrent: transportProfile.maxConcurrent,
    minStartDelayMs: transportProfile.minStartDelayMs,
  });
  const lanes: QQCommentLane[] = [{
    name: "direct",
    client,
    transportGate,
    governor: new RequestGovernor({
      requestBudget: 0,
      minDelayMs: integer(parsed.values["min-delay-ms"], "min-delay-ms", 0),
      jitterMs: integer(parsed.values["jitter-ms"], "jitter-ms", 0),
      maxRetries: integer(parsed.values["max-retries"], "max-retries", 0),
      forbiddenCooldownMs: integer(
        parsed.values["forbidden-cooldown-ms"],
        "forbidden-cooldown-ms",
        1_000,
      ),
      platformPolicy: "qq",
    }),
  }];

  const stop = (): void => cancelQQMusicLanes(lanes);
  process.once("SIGINT", stop);
  try {
    let scanTarget = target;
    let key: string | undefined;
    if (!parsed.values.state || !parsed.values.output) {
      const resolvedTarget = await lanes[0].governor.execute(
        "qq_user_resolve",
        () => transportGate.run(() => client.resolveUser(target, transportGate.signal)),
      );
      scanTarget = resolvedTarget.encryptUin;
      key = stableQQMusicTaskKey(mode, scanTarget, songId);
    }
    const options: QQMusicScanOptions = {
      mode,
      target: scanTarget,
      songId,
      pageSize,
      likedPageSize,
      maxSongs,
      maxCommentPagesPerSong,
      workersPerLane,
      maxWorkers,
      requestBudget,
      stopAfterFirst: parsed.values["stop-after-first"]!,
      fresh: parsed.values.fresh!,
      statePath: resolve(parsed.values.state ?? `data/qq/state-${key}.json`),
      outputPath: resolve(parsed.values.output ?? `data/qq/comments-${key}.jsonl`),
    };
    const report = await runQQMusicScan(lanes, options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    process.off("SIGINT", stop);
  }
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`--${name} is required.`);
  return normalized;
}

function numericId(value: string | undefined, name: string): string {
  const normalized = required(value, name);
  if (!/^\d+$/.test(normalized)) throw new Error(`--${name} must contain decimal digits.`);
  return normalized;
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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
