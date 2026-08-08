import {
  CooldownRequired,
  RequestBudgetExhausted,
  RunCancelled,
  errorStatus,
} from "../errors";
import { LaneRecovery } from "../lane-recovery";
import { LaneAllocator } from "../lane-allocator";
import { AsyncWorkQueue } from "../work-queue";
import { workerCountForTopology } from "../worker-topology";
import {
  QQ_MUSIC_COMMENT_PAGE_SIZE_MAX,
  QQMusicApiError,
  QQMusicProtocolError,
} from "./client";
import { QQMusicProxyError } from "./proxy-fetch";
import {
  QQMusicResultPersistenceError,
  QQMusicResultWriter,
} from "./result-writer";
import { loadQQMusicScanState, qqMusicCommentKey, saveQQMusicScanState } from "./state";
import { cancelQQMusicLanes } from "./transport-gate";
import type {
  QQCommentLane,
  QQMusicCheckpointActivity,
  QQMusicFoundComment,
  QQMusicRequestActivity,
  QQMusicScanOptions,
  QQMusicScanReport,
  QQMusicScanState,
  QQMusicSong,
  QQMusicSongActivity,
  QQMusicSongProgress,
} from "./types";

type StopReason = "matched" | "paused" | "cooldown" | "stopped";
type LaneBlockReason = "paused" | "cooldown" | "stopped" | "unavailable";
const LIKES_CHECKPOINT_INTERVAL_MS = 400;
const LIKES_CHECKPOINT_PAGE_CAP = 4;
const MAX_CONSECUTIVE_LANE_FAILURES = 5;

interface LaneRuntime {
  lane: QQCommentLane;
  recovery: LaneRecovery;
  blocked?: LaneBlockReason;
  cooldownUntil?: number;
  activeRequests: number;
}

interface ActiveRequestTracker {
  seenWorkers: Set<string>;
  seenLanes: Set<string>;
}

export interface QQMusicScannerRuntime {
  createResultWriter: (
    path: string,
    onMatch?: (comment: QQMusicFoundComment) => void,
  ) => QQMusicResultWriter;
  saveState?: (path: string, state: QQMusicScanState) => Promise<void>;
}

const defaultScannerRuntime: QQMusicScannerRuntime = {
  createResultWriter: (path, onMatch) => new QQMusicResultWriter(path, onMatch),
};

class QQMusicCheckpointError extends Error {
  constructor(public readonly cause: unknown) {
    super(`QQ Music checkpoint failed: ${message(cause)}`);
    this.name = "QQMusicCheckpointError";
  }
}

