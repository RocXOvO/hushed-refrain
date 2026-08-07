import {
  AuthenticationRequired,
  CooldownRequired,
  RequestBudgetExhausted,
  RunCancelled,
} from "./errors";
import { RequestGovernor } from "./governor";
import { LaneRecovery } from "./lane-recovery";
import {
  executeBestEffortProxyRequest,
  executeProxyRequest,
  type ProxyTransportGate,
} from "./proxy-transport-gate";
import { mergeCommentTotal } from "./progress";
import { nextDescendingCursor } from "./cursor-pagination";
import { JsonlResultWriter } from "./results";
import { hydrateMissingSongMetadata } from "./song-metadata";
import { createTimeShards, SOURCE_SCAN_START_TIME, splitRemainingTimeShard } from "./time-shards";
import { AsyncWorkQueue } from "./work-queue";
import {
  assertCompatibleState,
  createState,
  loadState,
  saveState,
} from "./state";
import type {
  FoundComment,
  CommentTimeShard,
  NcmClient,
  RunReport,
  ScanOptions,
  ScanState,
  SongCandidate,
} from "./types";

const MAX_CONSECUTIVE_LANE_FAILURES = 5;

export interface SourceScanLane {
  name: string;
  client: NcmClient;
  governor: RequestGovernor;
  transportGate?: ProxyTransportGate;
}

export interface PooledScanOptions extends ScanOptions {
  workersPerLane: number;
  requestBudget: number;
}

class SourceLaneFailure extends Error {
  constructor(public readonly lane: string, public readonly original: unknown) {
    super(`Source lane ${lane} failed.`);
    this.name = "SourceLaneFailure";
  }
}

interface SourceScanWork {
  songIndex: number;
  shardId?: number;
}

export async function runCommentFinder(
  client: NcmClient,
  governor: RequestGovernor,
  options: ScanOptions,
): Promise<RunReport> {
  const loadedState = options.fresh ? undefined : await loadState(options.statePath);
  if (loadedState) assertCompatibleState(loadedState, options);

  const initialRequests = loadedState?.requestCount ?? 0;
  const provisionalStrategy = options.strategy === "history" ? "history" : "scan";
  const state = loadedState ?? createState(options, provisionalStrategy);
  const seenCommentIds = new Set(state.seenCommentIds);

  if (state.blockedUntil) {
    const resumeAt = Date.parse(state.blockedUntil);
    if (Number.isFinite(resumeAt) && resumeAt > Date.now()) {
      return report(state, governor, options, initialRequests, "cooldown", {
        resumeAfter: state.blockedUntil,
        note: "Remote cooldown is still active; the checkpoint was left unchanged.",
      });
    }
    delete state.blockedUntil;
  }

  const writer = new JsonlResultWriter(options.outputPath, options.onMatch);
  await writer.initialize();

  const checkpoint = async (): Promise<void> => {
    state.requestCount = initialRequests + governor.requestsUsed;
    publishCheckpointProgress(options, state);
    await saveState(options.statePath, state);
  };

  try {
    if (!state.strategyResolved) {
      state.strategy = await selectStrategy(client, governor, options);
      state.strategyResolved = true;
      state.sourcesLoaded = state.strategy === "history";
      await checkpoint();
    }

    if (state.finished) {
      return report(state, governor, options, initialRequests, "complete");
    }

    if (state.strategy === "history") {
      if (!options.cookie) {
        throw new Error("The history strategy requires a logged-in cookie.");
      }
      return await runHistory(client, governor, options, state, writer, seenCommentIds, checkpoint, initialRequests);
    }

    return await runSongScan(client, governor, options, state, writer, seenCommentIds, checkpoint, initialRequests);
  } catch (error) {
    if (error instanceof CooldownRequired) {
      state.blockedUntil = new Date(Date.now() + error.retryAfterMs).toISOString();
      await checkpoint();
      return report(state, governor, options, initialRequests, "cooldown", {
        resumeAfter: state.blockedUntil,
        note: `Remote status ${error.status}; stopped without retrying the blocked request.`,
      });
    }
    if (error instanceof RequestBudgetExhausted) {
      await checkpoint();
      return report(state, governor, options, initialRequests, "paused", {
        note: `This run reached its request budget (${error.budget}). Run the same command to resume.`,
      });
    }
    if (error instanceof RunCancelled) {
      await checkpoint();
      return report(state, governor, options, initialRequests, "stopped", {
        note: "Stopped by the operator; run the same task to resume from this checkpoint.",
      });
    }
    await checkpoint();
    throw error;
  }
}

