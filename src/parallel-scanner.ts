import { readAtomicJson, writeAtomicJson } from "./atomic-file";
import {
  CooldownRequired,
  RequestBudgetExhausted,
  RunCancelled,
} from "./errors";
import { RequestGovernor } from "./governor";
import { LaneRecovery } from "./lane-recovery";
import { executeProxyRequest, type ProxyTransportGate } from "./proxy-transport-gate";
import { mergeCommentTotal, timeCoveragePercent } from "./progress";
import { JsonlResultWriter } from "./results";
import { nextDescendingCursor } from "./cursor-pagination";
import { AsyncWorkQueue } from "./work-queue";
import { createTimeShards, splitRemainingTimeShard } from "./time-shards";
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
  transportGate?: ProxyTransportGate;
}

const MAX_CONSECUTIVE_LANE_FAILURES = 5;

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
  const writer = new JsonlResultWriter(options.outputPath, options.onMatch);
  await writer.initialize();

  let checkpointTail = Promise.resolve();
  let lastCheckpointAt = 0;
  const checkpoint = async (force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastCheckpointAt < 500) return;
    lastCheckpointAt = now;
    state.requestCount = initialRequests + requestsUsed(lanes);
    publishCheckpointProgress(options, state);
    const snapshot = structuredClone(state);
    checkpointTail = checkpointTail.then(() => saveParallelState(options.statePath, snapshot));
    await checkpointTail;
  };
  publishCheckpointProgress(options, state);

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

  const queue = new AsyncWorkQueue(
    state.shards
      .filter((shard) => !shard.done)
      .sort((left, right) => right.endTime - left.endTime),
  );
  const blockedLanes = new Set<string>();
  const unavailableLanes = new Set<string>();
  const laneRecovery = new Map(lanes.map((lane) => [lane.name, new LaneRecovery()]));
  const activeLaneRequests = new Map(lanes.map((lane) => [lane.name, 0]));
  const initialPages = state.pagesProcessed;
  let scheduledRequests = 0;
  let stopRequested = false;
  let matched = false;
  let budgetReached = false;
  let cancelled = false;
  let fatalError: unknown;
  let nextShardId = state.shards.reduce((maximum, shard) => Math.max(maximum, shard.id), -1) + 1;
  const allLanesUnavailable = (): boolean => lanes.every((lane) =>
    blockedLanes.has(lane.name) || unavailableLanes.has(lane.name)
  );

  const stopScheduling = (): void => {
    stopRequested = true;
    for (const recovery of laneRecovery.values()) recovery.cancel();
    queue.stop();
  };
  const maybeStopAfterLaneRequests = (): void => {
    if (
      !stopRequested &&
      allLanesUnavailable() &&
      [...activeLaneRequests.values()].every((count) => count === 0)
    ) stopScheduling();
  };
  const abortListener = (): void => {
    cancelled = true;
    stopScheduling();
  };
  options.signal?.addEventListener("abort", abortListener, { once: true });
  if (options.signal?.aborted) abortListener();
  void queue.whenClosed().then(() => {
    for (const recovery of laneRecovery.values()) recovery.cancel();
  });

  const reserveRequest = (): boolean => {
    if (stopRequested) return false;
    if (options.maxPages > 0 && initialPages + scheduledRequests >= options.maxPages) {
      budgetReached = true;
      stopScheduling();
      return false;
    }
    if (options.requestBudget > 0 && scheduledRequests >= options.requestBudget) {
      budgetReached = true;
      stopScheduling();
      return false;
    }
    scheduledRequests += 1;
    return true;
  };

  const scanShardPage = async (
    lane: ParallelCommentLane,
    workerId: string,
    shard: CommentTimeShard,
  ): Promise<CommentTimeShard[]> => {
    if (stopRequested || shard.done || !reserveRequest()) return [];

    const requestedCursor = shard.cursor;
    const requestStartedAt = Date.now();
    const requestActivity = {
      lane: lane.name,
      workerId,
      operation: "comment-page" as const,
      songId: options.songId,
      songName: options.songName,
      page: shard.pageNo,
      shardId: shard.id,
    };
    publishRequestActivity(options, { ...requestActivity, phase: "start" });
    let page;
    try {
      page = await executeProxyRequest(
        lane,
        `comment_new:${options.songId}:shard-${shard.id}`,
        () => lane.client.getSongCommentsByCursor(
          options.songId,
          options.pageSize,
          shard.pageNo,
          requestedCursor,
        ),
      );
    } catch (error) {
      const status = remoteStatus(error);
      publishRequestActivity(options, {
        ...requestActivity,
        phase: "failure",
        elapsedMs: Date.now() - requestStartedAt,
        status,
        rateLimited: error instanceof CooldownRequired || status === 403 || status === 429,
        error: errorMessage(error),
      });
      if (
        error instanceof CooldownRequired ||
        error instanceof RequestBudgetExhausted ||
        error instanceof RunCancelled
      ) {
        throw error;
      }
      throw new LaneRequestFailure(lane.name, error);
    }
    publishRequestActivity(options, {
      ...requestActivity,
      phase: "success",
      elapsedMs: Date.now() - requestStartedAt,
      comments: page.comments.length,
      totalComments: page.total,
      hasMore: page.hasMore,
    });

    const times = page.comments
      .map((comment) => comment.time)
      .filter((time): time is number => time !== undefined);
    const oldestTime = times.length > 0 ? Math.min(...times) : undefined;
    const crossedShardStart = oldestTime !== undefined && oldestTime < shard.startTime;
    const nextCursor = crossedShardStart
      ? undefined
      : nextDescendingCursor(
        page.hasMore,
        page.nextCursor,
        requestedCursor,
        `parallel shard ${shard.id} for song ${options.songId}`,
      );

    shard.pagesProcessed += 1;
    shard.pageNo += 1;
    state.pagesProcessed += 1;

    const rangedComments = page.comments.filter((comment) =>
      comment.time !== undefined &&
      comment.time >= shard.startTime &&
      comment.time < shard.endTime
    );
    state.commentsInspected += rangedComments.length;
    state.totalComments = mergeCommentTotal(state.totalComments, page.total, state.commentsInspected);

    for (const comment of rangedComments) {
      if (comment.userId !== options.uid) continue;
      if (options.stopAfterFirst && matched) break;
      if (seenCommentIds.has(comment.commentId)) {
        if (options.stopAfterFirst) {
          matched = true;
          stopScheduling();
        }
        continue;
      }
      if (writer.has(comment.commentId)) {
        state.seenCommentIds.push(comment.commentId);
        seenCommentIds.add(comment.commentId);
        state.matchCount += 1;
        if (options.stopAfterFirst) {
          matched = true;
          stopScheduling();
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
        stopScheduling();
        break;
      }
    }

    const numericNextCursor = nextCursor === undefined ? undefined : Number(nextCursor);
    const cursorPassedShardStart = numericNextCursor !== undefined && numericNextCursor <= shard.startTime;
    let nextWork: CommentTimeShard[] = [];
    if (crossedShardStart || nextCursor === undefined || cursorPassedShardStart) {
      shard.done = true;
    } else {
      shard.cursor = nextCursor;
      const waitingWorkers = queue.waitingCount();
      const split = waitingWorkers > 0
        ? splitRemainingTimeShard(shard, nextShardId)
        : undefined;
      if (split) {
        const { sibling, splitAt, remainingStart, remainingEnd } = split;
        nextShardId += 1;
        Object.assign(shard, split.current);
        state.shards.push(sibling);
        publishSchedulerActivity(options, {
          type: "adaptive-split",
          songId: options.songId,
          originalShardId: shard.id,
          newShardId: sibling.id,
          splitAt,
          remainingStart,
          remainingEnd,
          waitingWorkers,
        });
        nextWork = [shard, sibling];
      } else {
        nextWork = [shard];
      }
    }
    await checkpoint();
    return stopRequested ? [] : nextWork;
  };

  const runWorker = async (lane: ParallelCommentLane, workerIndex: number): Promise<void> => {
    const workerId = `${lane.name}:${workerIndex + 1}`;
    const recovery = laneRecovery.get(lane.name)!;
    while (!stopRequested && !blockedLanes.has(lane.name) && !unavailableLanes.has(lane.name)) {
      await recovery.waitUntilReady();
      if (stopRequested || queue.isClosed() || blockedLanes.has(lane.name) || unavailableLanes.has(lane.name)) return;
      const shard = await queue.take();
      if (!shard) return;
      let requeue: CommentTimeShard[] = [];
      let laneRequestActive = false;
      try {
        if (blockedLanes.has(lane.name) || unavailableLanes.has(lane.name)) {
          requeue = stopRequested ? [] : [shard];
          return;
        }
        laneRequestActive = true;
        activeLaneRequests.set(lane.name, (activeLaneRequests.get(lane.name) ?? 0) + 1);
        requeue = await scanShardPage(lane, workerId, shard);
        recovery.recordSuccess();
        unavailableLanes.delete(lane.name);
      } catch (error) {
        if (error instanceof CooldownRequired) {
          blockedLanes.add(lane.name);
          unavailableLanes.delete(lane.name);
          requeue = shard.done ? [] : [shard];
          return;
        }
        if (error instanceof LaneRequestFailure) {
          recovery.recordFailure();
          requeue = shard.done ? [] : [shard];
          if (recovery.failureCount >= MAX_CONSECUTIVE_LANE_FAILURES) {
            if (!blockedLanes.has(lane.name)) unavailableLanes.add(lane.name);
            return;
          }
          continue;
        }
        if (error instanceof RequestBudgetExhausted) {
          budgetReached = true;
          stopScheduling();
          return;
        }
        if (error instanceof RunCancelled) {
          cancelled = true;
          stopScheduling();
          return;
        }
        fatalError = error;
        stopScheduling();
        return;
      } finally {
        if (laneRequestActive) {
          activeLaneRequests.set(lane.name, Math.max(0, (activeLaneRequests.get(lane.name) ?? 1) - 1));
        }
        maybeStopAfterLaneRequests();
        if (stopRequested) requeue = [];
        queue.complete(requeue.length > 0 ? requeue : undefined);
      }
    }
  };

  const workers = lanes.flatMap((lane) =>
    Array.from({ length: options.workersPerLane }, (_, workerIndex) => runWorker(lane, workerIndex))
  );
  try {
    await Promise.all(workers);
  } finally {
    options.signal?.removeEventListener("abort", abortListener);
  }
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
    : blockedLanes.size === lanes.length
    ? "cooldown"
    : "paused";
  const note = [
    budgetReached ? "The page or request budget was reached; rerun the same command to resume." : undefined,
    blockedLanes.size > 0 ? `Cooldown lanes: ${[...blockedLanes].join(", ")}.` : undefined,
    unavailableLanes.size > 0 ? `Paused after repeated network failures on lanes: ${[...unavailableLanes].join(", ")}.` : undefined,
    matched && options.stopAfterFirst ? "Stopped after the first matching comment." : undefined,
  ].filter(Boolean).join(" ") || undefined;
  return makeReport(status, state, lanes, options, initialRequests, startedAt, note);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publishRequestActivity(
  options: ParallelSongScanOptions,
  activity: Parameters<NonNullable<ParallelSongScanOptions["onRequestActivity"]>>[0],
): void {
  try {
    options.onRequestActivity?.(activity);
  } catch {
    // Diagnostic logging must never interrupt the scan.
  }
}

function publishCheckpointProgress(
  options: ParallelSongScanOptions,
  state: ParallelSongScanState,
): void {
  try {
    options.onCheckpoint?.({
      shards: state.shards.length,
      shardsComplete: state.shards.filter((shard) => shard.done).length,
      coveragePercent: timeCoveragePercent(state.startTime, state.endTime, state.shards),
      pagesProcessed: state.pagesProcessed,
      commentsInspected: state.commentsInspected,
      totalComments: state.totalComments,
      matches: state.matchCount,
      requestsTotal: state.requestCount,
    });
  } catch {
    // Status delivery must never interrupt the scan.
  }
}

function publishSchedulerActivity(
  options: ParallelSongScanOptions,
  activity: Parameters<NonNullable<ParallelSongScanOptions["onSchedulerActivity"]>>[0],
): void {
  try {
    options.onSchedulerActivity?.(activity);
  } catch {
    // Diagnostic logging must never interrupt the scan.
  }
}

function remoteStatus(error: unknown): number | undefined {
  if (error instanceof CooldownRequired) return error.status;
  if (!error || typeof error !== "object") return undefined;
  const value = error as { status?: unknown; body?: { code?: unknown } };
  if (typeof value.status === "number") return value.status;
  return typeof value.body?.code === "number" ? value.body.code : undefined;
}

export { createTimeShards } from "./time-shards";

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
  return readAtomicJson(path, (value) => {
    const state = value as ParallelSongScanState;
    if (state.version !== 1 || state.kind !== "parallel-song") {
      throw new Error("Unsupported parallel scan state.");
    }
    return state;
  });
}

async function saveParallelState(path: string, state: ParallelSongScanState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeAtomicJson(path, state);
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
    totalComments: state.totalComments,
    matches: state.matchCount,
    requestsThisRun,
    requestsTotal: initialRequests + requestsThisRun,
    elapsedMs: Date.now() - startedAt,
    statePath: options.statePath,
    outputPath: options.outputPath,
    note,
  };
}