export async function runQQMusicScan(
  lanes: QQCommentLane[],
  options: QQMusicScanOptions,
  scannerRuntime: QQMusicScannerRuntime = defaultScannerRuntime,
): Promise<QQMusicScanReport> {
  validateLanes(lanes);
  const startedAt = Date.now();
  const requestStarts = new Map(lanes.map((lane) => [lane, lane.governor.requestsUsed]));
  const runtimes: LaneRuntime[] = lanes.map((lane) => ({
    lane,
    recovery: new LaneRecovery(),
    activeRequests: 0,
  }));
  const tracker: ActiveRequestTracker = {
    seenWorkers: new Set(),
    seenLanes: new Set(),
  };
  let state = options.fresh ? undefined : await loadQQMusicScanState(options.statePath);
  let migratedLegacyCommentPageSize = false;
  if (state) {
    // SeqNo is the authoritative continuation cursor. Old clients allowed a
    // PageSize that the current endpoint rejects, so shrink only that request
    // batch while retaining pageNo, cursor, seen IDs and durable JSONL output.
    if (state.pageSize > QQ_MUSIC_COMMENT_PAGE_SIZE_MAX) {
      state.pageSize = QQ_MUSIC_COMMENT_PAGE_SIZE_MAX;
      migratedLegacyCommentPageSize = true;
    }
    options = {
      ...options,
      pageSize: state.pageSize,
      likedPageSize: state.likedPageSize,
    };
    validateResume(state, options);
  }
  validateOptions(options);
  const writer = scannerRuntime.createResultWriter(options.outputPath, options.onMatch);
  await writer.initialize();
  const priorRequestCount = state?.requestCount ?? 0;
  let stopReason: StopReason | undefined;
  let stopNote: string | undefined;
  let persistenceFailed = false;
  let persistenceError: QQMusicCheckpointError | QQMusicResultPersistenceError | undefined;
  let activeQueue: AsyncWorkQueue<number> | undefined;
  let activeLaneAllocator: LaneAllocator<LaneRuntime> | undefined;
  let checkpointRevision = 0;
  let persistedRevision = 0;
  let dirtyPageCount = 0;
  let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  let flushRequested = false;
  let flushLoop: Promise<void> | undefined;
  const revisionWaiters: Array<{
    revision: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  const requestsThisRun = (): number => lanes.reduce(
    (sum, lane) => sum + lane.governor.requestsUsed - (requestStarts.get(lane) ?? 0),
    0,
  );

  const updateCompletion = (): void => {
    if (!state) return;
    state.finished = state.sourceLoaded && state.songs.every((song) => song.done);
    state.coverageComplete = state.finished
      && !state.sourceTruncated
      && state.songs.every((song) => !song.truncated);
  };

  const stopFor = (reason: StopReason, note?: string): void => {
    if (stopReason) return;
    stopReason = reason;
    stopNote = note;
    if (reason === "cooldown" && state) {
      const resumeTimes = runtimes
        .map((runtime) => runtime.cooldownUntil)
        .filter((value): value is number => value !== undefined);
      if (resumeTimes.length > 0) {
        state.cooldownUntil = new Date(Math.min(...resumeTimes)).toISOString();
      }
    }
    for (const runtime of runtimes) runtime.recovery.cancel();
    activeLaneAllocator?.cancel();
    activeQueue?.stop();
    cancelQQMusicLanes(lanes);
  };

  const stopForPersistence = (error: unknown): void => {
    if (persistenceFailed) return;
    persistenceFailed = true;
    persistenceError = error instanceof QQMusicCheckpointError
      || error instanceof QQMusicResultPersistenceError
      ? error
      : new QQMusicCheckpointError(error);
    stopReason = "paused";
    stopNote = message(persistenceError);
    if (checkpointTimer) clearTimeout(checkpointTimer);
    checkpointTimer = undefined;
    for (const runtime of runtimes) runtime.recovery.cancel();
    activeLaneAllocator?.cancel();
    cancelQQMusicLanes(lanes);
    activeQueue?.stop();
    for (const waiter of revisionWaiters.splice(0)) waiter.reject(persistenceError);
  };

  const resolveRevisionWaiters = (): void => {
    for (let index = revisionWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = revisionWaiters[index];
      if (waiter.revision > persistedRevision) continue;
      revisionWaiters.splice(index, 1);
      waiter.resolve();
    }
  };

  const snapshotState = (): QQMusicScanState => {
    updateCompletion();
    state!.requestCount = priorRequestCount + requestsThisRun();
    state!.updatedAt = new Date().toISOString();
    return structuredClone(state!);
  };

  const startFlush = (): Promise<void> => {
    flushRequested = true;
    if (checkpointTimer) clearTimeout(checkpointTimer);
    checkpointTimer = undefined;
    if (flushLoop) return flushLoop;
    flushLoop = (async () => {
      try {
        while (!persistenceFailed && checkpointRevision > persistedRevision) {
          flushRequested = false;
          const revision = checkpointRevision;
          dirtyPageCount = 0;
          const snapshot = snapshotState();
          const activity = checkpointActivity(snapshot);
          try { options.onCheckpoint?.(activity); } catch { /* Status callbacks are best-effort. */ }
          await (scannerRuntime.saveState ?? saveQQMusicScanState)(options.statePath, snapshot);
          persistedRevision = revision;
          resolveRevisionWaiters();
          if (!flushRequested) break;
        }
      } catch (error) {
        const checkpointError = error instanceof QQMusicCheckpointError
          ? error
          : new QQMusicCheckpointError(error);
        stopForPersistence(checkpointError);
        throw checkpointError;
      } finally {
        flushLoop = undefined;
        if (
          !persistenceFailed
          && checkpointRevision > persistedRevision
          && !checkpointTimer
        ) {
          checkpointTimer = setTimeout(() => {
            checkpointTimer = undefined;
            void startFlush().catch(() => {});
          }, LIKES_CHECKPOINT_INTERVAL_MS);
        }
      }
    })();
    return flushLoop;
  };

  const scheduleFlush = (): void => {
    if (checkpointTimer || flushRequested || persistenceFailed) return;
    checkpointTimer = setTimeout(() => {
      checkpointTimer = undefined;
      void startFlush().catch(() => {});
    }, LIKES_CHECKPOINT_INTERVAL_MS);
  };

  const waitForRevision = (revision: number): Promise<void> => {
    if (persistenceFailed) return Promise.reject(persistenceError);
    if (persistedRevision >= revision) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      revisionWaiters.push({ revision, resolve, reject });
    });
  };

  const forceCheckpoint = async (): Promise<void> => {
    if (persistenceFailed) throw persistenceError!;
    const revision = ++checkpointRevision;
    const waiting = waitForRevision(revision);
    void startFlush().catch(() => {});
    await waiting;
  };

  const checkpointCommentPage = async (): Promise<void> => {
    if (options.mode === "song") {
      await forceCheckpoint();
      return;
    }
    if (persistenceFailed) throw persistenceError!;
    const revision = ++checkpointRevision;
    dirtyPageCount += 1;
    const waiting = waitForRevision(revision);
    if (taskSignal.aborted || dirtyPageCount >= LIKES_CHECKPOINT_PAGE_CAP) {
      void startFlush().catch(() => {});
    } else {
      scheduleFlush();
    }
    await waiting;
  };

  const flushPendingCheckpoint = (): void => {
    if (persistenceFailed || checkpointRevision <= persistedRevision) return;
    void startFlush().catch(() => {});
  };
  const taskSignal = lanes[0].transportGate.signal;
  const abortFromExternalSignal = (): void => cancelQQMusicLanes(lanes);
  options.signal?.addEventListener("abort", abortFromExternalSignal, { once: true });
  if (options.signal?.aborted) abortFromExternalSignal();
  const abortRuntimeWaits = (): void => {
    for (const runtime of runtimes) runtime.recovery.cancel();
    activeLaneAllocator?.cancel();
    activeQueue?.stop();
  };
  taskSignal.addEventListener("abort", abortRuntimeWaits, { once: true });
  taskSignal.addEventListener("abort", flushPendingCheckpoint);
  const cleanup = async (): Promise<void> => {
    taskSignal.removeEventListener("abort", abortRuntimeWaits);
    taskSignal.removeEventListener("abort", flushPendingCheckpoint);
    options.signal?.removeEventListener("abort", abortFromExternalSignal);
    // A persistence failure rejects revision waiters immediately so Workers can
    // stop, but an atomic checkpoint write may still be inside its async I/O.
    // Drain that exact write before returning so an old task can never overwrite
    // a resume task's newer checkpoint after its lifecycle has ended.
    await flushLoop?.catch(() => {});
    await writer.close();
  };
  const finishReport = async (value: QQMusicScanReport): Promise<QQMusicScanReport> => {
    await cleanup();
    return value;
  };
  let availableCheckpointSlots = LIKES_CHECKPOINT_PAGE_CAP;
  const checkpointSlotWaiters: Array<{
    grant: (release: () => void) => void;
    reject: (error: unknown) => void;
    abort: () => void;
  }> = [];
  const releaseCheckpointSlot = (): void => {
    while (checkpointSlotWaiters.length > 0) {
      const waiter = checkpointSlotWaiters.shift()!;
      taskSignal.removeEventListener("abort", waiter.abort);
      if (taskSignal.aborted) {
        waiter.reject(new RunCancelled());
        continue;
      }
      waiter.grant(releaseCheckpointSlot);
      return;
    }
    availableCheckpointSlots += 1;
  };
  const acquireCheckpointSlot = (): Promise<() => void> => {
    if (options.mode === "song") return Promise.resolve(() => {});
    if (taskSignal.aborted) return Promise.reject(new RunCancelled());
    if (availableCheckpointSlots > 0) {
      availableCheckpointSlots -= 1;
      return Promise.resolve(releaseCheckpointSlot);
    }
    return new Promise<() => void>((grant, reject) => {
      const waiter = {
        grant,
        reject,
        abort: (): void => {
          const index = checkpointSlotWaiters.indexOf(waiter);
          if (index >= 0) checkpointSlotWaiters.splice(index, 1);
          reject(new RunCancelled());
        },
      };
      checkpointSlotWaiters.push(waiter);
      taskSignal.addEventListener("abort", waiter.abort, { once: true });
    });
  };

  const executeControl = async <T>(
    label: string,
    request: (lane: QQCommentLane) => Promise<T>,
  ): Promise<T> => {
    let lastError: unknown;
    for (const runtime of runtimes) {
      if (runtime.blocked) continue;
      try {
        await runtime.recovery.waitUntilReady();
        if (runtime.lane.transportGate.isCancelled) throw new RunCancelled();
        const result = await executeLane(runtime.lane, label, () => request(runtime.lane));
        runtime.recovery.recordSuccess();
        return result;
      } catch (error) {
        lastError = error;
        if (isPermanentLaneError(error)) {
          runtime.blocked = "unavailable";
          continue;
        }
        const blocked = blockReason(error);
        if (blocked) {
          runtime.blocked = blocked;
          if (error instanceof CooldownRequired) {
            runtime.cooldownUntil = Date.now() + error.retryAfterMs;
          }
        }
        else if (isDeterministicRequestError(error)) throw error;
        else runtime.recovery.recordFailure();
      }
    }
    throw lastError ?? new Error("No QQ Music lane is available.");
  };

  const executeBestEffortControl = async <T>(
    label: string,
    request: (lane: QQCommentLane) => Promise<T>,
  ): Promise<T> => {
    let lastError: unknown;
    for (const runtime of runtimes) {
      if (runtime.blocked) continue;
      try {
        await runtime.recovery.waitUntilReady();
        if (runtime.lane.transportGate.isCancelled) throw new RunCancelled();
        return await executeLane(runtime.lane, label, () => request(runtime.lane), true);
      } catch (error) {
        lastError = error;
        if (isPermanentLaneError(error)) {
          runtime.blocked = "unavailable";
          continue;
        }
        if (error instanceof RequestBudgetExhausted || error instanceof RunCancelled) throw error;
        if (isDeterministicRequestError(error)) throw error;
      }
    }
    throw lastError ?? new Error("No QQ Music lane is available for optional metadata.");
  };

  try {
    if (migratedLegacyCommentPageSize) await forceCheckpoint();
    if (state?.finished) {
      for (const song of state.songs) publishSongProgress(options, song);
      return finishReport(report(state, options, tracker, requestsThisRun(), startedAt, "complete"));
    }
    if (state?.cooldownUntil) {
      const resumeAt = Date.parse(state.cooldownUntil);
      if (resumeAt > Date.now()) {
        for (const song of state.songs) publishSongProgress(options, song);
        return finishReport(report(
          state,
          options,
          tracker,
          requestsThisRun(),
          startedAt,
          "cooldown",
          `QQ Music cooldown is active until ${state.cooldownUntil}.`,
        ));
      }
      state.cooldownUntil = undefined;
      await forceCheckpoint();
    }
    if (!state) {
      const target = requiresRemoteUserResolution(options.target)
        ? await executeControl("qq_user_resolve", (lane) => lane.client.resolveUser(
          options.target,
          lane.transportGate.signal,
        ))
        : await lanes[0].client.resolveUser(options.target, lanes[0].transportGate.signal);
      const now = new Date().toISOString();
      state = {
        version: 1,
        kind: "qq-comment-scan",
        mode: options.mode,
        targetInput: options.target.trim(),
        targetEncryptUin: target.encryptUin,
        targetNumericUin: target.numericUin,
        targetNickname: target.nickname,
        requestedSongId: options.songId,
        commentPagination: "seqno-v1",
        pageSize: options.pageSize,
        likedPageSize: options.likedPageSize,
        maxSongs: options.maxSongs,
        maxCommentPagesPerSong: options.maxCommentPagesPerSong,
        sourceLoaded: false,
        sourceTruncated: false,
        sourceOffset: 0,
        songs: [],
        pagesProcessed: 0,
        commentsInspected: 0,
        matchCount: 0,
        seenCommentKeys: [],
        requestCount: 0,
        finished: false,
        coverageComplete: false,
        createdAt: now,
        updatedAt: now,
      };
      await forceCheckpoint();
    }

    if (!state.sourceLoaded) {
      if (options.mode === "song") {
        const songId = options.songId!;
        let metadata: QQMusicSong | undefined;
        try {
          metadata = await executeBestEffortControl(
            `qq_song_detail:${songId}`,
            (lane) => lane.client.getSongInfo(songId, lane.transportGate.signal),
          );
        } catch (error) {
          if (error instanceof RequestBudgetExhausted || error instanceof RunCancelled) throw error;
          // Metadata is optional; the numeric song ID remains a usable scan target.
        }
        const song: QQMusicSong = {
          id: songId,
          mid: metadata?.mid,
          name: metadata?.name,
          artists: metadata?.artists,
        };
        state.songs = [newSongProgress(song)];
        state.sourceOffset = 1;
        state.sourceTotal = 1;
        state.sourceLoaded = true;
        await forceCheckpoint();
      } else {
        await discoverLikedSongs(state, options, executeControl, forceCheckpoint);
      }
    }

    for (const song of state.songs) publishSongProgress(options, song);

    if (state.finished) {
      await forceCheckpoint();
      return finishReport(report(
        state,
        options,
        tracker,
        requestsThisRun(),
        startedAt,
        "complete",
      ));
    }

    const pending = state.songs.map((_song, index) => index)
      .filter((index) => !state!.songs[index].done);
    const queue = new AsyncWorkQueue<number>(pending);
    activeQueue = queue;
    const seenCommentKeys = new Set(state.seenCommentKeys);
    const workerCount = options.mode === "song"
      ? 1
      : workerCountForTopology(lanes.length, options.workersPerLane, options.maxWorkers);
    const laneAllocator = new LaneAllocator(
      runtimes,
      options.workersPerLane,
      (runtime) => runtime.blocked === undefined,
      (runtime) => runtime.recovery.ready,
      () => runtimes.some((runtime) => runtime.activeRequests > 0),
    );
    activeLaneAllocator = laneAllocator;
    let scheduledLogicalPages = 0;
    let budgetReached = false;
    const logicalPageReservations = new Set<string>();
    const logicalPageKey = (song: QQMusicSongProgress): string =>
      `${song.id}:${song.pageNo}:${song.cursor ?? ""}`;
    const reserveLogicalPage = (song: QQMusicSongProgress): boolean => {
      const key = logicalPageKey(song);
      if (logicalPageReservations.has(key)) return true;
      if (options.requestBudget > 0 && scheduledLogicalPages >= options.requestBudget) {
        budgetReached = true;
        stopNote = `The task-wide logical comment-page budget ${options.requestBudget} was reached; resume to continue.`;
        laneAllocator.cancel();
        for (const runtime of runtimes) runtime.recovery.cancel();
        queue.stop();
        return false;
      }
      logicalPageReservations.add(key);
      scheduledLogicalPages += 1;
      return true;
    };
    const allLanesUnavailable = (): boolean => runtimes.every((runtime) => runtime.blocked !== undefined);
    const maybeStopAfterLaneRequests = (): void => {
      if (stopReason || budgetReached) return;
      if (allLanesUnavailable() && runtimes.every((runtime) => runtime.activeRequests === 0)) {
        laneAllocator.cancel();
        queue.stop();
      }
    };
    void queue.whenClosed().then(() => {
      laneAllocator.cancel();
      for (const runtime of runtimes) runtime.recovery.cancel();
    });

    const scanPage = async (
      runtime: LaneRuntime,
      workerId: string,
      song: QQMusicSongProgress,
    ): Promise<boolean> => {
      if (
        options.maxCommentPagesPerSong > 0
        && song.pagesProcessed >= options.maxCommentPagesPerSong
      ) {
        song.done = true;
        song.truncated = true;
        song.cursor = undefined;
        publishSongProgress(options, song);
        await forceCheckpoint();
        return false;
      }
      if (!reserveLogicalPage(song)) return false;

      const pageNumber = song.pageNo + 1;
      const started = Date.now();
      const startedAt = new Date(started).toISOString();
      beginTrackedRequest(tracker, workerId, runtime.lane.name);
      publishActivity(options, {
        phase: "start",
        operation: "comment-page",
        workerId,
        lane: runtime.lane.name,
        songId: song.id,
        songName: song.name,
        page: pageNumber,
        startedAt,
      });

      let attempts = 0;
      let networkElapsedMs = 0;
      let page;
      try {
        page = await executeLane(
          runtime.lane,
          `qq_comments:${song.id}:page-${pageNumber}`,
          async () => {
            attempts += 1;
            const networkStartedAt = Date.now();
            try {
              return await runtime.lane.client.getNewComments(
                song.id,
                options.pageSize,
                song.pageNo,
                song.cursor,
                runtime.lane.transportGate.signal,
              );
            } finally {
              networkElapsedMs += Date.now() - networkStartedAt;
            }
          },
        );
        publishActivity(options, {
          phase: "success",
          operation: "comment-page",
          workerId,
          lane: runtime.lane.name,
          songId: song.id,
          songName: song.name,
          page: pageNumber,
          startedAt,
          elapsedMs: Date.now() - started,
          networkElapsedMs,
          attempts,
          comments: page.comments.length,
          effectiveComments: page.comments.length,
          totalComments: page.total,
          hasMore: page.hasMore,
        });
      } catch (error) {
        const status = errorStatus(error);
        publishActivity(options, {
          phase: "failure",
          operation: "comment-page",
          workerId,
          lane: runtime.lane.name,
          songId: song.id,
          songName: song.name,
          page: pageNumber,
          startedAt,
          elapsedMs: Date.now() - started,
          networkElapsedMs,
          attempts,
          status,
          rateLimited: status === 403 || status === 429 || error instanceof CooldownRequired,
          error: message(error),
        });
        throw error;
      }

      runtime.recovery.recordSuccess();
      song.lastError = undefined;

      let matchedThisPage = false;
      const newlySeenCommentKeys: string[] = [];
      for (const comment of page.comments) {
        if (comment.authorEncryptUin !== state!.targetEncryptUin) continue;
        const key = qqMusicCommentKey(song.id, comment.commentId);
        if (seenCommentKeys.has(key)) continue;
        const found: QQMusicFoundComment = {
          ...comment,
          platform: "qq",
          targetEncryptUin: state!.targetEncryptUin,
          songId: song.id,
          songMid: song.mid,
          songName: song.name,
          artists: song.artists,
          capturedAt: new Date().toISOString(),
        };
        if (writer.has(song.id, comment.commentId) || await writer.append(found)) {
          seenCommentKeys.add(key);
          newlySeenCommentKeys.push(key);
          matchedThisPage = true;
        }
      }

      // A durable JSONL row may legitimately lead the checkpoint after a stop.
      // Never consume the SeqNo cursor after cancellation; resume will replay and
      // reconcile the composite key without duplicating output.
      if (taskSignal.aborted) throw new RunCancelled();

      // Commit a page to checkpoint state only after all matching JSONL records
      // are durable. The synchronous mutation block prevents another worker's
      // coalesced snapshot from observing a half-applied page.
      song.pagesProcessed += 1;
      song.pageNo += 1;
      song.commentsInspected += page.comments.length;
      song.totalComments = mergeTotal(song.totalComments, page.total, song.commentsInspected);
      state!.pagesProcessed += 1;
      state!.commentsInspected += page.comments.length;
      state!.seenCommentKeys.push(...newlySeenCommentKeys);
      state!.matchCount += newlySeenCommentKeys.length;
      if (page.hasMore) {
        song.cursor = page.nextCursor;
      } else {
        song.done = true;
        song.cursor = undefined;
      }
      publishSongProgress(options, song);
      if (matchedThisPage && options.stopAfterFirst) await forceCheckpoint();
      else await checkpointCommentPage();
      if (matchedThisPage && options.stopAfterFirst) {
        stopFor("matched", "Stopped after finding a matching QQ Music comment.");
        queue.stop();
      }
      return !song.done && !stopReason;
    };

    const worker = async (workerIndex: number): Promise<void> => {
      const workerId = `worker-${workerIndex + 1}`;
      while (!stopReason && !budgetReached) {
        let releaseCheckpointSlotForPage = (): void => {};
        let permit: Awaited<ReturnType<typeof laneAllocator.acquire>> = undefined;
        let runtime: LaneRuntime | undefined;
        let songIndex: number | undefined;
        let queueItemTaken = false;
        let laneRequestActive = false;
        let requeue = false;
        try {
          releaseCheckpointSlotForPage = await acquireCheckpointSlot();
          if (stopReason || budgetReached || queue.isClosed()) return;
          permit = await laneAllocator.acquire();
          if (!permit) return;
          runtime = permit.lane;
          if (stopReason || budgetReached || runtime.lane.transportGate.isCancelled) {
            if (runtime.lane.transportGate.isCancelled && !stopReason) {
              stopFor("stopped", "The QQ Music scan was cancelled.");
            }
            return;
          }
          songIndex = await queue.take();
          if (songIndex === undefined) return;
          queueItemTaken = true;
          if (runtime.blocked || !runtime.recovery.ready) {
            requeue = !stopReason && !budgetReached;
            continue;
          }
          laneRequestActive = true;
          runtime.activeRequests += 1;
          requeue = await scanPage(runtime, workerId, state!.songs[songIndex]);
          if (runtime.blocked === "unavailable") runtime.blocked = undefined;
          laneAllocator.notify();
        } catch (error) {
          if (!runtime || songIndex === undefined) {
            if (error instanceof RunCancelled) {
              stopFor("stopped", "The QQ Music scan was cancelled.");
              return;
            }
            throw error;
          }
          const song = state!.songs[songIndex];
          if (persistenceFailed) {
            requeue = false;
            continue;
          }
          song.lastError = message(error);
          if (error instanceof QQMusicCheckpointError || error instanceof QQMusicResultPersistenceError) {
            stopForPersistence(error);
          } else if (isPermanentLaneError(error)) {
            runtime.blocked = "unavailable";
            laneAllocator.notify();
            requeue = !stopReason;
            await persistFailureState(forceCheckpoint, stopForPersistence);
          } else if (isSongResourceUnavailable(error)) {
            song.done = true;
            song.truncated = true;
            song.cursor = undefined;
            publishSongProgress(options, song);
            requeue = false;
            await persistFailureState(forceCheckpoint, stopForPersistence);
          } else if (isDeterministicRequestError(error)) {
            requeue = false;
            stopFor("paused", message(error));
            await persistFailureState(forceCheckpoint, stopForPersistence);
          } else {
            const blocked = blockReason(error);
            if (blocked) {
              runtime.blocked = blocked;
              if (error instanceof CooldownRequired) {
                runtime.cooldownUntil = Date.now() + error.retryAfterMs;
              }
              laneAllocator.notify();
              if (blocked === "stopped") {
                stopFor("stopped", "The QQ Music scan was cancelled.");
              }
            } else {
              runtime.recovery.recordFailure();
              void runtime.recovery.waitUntilReady(taskSignal)
                .then(() => laneAllocator.notify())
                .catch(() => {});
              if (runtime.recovery.failureCount >= MAX_CONSECUTIVE_LANE_FAILURES) {
                runtime.blocked = "unavailable";
                laneAllocator.notify();
              }
            }
            requeue = !stopReason;
            await persistFailureState(forceCheckpoint, stopForPersistence);
          }
        } finally {
          if (runtime && laneRequestActive) {
            runtime.activeRequests = Math.max(0, runtime.activeRequests - 1);
          }
          permit?.release();
          releaseCheckpointSlotForPage();
          maybeStopAfterLaneRequests();
          if (queueItemTaken) {
            if (stopReason || budgetReached) requeue = false;
            queue.complete(requeue && songIndex !== undefined ? songIndex : undefined);
          }
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, (_unused, index) => worker(index)));

    updateCompletion();
    if (!stopReason && !budgetReached && !state.finished) {
      const available = runtimes.filter((runtime) => !runtime.blocked);
      if (available.length === 0) {
        const reasons = new Set(runtimes.map((runtime) => runtime.blocked));
        if (reasons.has("cooldown")) {
          stopFor("cooldown", "Every QQ Music lane entered cooldown.");
        } else if (reasons.size === 1 && reasons.has("stopped")) {
          stopFor("stopped", "The QQ Music scan was cancelled.");
        } else {
          stopFor("paused", "Every QQ Music lane exhausted its request budget or became unavailable.");
        }
      }
    }
    if (budgetReached && !stopReason) stopReason = "paused";
    if (!persistenceFailed) await forceCheckpoint();
  } catch (error) {
    if (!state) {
      await cleanup();
      throw error;
    }
    if (error instanceof QQMusicCheckpointError) {
      stopForPersistence(error);
    } else {
      const reason = blockReason(error);
      if (reason === "paused") stopFor("paused", message(error));
      else if (reason === "cooldown") stopFor("cooldown", message(error));
      else if (reason === "stopped") stopFor("stopped", "The QQ Music scan was cancelled.");
      else if (isDeterministicRequestError(error)) stopFor("paused", message(error));
      else {
        await cleanup();
        throw error;
      }
      if (state) {
        try {
          await forceCheckpoint();
        } catch (checkpointError) {
          stopForPersistence(checkpointError);
        }
      }
    }
  }

  const status = stopReason ?? (state!.finished ? "complete" : "paused");
  return finishReport(report(
    state!,
    options,
    tracker,
    requestsThisRun(),
    startedAt,
    status,
    stopNote,
  ));
}

