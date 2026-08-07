import {
  AuthenticationRequired,
  CooldownRequired,
  RequestBudgetExhausted,
  RunCancelled,
} from "./errors";
import { RequestGovernor } from "./governor";
import { LaneRecovery } from "./lane-recovery";
import { executeProxyRequest, type ProxyTransportGate } from "./proxy-transport-gate";
import { mergeCommentTotal } from "./progress";
import { nextDescendingCursor } from "./cursor-pagination";
import { JsonlResultWriter } from "./results";
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
    const snapshot = structuredClone(state);
    checkpointTail = checkpointTail.then(() => saveState(options.statePath, snapshot));
    await checkpointTail;
  };

  try {
    state.strategy = "scan";
    state.strategyResolved = true;
    if (!state.sourcesLoaded) {
      const collected = await collectSongsPooled(lanes, options);
      state.sourceSongCount = collected.songs.length;
      state.sourceTruncated = options.maxSongs > 0 && collected.songs.length > options.maxSongs;
      state.songs = options.maxSongs > 0 ? collected.songs.slice(0, options.maxSongs) : collected.songs;
      state.sourceErrors = collected.failures;
      state.sourcesLoaded = true;
      ensureSongProgress(state);
      await checkpoint(true);
    }

    ensureSongProgress(state);
    if (options.dryRun) {
      return pooledReport(state, lanes, options, initialRequests, "dry-run", {
        note: estimateNote(state, options),
      });
    }
    if (state.finished) return pooledReport(state, lanes, options, initialRequests, "complete");

    const queue = new AsyncWorkQueue<SourceScanWork>(
      prepareSourceWork(state),
    );
    const blockedLanes = new Map<string, number>();
    const laneRecovery = new Map(lanes.map((lane) => [lane.name, new LaneRecovery()]));
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

    const stopScheduling = (): void => {
      stopRequested = true;
      queue.stop();
      for (const waiters of songPermitWaiters.values()) {
        for (const resolveWaiter of waiters) resolveWaiter();
        waiters.clear();
      }
    };

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

    const scanSongPage = async (lane: SourceScanLane, work: SourceScanWork): Promise<SourceScanWork[]> => {
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
        operation: "comment-page" as const,
        songId: song.id,
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
            progress.pageInSong + 1,
            progress.commentOffset,
            progress.totalComments,
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
      publishRequestActivity(options, {
        ...requestActivity,
        phase: "success",
        elapsedMs: Date.now() - requestStartedAt,
        comments: page.comments.length,
        totalComments: page.total,
        hasMore: page.hasMore,
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
      if (options.maxCommentPagesPerSong > 0 && progress.pageInSong >= options.maxCommentPagesPerSong) {
        markSongTruncated(state, songIndex);
      } else if (shard) {
        const numericNextCursor = nextCursor === undefined ? undefined : Number(nextCursor);
        const cursorPassedStart = numericNextCursor !== undefined && numericNextCursor <= shard.startTime;
        if (nextCursor === undefined || cursorPassedStart) {
          shard.done = true;
        } else {
          shard.cursor = nextCursor;
          nextWork = splitSourceShardIfUseful(
            progress,
            shard,
            songIndex,
            song.id,
            queue.waitingCount(),
            options,
          );
        }
        progress.done = progress.commentShards!.every((candidate) => candidate.done);
        if (!progress.done && nextWork.length === 0 && !shard.done) nextWork = [work];
      } else if (nextCursor === undefined) {
        progress.done = true;
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
      );
      await checkpoint();
      if (added > 0 && options.stopAfterFirst) {
        matched = true;
        stopScheduling();
      }
      return stopRequested || progress.done ? [] : nextWork;
    };

    const runWorker = async (lane: SourceScanLane): Promise<void> => {
      const recovery = laneRecovery.get(lane.name)!;
      while (!stopRequested && !blockedLanes.has(lane.name)) {
        await recovery.waitUntilReady();
        if (stopRequested || blockedLanes.has(lane.name)) return;
        const work = await queue.take();
        if (work === undefined) return;
        let requeue: SourceScanWork[] = [];
        try {
          if (blockedLanes.has(lane.name)) {
            requeue = stopRequested ? [] : [work];
            return;
          }
          requeue = await scanSongPage(lane, work);
          recovery.recordSuccess();
        } catch (error) {
          if (error instanceof CooldownRequired) {
            blockedLanes.set(lane.name, error.retryAfterMs);
            requeue = state.songProgress![work.songIndex].done ? [] : [work];
            if (blockedLanes.size === lanes.length) {
              requeue = [];
              stopScheduling();
            }
            return;
          }
          if (error instanceof SourceLaneFailure) {
            recovery.recordFailure();
            requeue = state.songProgress![work.songIndex].done ? [] : [work];
            return;
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
          queue.complete(requeue.length > 0 ? requeue : undefined);
        }
      }
    };

    await Promise.all(lanes.flatMap((lane) =>
      Array.from({ length: options.workersPerLane }, () => runWorker(lane))
    ));
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
  if (!state.sourcesLoaded) {
    const collected = await collectSongs(client, governor, options);
    const songs = collected.songs;
    state.sourceSongCount = songs.length;
    state.sourceTruncated = options.maxSongs > 0 && songs.length > options.maxSongs;
    state.songs = options.maxSongs > 0 ? songs.slice(0, options.maxSongs) : songs;
    state.sourceErrors = collected.failures;
    state.sourcesLoaded = true;
    ensureSongProgress(state);
    await checkpoint();
  }

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
        songProgress.pageInSong + 1,
        songProgress.commentOffset,
        songProgress.totalComments,
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

function prepareSourceWork(state: ScanState): SourceScanWork[] {
  ensureSongProgress(state);
  return state.songProgress!.flatMap((progress, songIndex) => {
    if (progress.done) return [];
    if (progress.commentShards?.length) {
      return progress.commentShards
        .filter((shard) => !shard.done)
        .sort((left, right) => right.endTime - left.endTime)
        .map((shard) => ({ songIndex, shardId: shard.id }));
    }
    return [{ songIndex }];
  });
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
  progress.commentShards = createTimeShards(SOURCE_SCAN_START_TIME, endTime, shardCount);
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
  Object.assign(shard, split.current);
  progress.commentShards!.push(sibling);
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
): void {
  try {
    options.onSongProgress?.({
      songId: song.id,
      songName: song.name,
      pageInSong,
      commentsProcessed,
      totalComments,
    });
  } catch {
    // Status delivery must never interrupt the scan.
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
