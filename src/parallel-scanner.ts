import { readAtomicJson, writeAtomicJson } from "./atomic-file";
import {
  CooldownRequired,
  RequestBudgetExhausted,
  RunCancelled,
} from "./errors";
import { RequestGovernor } from "./governor";
import { CheckpointCoordinator } from "./checkpoint-coordinator";
import { LaneRecovery } from "./lane-recovery";
import { LaneAllocator } from "./lane-allocator";
import { executeProxyRequest, type ProxyTransportGate } from "./proxy-transport-gate";
import { mergeCommentTotal, timeCoveragePercent } from "./progress";
import { ResultAccumulator } from "./result-accumulator";
import { JsonlResultWriter } from "./results";
import { nextDescendingCursor } from "./cursor-pagination";
import { AsyncWorkQueue } from "./work-queue";
import { createTimeShards, splitRemainingTimeShard } from "./time-shards";
import { workerCountForTopology } from "./worker-topology";
import {
  commentFloorsComplete,
  pendingCommentFloorRoots,
  processCommentFloors,
  COMMENT_FLOOR_PAGE_SIZE,
  normalizeCommentFloorThreads,
} from "./comment-floor";
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
  const workerCount = workerCountForTopology(lanes.length, options.workersPerLane, options.maxWorkers);
  const transportCapacity = lanes.reduce((capacity, lane) =>
    Math.min(capacity, lane.transportGate?.currentMaxConcurrent ?? capacity), workerCount);
  const initialShardCount = Math.max(1, Math.min(options.shardCount, workerCount, transportCapacity));
  const state = loaded ?? createParallelState(options, initialShardCount);
  const initialRequests = state.requestCount;
  const writer = new JsonlResultWriter(options.outputPath, options.onMatch);
  await writer.initialize();
  const results = new ResultAccumulator(writer, state);

  const checkpointCoordinator = new CheckpointCoordinator({
    state: () => state,
    reconcile: () => {
      state.requestCount = initialRequests + requestsUsed(lanes);
    },
    publish: () => publishCheckpointProgress(options, state),
    persist: (snapshot) => saveParallelState(options.statePath, snapshot),
    liveIntervalMs: 200,
    persistIntervalMs: 500,
  });
  const checkpoint = (force = false): Promise<void> => checkpointCoordinator.checkpoint(force);
  publishCheckpointProgress(options, state);

  try {
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

    const initialRootWork = state.shards
      .filter((shard) => !shard.done)
      .sort((left, right) => right.endTime - left.endTime);
    const queue = new AsyncWorkQueue(
      initialRootWork.length === 0 && !commentFloorsComplete(state.floorThreads) && state.shards[0]
        ? [state.shards[0]]
        : initialRootWork,
    );
    const blockedLanes = new Set<string>();
    const unavailableLanes = new Set<string>();
    const laneRecovery = new Map(lanes.map((lane) => [lane.name, new LaneRecovery()]));
    const activeLaneRequests = new Map(lanes.map((lane) => [lane.name, 0]));
    const laneAllocator = new LaneAllocator(
      lanes,
      options.workersPerLane,
      (lane) => !blockedLanes.has(lane.name) && !unavailableLanes.has(lane.name),
      (lane) => laneRecovery.get(lane.name)!.ready,
      () => [...activeLaneRequests.values()].some((count) => count > 0),
    );
    const initialPages = state.pagesProcessed;
    let scheduledRequests = 0;
    let scheduledRootPages = 0;
    let stopRequested = false;
    let matched = false;
    let budgetReached = false;
    let cancelled = false;
    let fatalError: unknown;
    const floorThreadTasks = new Map<string, Promise<void>>();
    const reservedFloorPages = new Set<string>();
    const reservedRootPages = new Set<string>();
    let nextShardId = state.shards.reduce((maximum, shard) => Math.max(maximum, shard.id), -1) + 1;
    const allLanesUnavailable = (): boolean => lanes.every((lane) =>
      blockedLanes.has(lane.name) || unavailableLanes.has(lane.name)
    );

    const stopScheduling = (): void => {
      stopRequested = true;
      laneAllocator.cancel();
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
      laneAllocator.cancel();
      for (const recovery of laneRecovery.values()) recovery.cancel();
    });

    const reserveRequest = (rootPage: boolean): boolean => {
      if (stopRequested) return false;
      if (rootPage && options.maxPages > 0 && initialPages + scheduledRootPages >= options.maxPages) {
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
      if (rootPage) scheduledRootPages += 1;
      return true;
    };

    const reserveFloorRequest = (taskKey: string): boolean => {
      if (reservedFloorPages.has(taskKey)) return true;
      if (!reserveRequest(false)) return false;
      reservedFloorPages.add(taskKey);
      return true;
    };

    const reserveRootRequest = (taskKey: string): boolean => {
      if (stopRequested) return false;
      if (reservedRootPages.has(taskKey)) return true;
      if (!reserveRequest(true)) return false;
      reservedRootPages.add(taskKey);
      return true;
    };

    const scanPendingFloorPage = async (
      lane: ParallelCommentLane,
      workerId: string,
      shardId?: number,
    ): Promise<"none" | "processed" | "matched"> => {
      const root = pendingCommentFloorRoots(state.floorThreads)[0];
      if (!root) return "none";
      const current = floorThreadTasks.get(root.commentId);
      if (current) {
        try {
          await current;
        } catch (error) {
          if (!(error instanceof LaneRequestFailure || error instanceof CooldownRequired)) throw error;
        }
        return scanPendingFloorPage(lane, workerId, shardId);
      }
      let pageMatched = false;
      const task = processCommentFloors({
        roots: [root],
        threads: state.floorThreads,
        fetchPage: async (_root, thread) => {
          if (!lane.client.getCommentFloor) throw new Error("Comment floor API is unavailable on this lane.");
          if (!reserveFloorRequest(root.commentId)) throw new RequestBudgetExhausted(options.requestBudget);
          const startedAt = Date.now();
          const activity = {
            lane: lane.name,
            workerId,
            operation: "comment-floor" as const,
            songId: options.songId,
            songName: options.songName,
            page: thread.pageNo,
            parentCommentId: root.commentId,
            shardId,
            startedAt: new Date(startedAt).toISOString(),
          };
          publishRequestActivity(options, { ...activity, phase: "start" });
          let attempts = 0;
          let networkElapsedMs = 0;
          try {
            const page = await executeProxyRequest(lane, `comment_floor:${options.songId}:${root.commentId}`, async () => {
              attempts += 1;
              const networkStartedAt = Date.now();
              try {
                return await lane.client.getCommentFloor!(
                  options.songId,
                  root.commentId,
                  COMMENT_FLOOR_PAGE_SIZE,
                  thread.nextTime,
                );
              } finally {
                networkElapsedMs += Date.now() - networkStartedAt;
              }
            });
            publishRequestActivity(options, {
              ...activity,
              phase: "success",
              elapsedMs: Date.now() - startedAt,
              networkElapsedMs,
              attempts,
              comments: page.comments.length,
              effectiveComments: page.comments.length,
              totalComments: page.total,
              hasMore: page.hasMore,
            });
            return page;
          } catch (error) {
            const status = remoteStatus(error);
            publishRequestActivity(options, {
              ...activity,
              phase: "failure",
              elapsedMs: Date.now() - startedAt,
              networkElapsedMs,
              attempts,
              status,
              rateLimited: error instanceof CooldownRequired || status === 403 || status === 429,
              error: errorMessage(error),
            });
            if (error instanceof CooldownRequired || error instanceof RequestBudgetExhausted || error instanceof RunCancelled) throw error;
            throw new LaneRequestFailure(lane.name, error);
          }
        },
        persistPage: async (_root, _thread, page) => {
          const records = page.comments
            .filter((comment) => comment.userId === options.uid)
            .map<FoundComment>((comment) => ({
              ...comment,
              songId: options.songId,
              songName: options.songName,
              route: "song-comment-floor",
              capturedAt: new Date().toISOString(),
            }));
          for (const record of records) {
            const outcome = await results.record(record);
            pageMatched ||= outcome.counted;
          }
        },
        checkpointPage: async (_root, _thread, page) => {
          state.floorPagesProcessed += 1;
          state.replyCommentsInspected += page.comments.length;
          state.finished = Boolean(state.rootDone) && commentFloorsComplete(state.floorThreads);
          await checkpoint(true);
          reservedFloorPages.delete(root.commentId);
          if (pageMatched && options.stopAfterFirst) {
            matched = true;
            stopScheduling();
          }
        },
        shouldStopAfterPage: () => true,
      }).finally(() => floorThreadTasks.delete(root.commentId));
      floorThreadTasks.set(root.commentId, task);
      await task;
      return pageMatched && options.stopAfterFirst ? "matched" : "processed";
    };

    const scanShardPage = async (
      lane: ParallelCommentLane,
      workerId: string,
      shard: CommentTimeShard,
    ): Promise<CommentTimeShard[]> => {
      if (stopRequested) return [];
      const pendingFloor = await scanPendingFloorPage(lane, workerId, shard.id);
      if (pendingFloor === "matched") return [];
      if (pendingFloor === "processed") return shard.done && commentFloorsComplete(state.floorThreads) ? [] : [shard];
      const requestedCursor = shard.cursor;
      const rootTaskKey = `${shard.id}:${shard.pageNo}:${requestedCursor}`;
      if (shard.done || !reserveRootRequest(rootTaskKey)) return [];
      const requestStartedAt = Date.now();
      const requestActivity = {
        lane: lane.name,
        workerId,
        operation: "comment-page" as const,
        songId: options.songId,
        songName: options.songName,
        page: shard.pageNo,
        shardId: shard.id,
        startedAt: new Date(requestStartedAt).toISOString(),
      };
      publishRequestActivity(options, { ...requestActivity, phase: "start" });
      let attempts = 0;
      let networkElapsedMs = 0;
      let page;
      try {
        page = await executeProxyRequest(
          lane,
          `comment_new:${options.songId}:shard-${shard.id}`,
          async () => {
            attempts += 1;
            const networkStartedAt = Date.now();
            try {
              return await lane.client.getSongCommentsByCursor(
                options.songId,
                options.pageSize,
                shard.pageNo,
                requestedCursor,
              );
            } finally {
              networkElapsedMs += Date.now() - networkStartedAt;
            }
          },
        );
      } catch (error) {
        const status = remoteStatus(error);
        publishRequestActivity(options, {
          ...requestActivity,
          phase: "failure",
          elapsedMs: Date.now() - requestStartedAt,
          networkElapsedMs,
          attempts,
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
      const times = page.comments
        .map((comment) => comment.time)
        .filter((time): time is number => time !== undefined);
      const oldestTime = times.length > 0 ? Math.min(...times) : undefined;
      const crossedShardStart = oldestTime !== undefined && oldestTime < shard.startTime;
      let nextCursor: string | undefined;
      try {
        nextCursor = crossedShardStart
          ? undefined
          : nextDescendingCursor(
            page.hasMore,
            page.nextCursor,
            requestedCursor,
            `parallel shard ${shard.id} for song ${options.songId}`,
          );
      } catch (error) {
        publishRequestActivity(options, {
          ...requestActivity,
          phase: "failure",
          elapsedMs: Date.now() - requestStartedAt,
          networkElapsedMs,
          attempts,
          status: 502,
          error: errorMessage(error),
        });
        throw error;
      }
      const rangedComments = page.comments.filter((comment) =>
        comment.time === undefined ||
        (comment.time >= shard.startTime && comment.time < shard.endTime)
      );
      publishRequestActivity(options, {
        ...requestActivity,
        phase: "success",
        elapsedMs: Date.now() - requestStartedAt,
        networkElapsedMs,
        attempts,
        comments: page.comments.length,
        effectiveComments: rangedComments.length,
        totalComments: page.total,
        hasMore: page.hasMore,
      });
      const rootRecords = rangedComments
        .filter((comment) => comment.userId === options.uid)
        .map<FoundComment>((comment) => ({
          ...comment,
          songId: options.songId,
          songName: options.songName,
          route: "song-comments",
          capturedAt: new Date().toISOString(),
        }));
      for (const record of rootRecords) {
        const outcome = await results.record(record);
        if (options.stopAfterFirst && outcome.counted) {
          matched = true;
          await checkpoint(true);
          stopScheduling();
          return [];
        }
      }
      let floorMatched = false;
      const processRootFloor = async (root: typeof rangedComments[number]): Promise<void> => {
        const current = floorThreadTasks.get(root.commentId);
        if (current) {
          try {
            await current;
          } catch (error) {
            if (!(error instanceof LaneRequestFailure || error instanceof CooldownRequired)) throw error;
          }
          return processRootFloor(root);
        }
        const task = processCommentFloors({
          roots: [root],
          threads: state.floorThreads,
          fetchPage: async (_root, thread) => {
        if (!lane.client.getCommentFloor) throw new Error("Comment floor API is unavailable on this lane.");
        if (!reserveFloorRequest(root.commentId)) throw new RequestBudgetExhausted(options.requestBudget);
        const floorStartedAt = Date.now();
        const floorActivity = {
          lane: lane.name,
          workerId,
          operation: "comment-floor" as const,
          songId: options.songId,
          songName: options.songName,
          page: thread.pageNo,
          parentCommentId: root.commentId,
          shardId: shard.id,
          startedAt: new Date(floorStartedAt).toISOString(),
        };
        publishRequestActivity(options, { ...floorActivity, phase: "start" });
        let floorAttempts = 0;
        let floorNetworkElapsedMs = 0;
        try {
          const floorResult = await executeProxyRequest(
            lane,
            `comment_floor:${options.songId}:${root.commentId}`,
            async () => {
              floorAttempts += 1;
              const networkStartedAt = Date.now();
              try {
                return await lane.client.getCommentFloor!(
                  options.songId,
                  root.commentId,
                  COMMENT_FLOOR_PAGE_SIZE,
                  thread.nextTime,
                );
              } finally {
                floorNetworkElapsedMs += Date.now() - networkStartedAt;
              }
            },
          );
          publishRequestActivity(options, {
            ...floorActivity,
            phase: "success",
            elapsedMs: Date.now() - floorStartedAt,
            networkElapsedMs: floorNetworkElapsedMs,
            attempts: floorAttempts,
            comments: floorResult.comments.length,
            effectiveComments: floorResult.comments.length,
            totalComments: floorResult.total,
            hasMore: floorResult.hasMore,
          });
          return floorResult;
        } catch (error) {
          const status = remoteStatus(error);
          publishRequestActivity(options, {
            ...floorActivity,
            phase: "failure",
            elapsedMs: Date.now() - floorStartedAt,
            networkElapsedMs: floorNetworkElapsedMs,
            attempts: floorAttempts,
            status,
            rateLimited: error instanceof CooldownRequired || status === 403 || status === 429,
            error: errorMessage(error),
          });
          if (error instanceof CooldownRequired || error instanceof RequestBudgetExhausted || error instanceof RunCancelled) {
            throw error;
          }
          throw new LaneRequestFailure(lane.name, error);
          }
          },
          persistPage: async (_root, _thread, floorPage) => {
            const records = floorPage.comments
              .filter((comment) => comment.userId === options.uid)
              .map<FoundComment>((comment) => ({
                ...comment,
                songId: options.songId,
                songName: options.songName,
                route: "song-comment-floor",
                capturedAt: new Date().toISOString(),
              }));
            for (const record of records) {
              const outcome = await results.record(record);
              floorMatched ||= outcome.counted;
            }
          },
          checkpointPage: async (_root, _thread, floorPage) => {
            state.floorPagesProcessed += 1;
            state.replyCommentsInspected += floorPage.comments.length;
            await checkpoint(true);
            reservedFloorPages.delete(root.commentId);
            if (floorMatched && options.stopAfterFirst) {
              matched = true;
              stopScheduling();
            }
          },
          shouldStopAfterPage: () => floorMatched && options.stopAfterFirst,
        }).finally(() => floorThreadTasks.delete(root.commentId));
        floorThreadTasks.set(root.commentId, task);
        await task;
      };
      for (const root of rangedComments) {
        await processRootFloor(root);
        if (floorMatched && options.stopAfterFirst) break;
      }
      if (floorMatched && options.stopAfterFirst) return [];

      shard.pagesProcessed += 1;
      shard.pageNo += 1;
      state.pagesProcessed += 1;
      state.commentsInspected += rangedComments.length;
      state.totalComments = mergeCommentTotal(state.totalComments, page.total, parallelCommentsInspected(state));

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
      reservedRootPages.delete(rootTaskKey);
      return stopRequested ? [] : nextWork;
    };

    const runWorker = async (workerIndex: number): Promise<void> => {
      const workerId = `worker-${workerIndex + 1}`;
      while (!stopRequested) {
        const permit = await laneAllocator.acquire();
        if (!permit) return;
        const lane = permit.lane;
        const recovery = laneRecovery.get(lane.name)!;
        if (stopRequested || queue.isClosed()) {
          permit.release();
          return;
        }
        const shard = await queue.take();
        if (!shard) {
          permit.release();
          return;
        }
        let requeue: CommentTimeShard[] = [];
        let laneRequestActive = false;
        try {
          if (blockedLanes.has(lane.name) || unavailableLanes.has(lane.name)) {
            requeue = stopRequested ? [] : [shard];
            continue;
          }
          laneRequestActive = true;
          activeLaneRequests.set(lane.name, (activeLaneRequests.get(lane.name) ?? 0) + 1);
          if (!recovery.ready) {
            requeue = [shard];
            continue;
          }
          requeue = await scanShardPage(lane, workerId, shard);
          recovery.recordSuccess();
          unavailableLanes.delete(lane.name);
          laneAllocator.notify();
        } catch (error) {
          if (error instanceof CooldownRequired) {
            blockedLanes.add(lane.name);
            unavailableLanes.delete(lane.name);
            laneAllocator.notify();
            requeue = shard.done ? [] : [shard];
            continue;
          }
          if (error instanceof LaneRequestFailure) {
            const retryAfterMs = recovery.recordFailure();
            const recoveryTimer = setTimeout(() => laneAllocator.notify(), retryAfterMs);
            recoveryTimer.unref?.();
            requeue = shard.done ? [] : [shard];
            if (recovery.failureCount >= MAX_CONSECUTIVE_LANE_FAILURES) {
              if (!blockedLanes.has(lane.name)) unavailableLanes.add(lane.name);
              laneAllocator.notify();
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
          permit.release();
          maybeStopAfterLaneRequests();
          if (stopRequested) requeue = [];
          queue.complete(requeue.length > 0 ? requeue : undefined);
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: workerCount }, (_, workerIndex) =>
        runWorker(workerIndex)
      ));
    } finally {
      options.signal?.removeEventListener("abort", abortListener);
    }
    await checkpoint(true);
    if (fatalError) throw fatalError;

    state.rootDone = state.shards.every((shard) => shard.done);
    state.finished = state.rootDone && commentFloorsComplete(state.floorThreads);
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
  } finally {
    checkpointCoordinator.dispose();
    await writer.close();
  }
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
    const rootDone = Boolean(state.rootDone) || state.shards.every((shard) => shard.done);
    options.onCheckpoint?.({
      shards: state.shards.length,
      shardsComplete: state.shards.filter((shard) => shard.done).length,
      coveragePercent: timeCoveragePercent(state.startTime, state.endTime, state.shards),
      coverageComplete: rootDone && commentFloorsComplete(state.floorThreads),
      pagesProcessed: state.pagesProcessed,
      floorPagesProcessed: state.floorPagesProcessed,
      commentsInspected: parallelCommentsInspected(state),
      replyCommentsInspected: state.replyCommentsInspected,
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

function createParallelState(
  options: ParallelSongScanOptions,
  initialShardCount: number,
): ParallelSongScanState {
  const now = new Date().toISOString();
  return {
    version: 2,
    kind: "parallel-song",
    uid: options.uid,
    songId: options.songId,
    songName: options.songName,
    startTime: options.startTime,
    endTime: options.endTime,
    shardCount: options.shardCount,
    pageSize: options.pageSize,
    // shardCount remains the user's configured compatibility key. A fresh run
    // only materializes enough shards to occupy real workers; busy workers can
    // split remaining ranges adaptively without paying dozens of empty boundary
    // requests up front.
    shards: createTimeShards(options.startTime, options.endTime, initialShardCount),
    pagesProcessed: 0,
    floorPagesProcessed: 0,
    commentsInspected: 0,
    replyCommentsInspected: 0,
    floorThreads: [],
    rootDone: false,
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
    if (state.version !== 2 || state.kind !== "parallel-song") {
      throw new Error("Unsupported parallel scan state.");
    }
    state.floorThreads = normalizeCommentFloorThreads(state.floorThreads);
    state.rootDone ??= state.shards.every((shard) => shard.done);
    state.finished = state.rootDone && commentFloorsComplete(state.floorThreads);
    if (!Number.isInteger(state.floorPagesProcessed) || state.floorPagesProcessed < 0 ||
      !Number.isInteger(state.replyCommentsInspected) || state.replyCommentsInspected < 0) {
      throw new Error("Invalid parallel comment floor checkpoint.");
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

function parallelCommentsInspected(state: ParallelSongScanState): number {
  return state.commentsInspected + state.replyCommentsInspected;
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
    workers: workerCountForTopology(lanes.length, options.workersPerLane, options.maxWorkers),
    shards: state.shards.length,
    shardsComplete: state.shards.filter((shard) => shard.done).length,
    coverageComplete: state.finished,
    pagesProcessed: state.pagesProcessed,
    floorPagesProcessed: state.floorPagesProcessed,
    commentsInspected: parallelCommentsInspected(state),
    replyCommentsInspected: state.replyCommentsInspected,
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