async function discoverLikedSongs(
  state: QQMusicScanState,
  options: QQMusicScanOptions,
  executeControl: <T>(label: string, request: (lane: QQCommentLane) => Promise<T>) => Promise<T>,
  checkpoint: () => Promise<void>,
): Promise<void> {
  const known = new Set(state.songs.map((song) => song.id));
  while (!state.sourceLoaded) {
    const offset = state.sourceOffset;
    const page = await executeControl(
      `qq_liked_songs:${offset}`,
      (lane) => lane.client.getLikedSongsPage(
        state.targetEncryptUin,
        offset,
        options.likedPageSize,
        lane.transportGate.signal,
      ),
    );
    if (page.hasMore && page.nextOffset <= offset) {
      throw new QQMusicProtocolError("QQ Music liked-song pagination did not advance.");
    }
    if (!page.hasMore && page.total !== undefined && page.nextOffset < page.total) {
      throw new QQMusicProtocolError(
        `QQ Music liked-song source ended at ${page.nextOffset} before declared total ${page.total}.`,
      );
    }
    state.sourceOffset = page.nextOffset;
    state.sourceTotal = page.total ?? state.sourceTotal;
    for (const song of page.songs) {
      if (known.has(song.id)) continue;
      known.add(song.id);
      state.songs.push(newSongProgress(song));
      if (options.maxSongs > 0 && state.songs.length >= options.maxSongs) break;
    }
    const reachedLimit = options.maxSongs > 0 && state.songs.length >= options.maxSongs;
    if (reachedLimit) {
      state.sourceLoaded = true;
      state.sourceTruncated = page.hasMore
        || (page.total !== undefined && state.songs.length < page.total);
    } else if (!page.hasMore) {
      state.sourceLoaded = true;
    }
    await checkpoint();
  }
}