export async function runPooledCommentFinder(
  lanes: SourceScanLane[],
  options: PooledScanOptions,
): Promise<RunReport> {
  if (lanes.length === 0) throw new Error("At least one source scan lane is required.");
  if (options.strategy !== "scan") throw new Error("Pooled source scanning currently requires the scan strategy.");
  const loadedState = options.fresh ? undefined : await loadState(options.statePath);
  if (loadedState) assertCompatibleState(loadedState, options);
  const state = loadedState ?? createState(options, "scan");
  const initialRequests = state.requestCount;
  const seenCommentIds = new Set(state.seenCommentIds);
  const writer = new JsonlResultWriter(options.outputPath, options.onMatch);
  await writer.initialize();

  if (state.blockedUntil) {
    const resumeAt = Date.parse(state.blockedUntil);
    if (Number.isFinite(resumeAt) && resumeAt > Date.now()) {
      return pooledReport(state, lanes, options, initialRequests, "cooldown", {
        resumeAfter: state.blockedUntil,
        note: "Remote cooldown is still active; the checkpoint was left unchanged.",
      });
    }
    delete state.blockedUntil;
  }

  let checkpointTail = Promise.resolve();
  let lastCheckpointAt = 0;
  const checkpoint = async (force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastCheckpointAt < 350) return;
    lastCheckpointAt = now;
    state.requestCount = initialRequests + pooledRequestsUsed(lanes);
    publishCheckpointProgress(options, state);
    const snapshot = structuredClone(state);
    checkpointTail = checkpointTail.then(() => saveState(options.statePath, snapshot));
    await checkpointTail;
  };

  try {
    state.strategy = "scan";
    state.strategyResolved = true;
    let sourcesChanged = false;
    if (!state.sourcesLoaded) {
      const collected = await collectSongsPooled(lanes, options);
      state.sourceSongCount = collected.songs.length;
      state.sourceTruncated = options.maxSongs > 0 && collected.songs.length > options.maxSongs;
      state.songs = options.maxSongs > 0 ? collected.songs.slice(0, options.maxSongs) : collected.songs;
      state.sourceErrors = collected.failures;
      state.sourcesLoaded = true;
      ensureSongProgress(state);
      sourcesChanged = true;
    }
    const hydratedSongs = await hydrateSongsFromPool(lanes, state.songs);
    publishSongCatalog(options, state.songs);
    if (sourcesChanged || hydratedSongs > 0) await checkpoint(true);

    ensureSongProgress(state);
    if (options.dryRun) {
      return pooledReport(state, lanes, options, initialRequests, "dry-run", {
        note: estimateNote(state, options),
      });
    }
    if (state.finished) return pooledReport(state, lanes, options, initialRequests, "complete");

    const configuredWorkers = lanes.length * options.workersPerLane;
    const transportCapacity = lanes.find((lane) => lane.transportGate)?.transportGate?.currentMaxConcurrent;
    const initialWorkTarget = Math.min(configuredWorkers, transportCapacity ?? configuredWorkers);
    const queue = new AsyncWorkQueue<SourceScanWork>(
      prepareSourceWork(state, initialWorkTarget, options.maxCommentPagesPerSong),
    );
    const blockedLanes = new Map<string, number>();
    const unavailableLanes = new Set<string>();
    const laneRecovery = new Map(lanes.map((lane) => [lane.name, new LaneRecovery()]));
    const activeLaneRequests = new Map(lanes.map((lane) => [lane.name, 0]));
    const reservedSongPages = new Map(
      state.songProgress!.map((progress, index) => [index, progress.pageInSong]),
    );
    const songPermitWaiters = new Map<number, Set<() => void>>();
    let reservedRequests = pooledRequestsUsed(lanes);
    let stopRequested = false;
    let budgetReached = false;
    let cancelled = false;
    let matched = false;
    let fatalError: unknown;
    const allLanesUnavailable = (): boolean => lanes.every((lane) =>
      blockedLanes.has(lane.name) || unavailableLanes.has(lane.name)
    );

    const stopScheduling = (): void => {
      stopRequested = true;
      for (const recovery of laneRecovery.values()) recovery.cancel();
      queue.stop();
      for (const waiters of songPermitWaiters.values()) {
        for (const resolveWaiter of waiters) resolveWaiter();
        waiters.clear();
      }
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

    const notifySongPermit = (songIndex: number): void => {
      const waiters = songPermitWaiters.get(songIndex);
      if (!waiters) return;
      for (const resolveWaiter of waiters) resolveWaiter();
      waiters.clear();
    };

    const waitForSongPermit = (songIndex: number): Promise<void> => new Promise((resolveWaiter) => {
      const waiters = songPermitWaiters.get(songIndex) ?? new Set<() => void>();
      waiters.add(resolveWaiter);
      songPermitWaiters.set(songIndex, waiters);
      const progress = state.songProgress![songIndex];
      const reservedPages = reservedSongPages.get(songIndex) ?? progress.pageInSong;
      if (
        stopRequested ||
        progress.done ||
        options.maxCommentPagesPerSong === 0 ||
        reservedPages < options.maxCommentPagesPerSong
      ) {
        waiters.delete(resolveWaiter);
        resolveWaiter();
      }
    });

    const reserveRequest = (songIndex: number): "reserved" | "wait" | "stopped" => {
      if (stopRequested) return "stopped";
      const progress = state.songProgress![songIndex];
      const reservedPages = reservedSongPages.get(songIndex) ?? progress.pageInSong;
      if (options.maxCommentPagesPerSong > 0 && reservedPages >= options.maxCommentPagesPerSong) {
        if (progress.pageInSong >= options.maxCommentPagesPerSong) {
          markSongTruncated(state, songIndex);
          notifySongPermit(songIndex);
          return "stopped";
        }
        return "wait";
      }
      if (options.requestBudget > 0 && reservedRequests >= options.requestBudget) {
        budgetReached = true;
        stopScheduling();
        return "stopped";
      }
      reservedRequests += 1;
      reservedSongPages.set(songIndex, reservedPages + 1);
      return "reserved";
    };

    const scanSongPage = async (
      lane: SourceScanLane,
      workerId: string,
      work: SourceScanWork,
    ): Promise<SourceScanWork[]> => {
      const { songIndex } = work;
      const song = state.songs[songIndex];
      const progress = state.songProgress![songIndex];
      const shard = work.shardId === undefined
        ? undefined
        : progress.commentShards?.find((candidate) => candidate.id === work.shardId);
      if (stopRequested || progress.done || (work.shardId !== undefined && (!shard || shard.done))) return [];
      while (true) {
        const reservation = reserveRequest(songIndex);
        if (reservation === "reserved") break;
        if (reservation === "stopped") {
          syncSongCursor(state);
          await checkpoint();
          return [];
        }
        await waitForSongPermit(songIndex);
        if (stopRequested || progress.done || shard?.done) return [];
      }
      const requestedCursor = shard?.cursor ?? progress.commentCursor!;
      const requestedPageNo = shard?.pageNo ?? progress.commentPageNo!;
      const requestStartedAt = Date.now();
      const requestActivity = {
        lane: lane.name,
        workerId,
        operation: "comment-page" as const,
        songId: song.id,
        songName: song.name,
        page: requestedPageNo,
        shardId: shard?.id,
      };
      publishRequestActivity(options, { ...requestActivity, phase: "start" });
      let page;
      try {
        page = await executeProxyRequest(lane, `comment_new:${song.id}${shard ? `:shard-${shard.id}` : ""}`, () => {
          publishSongProgress(
            options,
            song,
            progress.pageInSong,
            progress.commentOffset,
            progress.totalComments,
            workerId,
            requestedPageNo,
          );
          return lane.client.getSongCommentsByCursor(
            song.id,
            options.commentPageSize,
            requestedPageNo,
            requestedCursor,
          );
        });
      } catch (error) {
        const reservedPages = reservedSongPages.get(songIndex) ?? progress.pageInSong;
        reservedSongPages.set(songIndex, Math.max(progress.pageInSong, reservedPages - 1));
        notifySongPermit(songIndex);
        const status = remoteStatus(error);
        publishRequestActivity(options, {
          ...requestActivity,
          phase: "failure",
          elapsedMs: Date.now() - requestStartedAt,
          status,
          rateLimited: error instanceof CooldownRequired || status === 403 || status === 429,
          error: errorMessage(error),
        });
        if (error instanceof CooldownRequired || error instanceof RequestBudgetExhausted || error instanceof RunCancelled) throw error;
        throw new SourceLaneFailure(lane.name, error);
      }
      const times = shard
        ? page.comments.map((comment) => comment.time).filter((time): time is number => time !== undefined)
        : [];
      const oldestTime = times.length > 0 ? Math.min(...times) : undefined;
      const crossedShardStart = Boolean(shard && oldestTime !== undefined && oldestTime < shard.startTime);
      let nextCursor: string | undefined;
      try {
        nextCursor = crossedShardStart
          ? undefined
          : nextDescendingCursor(page.hasMore, page.nextCursor, requestedCursor, `song ${song.id}${shard ? ` shard ${shard.id}` : ""}`);
      } catch (error) {
        publishRequestActivity(options, {
          ...requestActivity,
          phase: "failure",
          elapsedMs: Date.now() - requestStartedAt,
          status: 502,
          error: errorMessage(error),
        });
        throw error;
      }
      publishRequestActivity(options, {
        ...requestActivity,
        phase: "success",
        elapsedMs: Date.now() - requestStartedAt,
        comments: page.comments.length,
        totalComments: page.total,
        hasMore: page.hasMore,
      });
      const scannedComments = shard
        ? page.comments.filter((comment) => comment.time === undefined || (comment.time >= shard.startTime && comment.time < shard.endTime))
        : page.comments;
      progress.pageInSong += 1;
      progress.commentOffset += scannedComments.length;
      progress.totalComments = mergeCommentTotal(progress.totalComments, page.total, progress.commentOffset);
      if (shard) {
        shard.pagesProcessed += 1;
        shard.pageNo = requestedPageNo + 1;
      } else {
        progress.commentPageNo = requestedPageNo + 1;
      }
      state.pagesProcessed = (state.pagesProcessed ?? 0) + 1;
      const matches = scannedComments
        .filter((comment) => comment.userId === options.uid)
        .map<FoundComment>((comment) => ({
          ...comment,
          songId: song.id,
          songName: song.name,
          sources: song.sources,
          sourceRank: song.sourceRank,
          playCount: song.playCount,
          route: "song-comments",
          capturedAt: new Date().toISOString(),
      }));
      const added = await appendMatches(writer, state, seenCommentIds, matches);
      let nextWork: SourceScanWork[] = [];
      const pageCapReached = options.maxCommentPagesPerSong > 0 && progress.pageInSong >= options.maxCommentPagesPerSong;
      if (shard) {
        const numericNextCursor = nextCursor === undefined ? undefined : Number(nextCursor);
        const cursorPassedStart = numericNextCursor !== undefined && numericNextCursor <= shard.startTime;
        if (nextCursor === undefined || cursorPassedStart) {
          shard.done = true;
        } else {
          shard.cursor = nextCursor;
        }
        progress.done = progress.commentShards!.every((candidate) => candidate.done);
        if (!progress.done && pageCapReached) {
          markSongTruncated(state, songIndex);
        } else if (!shard.done) {
          nextWork = splitSourceShardIfUseful(
            progress,
            shard,
            songIndex,
            song.id,
            queue.waitingCount(),
            options,
          );
          if (nextWork.length === 0) nextWork = [work];
        }
      } else if (nextCursor === undefined) {
        progress.done = true;
      } else if (pageCapReached) {
        markSongTruncated(state, songIndex);
      } else {
        progress.commentCursor = nextCursor;
        const shardWorks = queue.waitingCount() > 0
          ? shardRemainingSong(
            progress,
            songIndex,
            queue.waitingCount() + 1,
            options.maxCommentPagesPerSong,
          )
          : [];
        nextWork = shardWorks.length > 0 ? shardWorks : [work];
      }
      notifySongPermit(songIndex);
      syncSongCursor(state);
      publishSongProgress(
        options,
        song,
        progress.pageInSong,
        progress.commentOffset,
        progress.totalComments,
        workerId,
      );
      await checkpoint();
      if (added > 0 && options.stopAfterFirst) {
        matched = true;
        stopScheduling();
      }
      return stopRequested || progress.done ? [] : nextWork;
    };

    const runWorker = async (lane: SourceScanLane, workerIndex: number): Promise<void> => {
      const workerId = `${lane.name}:${workerIndex + 1}`;
      const recovery = laneRecovery.get(lane.name)!;
      while (!stopRequested && !blockedLanes.has(lane.name) && !unavailableLanes.has(lane.name)) {
        await recovery.waitUntilReady();
        if (stopRequested || queue.isClosed() || blockedLanes.has(lane.name) || unavailableLanes.has(lane.name)) return;
        const work = await queue.take();
        if (work === undefined) return;
        let requeue: SourceScanWork[] = [];
        let laneRequestActive = false;
        try {
          if (blockedLanes.has(lane.name) || unavailableLanes.has(lane.name)) {
            requeue = stopRequested ? [] : [work];
            return;
          }
          laneRequestActive = true;
          activeLaneRequests.set(lane.name, (activeLaneRequests.get(lane.name) ?? 0) + 1);
          requeue = await scanSongPage(lane, workerId, work);
          recovery.recordSuccess();
          unavailableLanes.delete(lane.name);
        } catch (error) {
          if (error instanceof CooldownRequired) {
            blockedLanes.set(lane.name, error.retryAfterMs);
            unavailableLanes.delete(lane.name);
            requeue = state.songProgress![work.songIndex].done ? [] : [work];
            return;
          }
          if (error instanceof SourceLaneFailure) {
            recovery.recordFailure();
            requeue = state.songProgress![work.songIndex].done ? [] : [work];
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

    try {
      await Promise.all(Array.from({ length: options.workersPerLane }, (_, workerIndex) =>
        lanes.map((lane) => runWorker(lane, workerIndex))
      ).flat());
    } finally {
      options.signal?.removeEventListener("abort", abortListener);
    }
    syncSongCursor(state);
    state.finished = state.songProgress!.every((progress) => progress.done);
    state.coverageComplete = state.finished && !state.sourceTruncated && state.truncatedSongIds.length === 0 && state.sourceErrors.length === 0;
    if (!state.finished && blockedLanes.size === lanes.length) {
      const retryAfterMs = Math.max(...blockedLanes.values());
      if (Number.isFinite(retryAfterMs)) state.blockedUntil = new Date(Date.now() + retryAfterMs).toISOString();
    }
    await checkpoint(true);
    if (fatalError) throw fatalError;

    const status: RunReport["status"] = matched && options.stopAfterFirst
      ? "paused"
      : state.finished
      ? "complete"
      : cancelled
      ? "stopped"
      : state.blockedUntil
      ? "cooldown"
      : "paused";
    const notes = [
      budgetReached ? `本轮已达到请求预算 ${options.requestBudget}，再次启动可从断点继续。` : undefined,
      matched ? "找到首条评论后已暂停；关闭“首条命中后暂停”可继续完整扫描。" : undefined,
      blockedLanes.size > 0 ? `进入冷却的出口：${[...blockedLanes.keys()].join(", ")}。` : undefined,
      unavailableLanes.size > 0 ? `连续网络失败已暂停的出口：${[...unavailableLanes].join(", ")}。` : undefined,
    ].filter(Boolean).join(" ");
    return pooledReport(state, lanes, options, initialRequests, status, {
      note: notes || undefined,
      resumeAfter: state.blockedUntil,
    });
  } catch (error) {
    if (error instanceof CooldownRequired) {
      state.blockedUntil = new Date(Date.now() + error.retryAfterMs).toISOString();
      await checkpoint(true);
      return pooledReport(state, lanes, options, initialRequests, "cooldown", {
        resumeAfter: state.blockedUntil,
        note: `Remote status ${error.status}; stopped without retrying the blocked request.`,
      });
    }
    if (error instanceof RequestBudgetExhausted) {
      await checkpoint(true);
      return pooledReport(state, lanes, options, initialRequests, "paused", { note: `This run reached its request budget (${error.budget}).` });
    }
    if (error instanceof RunCancelled) {
      await checkpoint(true);
      return pooledReport(state, lanes, options, initialRequests, "stopped", { note: "Stopped by the operator." });
    }
    await checkpoint(true);
    throw error;
  }
}

async function selectStrategy(
  client: NcmClient,
  governor: RequestGovernor,
  options: ScanOptions,
): Promise<"scan" | "history"> {
  if (options.strategy === "scan") return "scan";
  if (options.strategy === "history") return "history";
  if (!options.cookie) return "scan";

  const profile = await governor.execute("login_status", () =>
    client.getLoginProfile(options.cookie),
  );
  return profile?.userId === options.uid ? "history" : "scan";
}

async function runHistory(
  client: NcmClient,
  governor: RequestGovernor,
  options: ScanOptions,
  state: ScanState,
  writer: JsonlResultWriter,
  seenCommentIds: Set<string>,
  checkpoint: () => Promise<void>,
  initialRequests: number,
): Promise<RunReport> {
  while (true) {
    const page = await governor.execute("user_comment_history", () =>
      client.getUserCommentHistory(
        options.uid,
        options.historyPageSize,
        state.historyTime,
        options.cookie!,
      ),
    );

    const matches = page.comments.filter((comment) => comment.userId === options.uid);
    const added = await appendMatches(writer, state, seenCommentIds, matches.map((comment) => ({
      ...comment,
      route: "user-history" as const,
      capturedAt: new Date().toISOString(),
    })));

    if (added > 0 && options.stopAfterFirst) {
      await checkpoint();
      return report(state, governor, options, initialRequests, "paused", {
        note: "Stopped after the first match; rerun without --stop-after-first for full coverage.",
      });
    }

    if (!page.hasMore) {
      state.finished = true;
      state.coverageComplete = true;
      await checkpoint();
      return report(state, governor, options, initialRequests, "complete");
    }

    if (!page.nextTime || page.nextTime === state.historyTime) {
      throw new Error("History pagination returned hasMore without a new time cursor.");
    }
    state.historyTime = page.nextTime;
    await checkpoint();
  }
}

async function runSongScan(
  client: NcmClient,
  governor: RequestGovernor,
  options: ScanOptions,
  state: ScanState,
  writer: JsonlResultWriter,
  seenCommentIds: Set<string>,
  checkpoint: () => Promise<void>,
  initialRequests: number,
): Promise<RunReport> {
  let sourcesChanged = false;
  if (!state.sourcesLoaded) {
    const collected = await collectSongs(client, governor, options);
    const songs = collected.songs;
    state.sourceSongCount = songs.length;
    state.sourceTruncated = options.maxSongs > 0 && songs.length > options.maxSongs;
    state.songs = options.maxSongs > 0 ? songs.slice(0, options.maxSongs) : songs;
    state.sourceErrors = collected.failures;
    state.sourcesLoaded = true;
    ensureSongProgress(state);
    sourcesChanged = true;
  }
  const hydratedSongs = await hydrateSongsFromClient(client, governor, state.songs);
  publishSongCatalog(options, state.songs);
  if (sourcesChanged || hydratedSongs > 0) await checkpoint();

  ensureSongProgress(state);
  syncSongCursor(state);

  if (options.dryRun) {
    return report(state, governor, options, initialRequests, "dry-run", {
      note: estimateNote(state, options),
    });
  }

  while (state.songIndex < state.songs.length) {
    const song = state.songs[state.songIndex];
    const songProgress = state.songProgress![state.songIndex];
    state.commentOffset = songProgress.commentOffset;
    state.pageInSong = songProgress.pageInSong;

    if (
      options.maxCommentPagesPerSong > 0 &&
      state.pageInSong >= options.maxCommentPagesPerSong
    ) {
      markSongTruncated(state, state.songIndex);
      syncSongCursor(state);
      await checkpoint();
      continue;
    }

    const shard = songProgress.commentShards?.find((candidate) => !candidate.done);
    if (songProgress.commentShards?.length && !shard) {
      advanceSong(state);
      await checkpoint();
      continue;
    }
    const requestedCursor = shard?.cursor ?? songProgress.commentCursor!;
    const requestedPageNo = shard?.pageNo ?? songProgress.commentPageNo!;
    const page = await governor.execute(`comment_new:${song.id}`, () => {
      publishSongProgress(
        options,
        song,
        songProgress.pageInSong,
        songProgress.commentOffset,
        songProgress.totalComments,
        undefined,
        requestedPageNo,
      );
      return client.getSongCommentsByCursor(
        song.id,
        options.commentPageSize,
        requestedPageNo,
        requestedCursor,
      );
    });
    const times = shard
      ? page.comments.map((comment) => comment.time).filter((time): time is number => time !== undefined)
      : [];
    const oldestTime = times.length > 0 ? Math.min(...times) : undefined;
    const crossedShardStart = Boolean(shard && oldestTime !== undefined && oldestTime < shard.startTime);
    const nextCursor = crossedShardStart
      ? undefined
      : nextDescendingCursor(page.hasMore, page.nextCursor, requestedCursor, `song ${song.id}${shard ? ` shard ${shard.id}` : ""}`);
    const scannedComments = shard
      ? page.comments.filter((comment) => comment.time === undefined || (comment.time >= shard.startTime && comment.time < shard.endTime))
      : page.comments;

    const matches = scannedComments
      .filter((comment) => comment.userId === options.uid)
      .map<FoundComment>((comment) => ({
        ...comment,
        songId: song.id,
        songName: song.name,
        sources: song.sources,
        sourceRank: song.sourceRank,
        playCount: song.playCount,
        route: "song-comments",
        capturedAt: new Date().toISOString(),
      }));
    const added = await appendMatches(writer, state, seenCommentIds, matches);

    songProgress.pageInSong += 1;
    songProgress.commentOffset += scannedComments.length;
    songProgress.totalComments = mergeCommentTotal(songProgress.totalComments, page.total, songProgress.commentOffset);
    if (shard) {
      shard.pagesProcessed += 1;
      shard.pageNo = requestedPageNo + 1;
    } else {
      songProgress.commentPageNo = requestedPageNo + 1;
    }
    state.pageInSong = songProgress.pageInSong;
    state.commentOffset = songProgress.commentOffset;
    state.pagesProcessed = (state.pagesProcessed ?? 0) + 1;

    if (shard) {
      const numericNextCursor = nextCursor === undefined ? undefined : Number(nextCursor);
      if (nextCursor === undefined || (numericNextCursor !== undefined && numericNextCursor <= shard.startTime)) {
        shard.done = true;
      } else {
        shard.cursor = nextCursor;
      }
      if (songProgress.commentShards!.every((candidate) => candidate.done)) advanceSong(state);
    } else if (nextCursor === undefined) {
      advanceSong(state);
    } else {
      songProgress.commentCursor = nextCursor;
    }
    publishSongProgress(
      options,
      song,
      songProgress.pageInSong,
      songProgress.commentOffset,
      songProgress.totalComments,
    );
    await checkpoint();

    if (added > 0 && options.stopAfterFirst) {
      return report(state, governor, options, initialRequests, "paused", {
        note: "Stopped after the first match; rerun without --stop-after-first for full coverage.",
      });
    }
  }

  state.finished = true;
  state.coverageComplete =
    !state.sourceTruncated &&
    state.truncatedSongIds.length === 0 &&
    state.sourceErrors.length === 0;
  await checkpoint();
  return report(state, governor, options, initialRequests, "complete");
}

async function collectSongs(
  client: NcmClient,
  governor: RequestGovernor,
  options: ScanOptions,
): Promise<{ songs: SongCandidate[]; failures: string[] }> {
  const batches: SongCandidate[][] = [];
  const failures: string[] = [];
  if (options.source === "record" || options.source === "both") {
    try {
      batches.push(await governor.execute("user_record", () =>
        client.getUserRecord(options.uid, options.recordScope, options.cookie),
      ));
    } catch (error) {
      if (options.source === "record" || isPauseSignal(error)) throw error;
      failures.push(`record: ${errorMessage(error)}`);
    }
  }
  if (options.source === "likes" || options.source === "both") {
    try {
      batches.push(await governor.execute("likelist", () =>
        client.getLikedSongs(options.uid, options.cookie),
      ));
    } catch (error) {
      if (options.source === "likes" || isPauseSignal(error)) throw error;
      failures.push(`likes: ${errorMessage(error)}`);
    }
  }
  if (batches.length === 0) {
    throw new Error(`All selected song sources failed: ${failures.join("; ")}`);
  }
  return { songs: mergeSongs(batches.flat()), failures };
}

async function collectSongsPooled(
  lanes: SourceScanLane[],
  options: ScanOptions,
): Promise<{ songs: SongCandidate[]; failures: string[] }> {
  const batches: SongCandidate[][] = [];
  const failures: string[] = [];
  if (options.source === "record" || options.source === "both") {
    try {
      batches.push(await requestFromPool(lanes, "user_record", (client) =>
        client.getUserRecord(options.uid, options.recordScope, options.cookie)
      ));
    } catch (error) {
      if (options.source === "record" || isPauseSignal(error)) throw error;
      failures.push(`record: ${errorMessage(error)}`);
    }
  }
  if (options.source === "likes" || options.source === "both") {
    try {
      batches.push(await requestFromPool(lanes, "likelist", (client) =>
        client.getLikedSongs(options.uid, options.cookie)
      ));
    } catch (error) {
      if (options.source === "likes" || isPauseSignal(error)) throw error;
      failures.push(`likes: ${errorMessage(error)}`);
    }
  }
  if (batches.length === 0) throw new Error(`All selected song sources failed: ${failures.join("; ")}`);
  return { songs: mergeSongs(batches.flat()), failures };
}

async function requestFromPool<T>(
  lanes: SourceScanLane[],
  label: string,
  request: (client: NcmClient) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (const lane of lanes) {
    try {
      return await executeProxyRequest(lane, label, () => request(lane.client));
    } catch (error) {
      if (
        error instanceof AuthenticationRequired ||
        error instanceof RequestBudgetExhausted ||
        error instanceof RunCancelled
      ) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error(`${label} failed on every proxy lane.`);
}

async function requestBestEffortFromPool<T>(
  lanes: SourceScanLane[],
  label: string,
  request: (client: NcmClient) => Promise<T>,
  session?: { nextLaneIndex: number; cooldownLanes: Set<string> },
): Promise<T> {
  let lastError: unknown;
  for (let offset = 0; offset < lanes.length; offset += 1) {
    const laneIndex = ((session?.nextLaneIndex ?? 0) + offset) % lanes.length;
    const lane = lanes[laneIndex];
    if (session?.cooldownLanes.has(lane.name)) continue;
    try {
      const value = await executeBestEffortProxyRequest(lane, label, () => request(lane.client));
      if (session) session.nextLaneIndex = (laneIndex + 1) % lanes.length;
      return value;
    } catch (error) {
      if (error instanceof RunCancelled) throw error;
      if (error instanceof CooldownRequired) session?.cooldownLanes.add(lane.name);
      lastError = error;
    }
  }
  throw lastError ?? new Error(`${label} failed on every proxy lane.`);
}

async function hydrateSongsFromClient(
  client: NcmClient,
  governor: RequestGovernor,
  songs: SongCandidate[],
): Promise<number> {
  if (!client.getSongInfos) return 0;
  const namedBefore = songs.filter((song) => Boolean(song.name)).length;
  try {
    return await hydrateMissingSongMetadata(songs, (songIds) =>
      governor.executeBestEffort("song_detail_batch", () => client.getSongInfos!(songIds))
    );
  } catch (error) {
    if (error instanceof RunCancelled) throw error;
    return songs.filter((song) => Boolean(song.name)).length - namedBefore;
  }
}

async function hydrateSongsFromPool(
  lanes: SourceScanLane[],
  songs: SongCandidate[],
): Promise<number> {
  const metadataLanes = lanes.filter((lane) => Boolean(lane.client.getSongInfos));
  if (metadataLanes.length === 0) return 0;
  const namedBefore = songs.filter((song) => Boolean(song.name)).length;
  const session = { nextLaneIndex: 0, cooldownLanes: new Set<string>() };
  try {
    return await hydrateMissingSongMetadata(songs, (songIds) =>
      requestBestEffortFromPool(
        metadataLanes,
        "song_detail_batch",
        (client) => client.getSongInfos!(songIds),
        session,
      )
    );
  } catch (error) {
    if (error instanceof RunCancelled) throw error;
    return songs.filter((song) => Boolean(song.name)).length - namedBefore;
  }
}

export function mergeSongs(songs: SongCandidate[]): SongCandidate[] {
  const byId = new Map<string, SongCandidate>();
  for (const song of songs) {
    const existing = byId.get(song.id);
    if (!existing) {
      byId.set(song.id, { ...song, sources: [...song.sources] });
      continue;
    }
    for (const source of song.sources) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    }
    existing.name ??= song.name;
    existing.artists ??= song.artists;
    existing.playCount ??= song.playCount;
    existing.score ??= song.score;
  }
  return [...byId.values()];
}

async function appendMatches(
  writer: JsonlResultWriter,
  state: ScanState,
  seen: Set<string>,
  matches: FoundComment[],
): Promise<number> {
  let added = 0;
  for (const match of matches) {
    if (seen.has(match.commentId) || writer.has(match.commentId)) continue;
    if (await writer.append(match)) {
      state.seenCommentIds.push(match.commentId);
      seen.add(match.commentId);
      state.matchCount += 1;
      added += 1;
    }
  }
  return added;
}

function advanceSong(state: ScanState): void {
  ensureSongProgress(state);
  const current = state.songProgress![state.songIndex];
  if (current) current.done = true;
  syncSongCursor(state);
}

function report(
  state: ScanState,
  governor: RequestGovernor,
  options: ScanOptions,
  initialRequests: number,
  status: RunReport["status"],
  extra: Partial<RunReport> = {},
): RunReport {
  return {
    status,
    strategy: state.strategy,
    uid: state.uid,
    songs: state.songs.length,
    songsProcessed: completedSongs(state),
    matches: state.matchCount,
    requestsThisRun: governor.requestsUsed,
    requestsTotal: initialRequests + governor.requestsUsed,
    pagesProcessed: state.pagesProcessed ?? 0,
    coverageComplete: state.coverageComplete,
    sourceErrors: state.sourceErrors,
    statePath: options.statePath,
    outputPath: options.outputPath,
    ...extra,
  };
}

function pooledReport(
  state: ScanState,
  lanes: SourceScanLane[],
  options: PooledScanOptions,
  initialRequests: number,
  status: RunReport["status"],
  extra: Partial<RunReport> = {},
): RunReport {
  const requestsThisRun = pooledRequestsUsed(lanes);
  return {
    status,
    strategy: state.strategy,
    uid: state.uid,
    songs: state.songs.length,
    songsProcessed: completedSongs(state),
    matches: state.matchCount,
    requestsThisRun,
    requestsTotal: initialRequests + requestsThisRun,
    lanes: lanes.length,
    workers: lanes.length * options.workersPerLane,
    pagesProcessed: state.pagesProcessed ?? 0,
    coverageComplete: state.coverageComplete,
    sourceErrors: state.sourceErrors,
    statePath: options.statePath,
    outputPath: options.outputPath,
    ...extra,
  };
}

function ensureSongProgress(state: ScanState): void {
  const createdAt = Date.parse(state.createdAt);
  const initialCommentCursor = String(Number.isFinite(createdAt) ? createdAt : Date.now());
  if (!state.songProgress || state.songProgress.length !== state.songs.length) {
    state.songProgress = state.songs.map((_, index) => ({
      commentOffset: index === state.songIndex ? state.commentOffset : 0,
      pageInSong: index === state.songIndex ? state.pageInSong : 0,
      commentCursor: initialCommentCursor,
      commentPageNo: 1,
      done: index < state.songIndex || state.finished,
    }));
  }
  for (const progress of state.songProgress) {
    progress.commentCursor ??= initialCommentCursor;
    progress.commentPageNo ??= 1;
  }
  state.pagesProcessed ??= state.songProgress.reduce((total, progress) => total + progress.pageInSong, 0);
}

function prepareSourceWork(state: ScanState, desiredWorkItems: number, maxPages: number): SourceScanWork[] {
  ensureSongProgress(state);
  const shardTargets = new Map<number, number>();
  const unfinishedSongIndexes: number[] = [];
  let existingWorkItems = 0;
  state.songProgress!.forEach((progress, songIndex) => {
    if (progress.done) return;
    const currentWorkItems = progress.commentShards?.length
      ? progress.commentShards.filter((shard) => !shard.done).length
      : 1;
    existingWorkItems += currentWorkItems;
    shardTargets.set(songIndex, currentWorkItems);
    unfinishedSongIndexes.push(songIndex);
  });
  let extraWorkItems = Math.max(0, desiredWorkItems - existingWorkItems);
  while (extraWorkItems > 0 && unfinishedSongIndexes.length > 0) {
    let allocated = false;
    for (const songIndex of unfinishedSongIndexes) {
      if (extraWorkItems <= 0) break;
      const progress = state.songProgress![songIndex];
      const availablePages = maxPages > 0 ? maxPages - progress.pageInSong : 64;
      const currentTarget = shardTargets.get(songIndex) ?? 1;
      if (currentTarget >= Math.min(64, availablePages)) continue;
      shardTargets.set(songIndex, currentTarget + 1);
      extraWorkItems -= 1;
      allocated = true;
    }
    if (!allocated) break;
  }
  return state.songProgress!.flatMap((progress, songIndex) => {
    if (progress.done) return [];
    if (progress.commentShards?.length) {
      expandExistingSourceShards(progress, shardTargets.get(songIndex) ?? 1);
      return progress.commentShards
        .filter((shard) => !shard.done)
        .sort((left, right) => right.endTime - left.endTime)
        .map((shard) => ({ songIndex, shardId: shard.id }));
    }
    const target = shardTargets.get(songIndex) ?? 1;
    if (target > 1) {
      const shardWorks = shardRemainingSong(progress, songIndex, target, maxPages);
      if (shardWorks.length > 0) return shardWorks;
    }
    return [{ songIndex }];
  });
}

function expandExistingSourceShards(
  progress: NonNullable<ScanState["songProgress"]>[number],
  desiredShards: number,
): void {
  const shards = progress.commentShards;
  if (!shards) return;
  while (shards.filter((shard) => !shard.done).length < desiredShards) {
    const candidates = shards
      .filter((shard) => !shard.done)
      .sort((left, right) => (Number(right.cursor) - right.startTime) - (Number(left.cursor) - left.startTime));
    let expanded = false;
    for (const candidate of candidates) {
      const nextShardId = shards.reduce((maximum, shard) => Math.max(maximum, shard.id), -1) + 1;
      const pageNo = candidate.pageNo;
      const split = splitRemainingTimeShard(candidate, nextShardId);
      if (!split) continue;
      Object.assign(candidate, split.current, { pageNo });
      shards.push({ ...split.sibling, pageNo });
      expanded = true;
      break;
    }
    if (!expanded) return;
  }
}

function shardRemainingSong(
  progress: NonNullable<ScanState["songProgress"]>[number],
  songIndex: number,
  desiredShards: number,
  maxPages: number,
): SourceScanWork[] {
  if (progress.commentShards?.length) {
    return progress.commentShards
      .filter((shard) => !shard.done)
      .map((shard) => ({ songIndex, shardId: shard.id }));
  }
  const endTime = Number(progress.commentCursor);
  if (!Number.isInteger(endTime) || endTime <= SOURCE_SCAN_START_TIME) return [];
  const availablePages = maxPages > 0 ? maxPages - progress.pageInSong : 64;
  if (availablePages <= 1) return [];
  const shardCount = Math.max(2, Math.min(64, desiredShards, availablePages));
  progress.commentShards = createTimeShards(SOURCE_SCAN_START_TIME, endTime, shardCount)
    .map((shard) => ({ ...shard, pageNo: progress.commentPageNo ?? 1 }));
  return progress.commentShards.map((shard) => ({ songIndex, shardId: shard.id }));
}

function splitSourceShardIfUseful(
  progress: NonNullable<ScanState["songProgress"]>[number],
  shard: CommentTimeShard,
  songIndex: number,
  songId: string,
  waitingWorkers: number,
  options: ScanOptions,
): SourceScanWork[] {
  const currentWork = { songIndex, shardId: shard.id };
  if (waitingWorkers <= 0) return [currentWork];
  const nextShardId = progress.commentShards!.reduce(
    (maximum, candidate) => Math.max(maximum, candidate.id),
    -1,
  ) + 1;
  const split = splitRemainingTimeShard(shard, nextShardId);
  if (!split) return [currentWork];
  const { sibling, splitAt, remainingStart, remainingEnd } = split;
  const pageNo = shard.pageNo;
  Object.assign(shard, split.current, { pageNo });
  progress.commentShards!.push({ ...sibling, pageNo });
  publishSchedulerActivity(options, {
    type: "adaptive-split",
    songId,
    originalShardId: shard.id,
    newShardId: sibling.id,
    splitAt,
    remainingStart,
    remainingEnd,
    waitingWorkers,
  });
  return [currentWork, { songIndex, shardId: sibling.id }];
}

function markSongTruncated(state: ScanState, songIndex: number): void {
  const song = state.songs[songIndex];
  const progress = state.songProgress![songIndex];
  if (!state.truncatedSongIds.includes(song.id)) state.truncatedSongIds.push(song.id);
  for (const shard of progress.commentShards ?? []) shard.done = true;
  progress.done = true;
}

function syncSongCursor(state: ScanState): void {
  ensureSongProgress(state);
  const index = state.songProgress!.findIndex((progress) => !progress.done);
  state.songIndex = index < 0 ? state.songs.length : index;
  const current = index < 0 ? undefined : state.songProgress![index];
  state.commentOffset = current?.commentOffset ?? 0;
  state.pageInSong = current?.pageInSong ?? 0;
}

function completedSongs(state: ScanState): number {
  return state.songProgress?.filter((progress) => progress.done).length ?? state.songIndex;
}

function pooledRequestsUsed(lanes: SourceScanLane[]): number {
  return lanes.reduce((total, lane) => total + lane.governor.requestsUsed, 0);
}

function isPauseSignal(error: unknown): boolean {
  return error instanceof AuthenticationRequired ||
    error instanceof CooldownRequired ||
    error instanceof RequestBudgetExhausted ||
    error instanceof RunCancelled;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}

function publishSongProgress(
  options: ScanOptions,
  song: SongCandidate,
  pageInSong: number,
  commentsProcessed: number,
  totalComments: number | undefined,
  workerId?: string,
  requestingPage?: number,
): void {
  try {
    options.onSongProgress?.({
      songId: song.id,
      songName: song.name,
      workerId,
      pageInSong,
      requestingPage,
      commentsProcessed,
      totalComments,
    });
  } catch {
    // Status delivery must never interrupt the scan.
  }
}

function publishCheckpointProgress(options: ScanOptions, state: ScanState): void {
  try {
    options.onCheckpoint?.({
      songs: state.songs.length,
      songsProcessed: completedSongs(state),
      commentOffset: state.commentOffset,
      matches: state.matchCount,
      requestsTotal: state.requestCount,
      pagesProcessed: state.pagesProcessed ?? 0,
      coverageComplete: state.coverageComplete,
      sourceErrors: [...state.sourceErrors],
      blockedUntil: state.blockedUntil,
    });
  } catch {
    // Status delivery must never interrupt the scan.
  }
}

function publishSongCatalog(options: ScanOptions, songs: readonly SongCandidate[]): void {
  try {
    options.onSongCatalog?.(songs);
  } catch {
    // Optional UI metadata must never interrupt scanning.
  }
}

function publishRequestActivity(
  options: ScanOptions,
  activity: Parameters<NonNullable<ScanOptions["onRequestActivity"]>>[0],
): void {
  try {
    options.onRequestActivity?.(activity);
  } catch {
    // Diagnostic logging must never interrupt the scan.
  }
}

function publishSchedulerActivity(
  options: ScanOptions,
  activity: Parameters<NonNullable<ScanOptions["onSchedulerActivity"]>>[0],
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

function estimateNote(state: ScanState, options: ScanOptions): string {
  const cap = options.maxCommentPagesPerSong > 0
    ? `${options.maxCommentPagesPerSong} 页`
    : "全部可用页";
  return `共 ${state.songs.length} 首去重歌曲；每首最多扫描 ${cap}；每页 ${options.commentPageSize} 条评论。`;
}
