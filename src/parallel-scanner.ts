import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CooldownRequired,
  RequestBudgetExhausted,
  RunCancelled,
} from "./errors";
import { RequestGovernor } from "./governor";
import { JsonlResultWriter } from "./results";
import type {
  CommentTimeShard,
  FoundComment,
  NcmClient,
  ParallelSongScanOptions,
  ParallelSongScanReport,
  ParallelSongScanState,
} from "./types";

export interface ParallelCommentLane {
  name: string;
  client: NcmClient;
  governor: RequestGovernor;
}

class LaneRequestFailure extends Error {
  constructor(public readonly lane: string, public readonly original: unknown) {
    super(`Comment lane ${lane} failed.`);
    this.name = "LaneRequestFailure";
  }
}

export async function runParallelSongScan(
  lanes: ParallelCommentLane[],
  options: ParallelSongScanOptions,
): Promise<ParallelSongScanReport> {
  if (lanes.length === 0) throw new Error("At least one comment lane is required.");
  const startedAt = Date.now();
  const loaded = options.fresh ? undefined : await loadParallelState(options.statePath);
  if (loaded) assertCompatible(loaded, options);
  const state = loaded ?? createParallelState(options);
  const initialRequests = state.requestCount;
  const seenCommentIds = new Set(state.seenCommentIds);
  const writer = new JsonlResultWriter(options.outputPath);
  await writer.initialize();

  let checkpointTail = Promise.resolve();
  let lastCheckpointAt = 0;
  const checkpoint = async (force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastCheckpointAt < 500) return;
    lastCheckpointAt = now;
    state.requestCount = initialRequests + requestsUsed(lanes);
    const snapshot = structuredClone(state);
    checkpointTail = checkpointTail.then(() => saveParallelState(options.statePath, snapshot));
    await checkpointTail;
  };

  if (state.finished) {
    return makeReport("complete", state, lanes, options, initialRequests, startedAt);
  }
  if (options.stopAfterFirst && state.matchCount > 0) {
    return makeReport(
      "matched",
      state,
      lanes,
      options,
      initialRequests,
      startedAt,
      "A matching comment is already present in the checkpoint.",
    );
  }

  const queue = state.shards
    .filter((shard) => !shard.done)
    .sort((left, right) => right.endTime - left.endTime);
  const blockedLanes = new Set<string>();
  const failedLanes = new Map<string, string>();
  const initialPages = state.pagesProcessed;
  let scheduledRequests = 0;
  let stopRequested = false;
  let matched = false;
  let budgetReached = false;
  let cancelled = false;
  let fatalError: unknown;

  const reserveRequest = (): boolean => {
    if (stopRequested) return false;
    if (options.maxPages > 0 && initialPages + scheduledRequests >= options.maxPages) {
      budgetReached = true;
      stopRequested = true;
      return false;
    }
    if (options.requestBudget > 0 && scheduledRequests >= options.requestBudget) {
      budgetReached = true;
      stopRequested = true;
      return false;
    }
    scheduledRequests += 1;
    return true;
  };

  const scanShard = async (
    lane: ParallelCommentLane,
    shard: CommentTimeShard,
  ): Promise<void> => {
    while (!stopRequested && !shard.done) {
      if (!reserveRequest()) return;

      const requestedCursor = shard.cursor;
      let page;
      try {
        page = await lane.governor.execute(
          `comment_new:${options.songId}:shard-${shard.id}`,
          () => lane.client.getSongCommentsByCursor(
            options.songId,
            options.pageSize,
            shard.pageNo,
            requestedCursor,
          ),
        );
      } catch (error) {
        if (
          error instanceof CooldownRequired ||
          error instanceof RequestBudgetExhausted ||
          error instanceof RunCancelled
        ) {
          throw error;
        }
        throw new LaneRequestFailure(lane.name, error);
      }

      shard.pagesProcessed += 1;
      shard.pageNo += 1;
      state.pagesProcessed += 1;

      const rangedComments = page.comments.filter((comment) =>
        comment.time !== undefined &&
        comment.time >= shard.startTime &&
        comment.time < shard.endTime
      );
      state.commentsInspected += rangedComments.length;

      for (const comment of rangedComments) {
        if (comment.userId !== options.uid) continue;
        if (options.stopAfterFirst && matched) break;
        if (seenCommentIds.has(comment.commentId)) {
          if (options.stopAfterFirst) {
            matched = true;
            stopRequested = true;
          }
          continue;
        }
        if (writer.has(comment.commentId)) {
          state.seenCommentIds.push(comment.commentId);
          seenCommentIds.add(comment.commentId);
          state.matchCount += 1;
          if (options.stopAfterFirst) {
            matched = true;
            stopRequested = true;
          }
          continue;
        }
        if (options.stopAfterFirst) matched = true;
        const record: FoundComment = {
          ...comment,
          songId: options.songId,
          songName: options.songName,
          route: "song-comments",
          capturedAt: new Date().toISOString(),
        };
        if (await writer.append(record)) {
          state.seenCommentIds.push(comment.commentId);
          seenCommentIds.add(comment.commentId);
          state.matchCount += 1;
        }
        if (options.stopAfterFirst) {
          stopRequested = true;
          break;
        }
      }

      const times = page.comments
        .map((comment) => comment.time)
        .filter((time): time is number => time !== undefined);
      const oldestTime = times.length > 0 ? Math.min(...times) : undefined;
      const nextCursor = Number(page.nextCursor);
      const cursorAdvanced = Number.isFinite(nextCursor) && nextCursor < Number(requestedCursor);
      if (
        !page.hasMore ||
        page.comments.length === 0 ||
        (oldestTime !== undefined && oldestTime < shard.startTime) ||
        !cursorAdvanced
      ) {
        shard.done = true;
      } else {
        shard.cursor = String(nextCursor);
      }
      await checkpoint();
    }
  };

  const runWorker = async (lane: ParallelCommentLane): Promise<void> => {
    while (!stopRequested && !blockedLanes.has(lane.name) && !failedLanes.has(lane.name)) {
      const shard = queue.shift();
      if (!shard) return;
      try {
        await scanShard(lane, shard);
        if (!shard.done && !stopRequested) queue.push(shard);
      } catch (error) {
        if (error instanceof CooldownRequired) {
          blockedLanes.add(lane.name);
          if (!shard.done) queue.push(shard);
          if (blockedLanes.size + failedLanes.size === lanes.length) stopRequested = true;
          return;
        }
        if (error instanceof LaneRequestFailure) {
          failedLanes.set(lane.name, errorMessage(error.original));
          if (!shard.done) queue.push(shard);
          if (blockedLanes.size + failedLanes.size === lanes.length) stopRequested = true;
          return;
        }
        if (error instanceof RequestBudgetExhausted) {
          budgetReached = true;
          stopRequested = true;
          return;
        }
        if (error instanceof RunCancelled) {
          cancelled = true;
          stopRequested = true;
          return;
        }
        fatalError = error;
        stopRequested = true;
        return;
      }
    }
  };

  const workers = lanes.flatMap((lane) =>
    Array.from({ length: options.workersPerLane }, () => runWorker(lane))
  );
  await Promise.all(workers);
  await checkpoint(true);
  if (fatalError) throw fatalError;

  state.finished = state.shards.every((shard) => shard.done);
  await checkpoint(true);
  const status = matched && options.stopAfterFirst
    ? "matched"
    : state.finished
    ? "complete"
    : cancelled
    ? "stopped"
    : blockedLanes.size > 0 && blockedLanes.size === lanes.length
    ? "cooldown"
    : "paused";
  const note = budgetReached
    ? "The page or request budget was reached; rerun the same command to resume."
    : blockedLanes.size > 0
    ? `Cooldown lanes: ${[...blockedLanes].join(", ")}.`
    : failedLanes.size > 0
    ? `Failed lanes: ${[...failedLanes].map(([lane, message]) => `${lane}: ${message}`).join("; ")}.`
    : matched && options.stopAfterFirst
    ? "Stopped after the first matching comment."
    : undefined;
  return makeReport(status, state, lanes, options, initialRequests, startedAt, note);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTimeShards(
  startTime: number,
  endTime: number,
  shardCount: number,
): CommentTimeShard[] {
  if (!Number.isInteger(startTime) || !Number.isInteger(endTime) || endTime <= startTime) {
    throw new Error("The scan time range is invalid.");
  }
  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new Error("shardCount must be a positive integer.");
  }
  const width = Math.ceil((endTime - startTime) / shardCount);
  return Array.from({ length: shardCount }, (_, id) => {
    const shardStart = startTime + id * width;
    const shardEnd = Math.min(endTime, shardStart + width);
    return {
      id,
      startTime: shardStart,
      endTime: shardEnd,
      cursor: String(shardEnd),
      pageNo: 2,
      pagesProcessed: 0,
      done: false,
    };
  }).filter((shard) => shard.startTime < shard.endTime);
}