function executeLane<T>(
  lane: QQCommentLane,
  label: string,
  request: () => Promise<T>,
  bestEffort = false,
): Promise<T> {
  const guardedRequest = () => lane.transportGate.run(async () => {
    try {
      const result = await request();
      if (lane.transportGate.isCancelled) throw new RunCancelled();
      return result;
    } catch (error) {
      if (lane.transportGate.isCancelled) throw new RunCancelled();
      throw error;
    }
  });
  return bestEffort
    ? lane.governor.executeBestEffort(label, guardedRequest)
    : lane.governor.execute(label, guardedRequest);
}

function checkpointActivity(state: QQMusicScanState): QQMusicCheckpointActivity {
  return {
    songs: state.songs.length,
    songsComplete: state.songs.filter((song) => song.done).length,
    pagesProcessed: state.pagesProcessed,
    commentsInspected: state.commentsInspected,
    matches: state.matchCount,
    requestsTotal: state.requestCount,
    coverageComplete: state.coverageComplete,
  };
}

function beginTrackedRequest(
  tracker: ActiveRequestTracker,
  workerId: string,
  lane: string,
): void {
  tracker.seenWorkers.add(workerId);
  tracker.seenLanes.add(lane);
}

function publishActivity(options: QQMusicScanOptions, activity: QQMusicRequestActivity): void {
  try { options.onRequestActivity?.(activity); } catch { /* Presentation callbacks are best-effort. */ }
}

function publishSongProgress(options: QQMusicScanOptions, song: QQMusicSongProgress): void {
  const activity: QQMusicSongActivity = {
    songId: song.id,
    songMid: song.mid,
    songName: song.name,
    artists: song.artists,
    pages: song.pagesProcessed,
    comments: song.commentsInspected,
    total: song.totalComments,
    done: song.done,
    truncated: song.truncated,
  };
  try { options.onSongProgress?.(activity); } catch { /* Presentation callbacks are best-effort. */ }
}

function mergeTotal(
  current: number | undefined,
  observed: number | undefined,
  inspected: number,
): number | undefined {
  if (observed === undefined) return current;
  return Math.max(current ?? 0, observed, inspected);
}

async function persistFailureState(
  forceCheckpoint: () => Promise<void>,
  stopForPersistence: (error: unknown) => void,
): Promise<void> {
  try {
    await forceCheckpoint();
  } catch (error) {
    stopForPersistence(error);
  }
}

function newSongProgress(song: QQMusicSong): QQMusicSongProgress {
  return {
    ...song,
    artists: song.artists ?? [],
    pageNo: 0,
    pagesProcessed: 0,
    commentsInspected: 0,
    done: false,
    truncated: false,
  };
}

function report(
  state: QQMusicScanState,
  options: QQMusicScanOptions,
  tracker: ActiveRequestTracker,
  requestsThisRun: number,
  startedAt: number,
  status: QQMusicScanReport["status"],
  note?: string,
): QQMusicScanReport {
  return {
    status,
    mode: state.mode,
    targetEncryptUin: state.targetEncryptUin,
    songs: state.songs.length,
    songsComplete: state.songs.filter((song) => song.done).length,
    lanes: tracker.seenLanes.size,
    workers: tracker.seenWorkers.size,
    pagesProcessed: state.pagesProcessed,
    commentsInspected: state.commentsInspected,
    matches: state.matchCount,
    requestsThisRun,
    requestsTotal: state.requestCount,
    coverageComplete: state.coverageComplete,
    elapsedMs: Date.now() - startedAt,
    statePath: options.statePath,
    outputPath: options.outputPath,
    note,
  };
}