function createParallelState(options: ParallelSongScanOptions): ParallelSongScanState {
  const now = new Date().toISOString();
  return {
    version: 1,
    kind: "parallel-song",
    uid: options.uid,
    songId: options.songId,
    songName: options.songName,
    startTime: options.startTime,
    endTime: options.endTime,
    shardCount: options.shardCount,
    pageSize: options.pageSize,
    shards: createTimeShards(options.startTime, options.endTime, options.shardCount),
    pagesProcessed: 0,
    commentsInspected: 0,
    requestCount: 0,
    matchCount: 0,
    seenCommentIds: [],
    finished: false,
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadParallelState(path: string): Promise<ParallelSongScanState | undefined> {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as ParallelSongScanState;
    if (state.version !== 1 || state.kind !== "parallel-song") {
      throw new Error("Unsupported parallel scan state.");
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveParallelState(path: string, state: ParallelSongScanState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function assertCompatible(
  state: ParallelSongScanState,
  options: ParallelSongScanOptions,
): void {
  const mismatches: string[] = [];
  if (state.uid !== options.uid) mismatches.push("uid");
  if (state.songId !== options.songId) mismatches.push("songId");
  if (state.startTime !== options.startTime) mismatches.push("startTime");
  if (state.endTime !== options.endTime) mismatches.push("endTime");
  if (state.shardCount !== options.shardCount) mismatches.push("shardCount");
  if (state.pageSize !== options.pageSize) mismatches.push("pageSize");
  if (mismatches.length > 0) {
    throw new Error(`Parallel state mismatch (${mismatches.join(", ")}); use --fresh or another state path.`);
  }
}

function requestsUsed(lanes: ParallelCommentLane[]): number {
  return lanes.reduce((total, lane) => total + lane.governor.requestsUsed, 0);
}

function makeReport(
  status: ParallelSongScanReport["status"],
  state: ParallelSongScanState,
  lanes: ParallelCommentLane[],
  options: ParallelSongScanOptions,
  initialRequests: number,
  startedAt: number,
  note?: string,
): ParallelSongScanReport {
  const requestsThisRun = requestsUsed(lanes);
  return {
    status,
    uid: state.uid,
    songId: state.songId,
    songName: state.songName,
    lanes: lanes.length,
    workers: lanes.length * options.workersPerLane,
    shards: state.shards.length,
    shardsComplete: state.shards.filter((shard) => shard.done).length,
    pagesProcessed: state.pagesProcessed,
    commentsInspected: state.commentsInspected,
    matches: state.matchCount,
    requestsThisRun,
    requestsTotal: initialRequests + requestsThisRun,
    elapsedMs: Date.now() - startedAt,
    statePath: options.statePath,
    outputPath: options.outputPath,
    note,
  };
}