function validateLanes(lanes: QQCommentLane[]): void {
  if (lanes.length === 0) throw new Error("At least one QQ Music lane is required.");
  const names = new Set<string>();
  const gate = lanes[0].transportGate;
  for (const lane of lanes) {
    if (!lane.name.trim()) throw new Error("QQ Music lane names must be non-empty.");
    if (names.has(lane.name)) throw new Error(`Duplicate QQ Music lane name: ${lane.name}.`);
    names.add(lane.name);
    if (lane.transportGate !== gate) {
      throw new Error("Every QQ Music lane must share the same transport gate.");
    }
  }
}

function validateOptions(options: QQMusicScanOptions): void {
  if (!options.target.trim()) throw new Error("QQ Music target user is required.");
  if (options.mode === "song" && (!options.songId || !/^\d+$/.test(options.songId))) {
    throw new Error("QQ Music song mode requires a numeric songId.");
  }
  requireInteger(options.pageSize, "pageSize", 1, QQ_MUSIC_COMMENT_PAGE_SIZE_MAX);
  requireInteger(options.likedPageSize, "likedPageSize", 1, 500);
  requireInteger(options.maxSongs, "maxSongs", 0);
  requireInteger(options.maxCommentPagesPerSong, "maxCommentPagesPerSong", 0);
  requireInteger(options.workersPerLane, "workersPerLane", 1, 16);
  if (options.maxWorkers !== undefined) requireInteger(options.maxWorkers, "maxWorkers", 1, 32);
  requireInteger(options.requestBudget, "requestBudget", 0);
}

function validateResume(state: QQMusicScanState, options: QQMusicScanOptions): void {
  const mismatches: string[] = [];
  if (state.mode !== options.mode) mismatches.push("mode");
  if (state.targetInput !== options.target.trim()) mismatches.push("target");
  if (state.pageSize !== options.pageSize) mismatches.push("pageSize");
  if (state.likedPageSize !== options.likedPageSize) mismatches.push("likedPageSize");
  if (state.maxSongs !== options.maxSongs) mismatches.push("maxSongs");
  if (state.maxCommentPagesPerSong !== options.maxCommentPagesPerSong) {
    mismatches.push("maxCommentPagesPerSong");
  }
  if (options.mode === "song" && state.requestedSongId !== options.songId) {
    mismatches.push("songId");
  }
  if (mismatches.length > 0) {
    throw new Error(`QQ Music checkpoint does not match ${mismatches.join(", ")}; use --fresh.`);
  }
}

function requireInteger(value: number, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function requiresRemoteUserResolution(input: string): boolean {
  const normalized = input.trim();
  return /^\d+$/.test(normalized) || /^https?:\/\//i.test(normalized);
}

function blockReason(error: unknown): LaneBlockReason | undefined {
  if (error instanceof RequestBudgetExhausted) return "paused";
  if (error instanceof CooldownRequired) return "cooldown";
  if (error instanceof RunCancelled) return "stopped";
  return undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDeterministicRequestError(error: unknown): boolean {
  if (isPermanentLaneError(error)) return false;
  const qqError = findQQMusicApiError(error);
  if (qqError) return !qqError.retryable;
  const status = errorStatus(error);
  return status !== undefined
    && status !== 403
    && status !== 408
    && status !== 425
    && status !== 429
    && !(status >= 500 && status <= 599);
}

function isSongResourceUnavailable(error: unknown): boolean {
  if (isPermanentLaneError(error)) return false;
  const qqError = findQQMusicApiError(error);
  if (qqError instanceof QQMusicProtocolError) return false;
  if (qqError) return qqError.status === 404 || qqError.status === 410;
  const status = errorStatus(error);
  return status === 404 || status === 410;
}

function isPermanentLaneError(error: unknown): boolean {
  const proxyError = findQQMusicProxyError(error);
  if (!proxyError) return false;
  const status = proxyError.status;
  return status !== undefined
    && status !== 408
    && status !== 425
    && status !== 429
    && !(status >= 500 && status <= 599);
}

function findQQMusicApiError(error: unknown): QQMusicApiError | undefined {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === "object" && !visited.has(current)) {
    if (current instanceof QQMusicApiError) return current;
    visited.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function findQQMusicProxyError(error: unknown): QQMusicProxyError | undefined {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === "object" && !visited.has(current)) {
    if (current instanceof QQMusicProxyError) return current;
    visited.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
