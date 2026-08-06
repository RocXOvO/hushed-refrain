import { CooldownRequired, RequestBudgetExhausted, RunCancelled } from "./errors";
import { RequestGovernor } from "./governor";
import { JsonlResultWriter } from "./results";
import {
  assertCompatibleState,
  createState,
  loadState,
  saveState,
} from "./state";
import type {
  FoundComment,
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

  const writer = new JsonlResultWriter(options.outputPath);
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
  const writer = new JsonlResultWriter(options.outputPath);
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

    const queue = state.songs.map((_, index) => index).filter((index) => !state.songProgress![index].done);
    const blockedLanes = new Map<string, number>();
    const failedLanes = new Map<string, string>();
    let reservedRequests = pooledRequestsUsed(lanes);
    let stopRequested = false;
    let budgetReached = false;
    let cancelled = false;
    let matched = false;
    let fatalError: unknown;

    const reserveRequest = (): boolean => {
      if (stopRequested) return false;
      if (options.requestBudget > 0 && reservedRequests >= options.requestBudget) {
        budgetReached = true;
        stopRequested = true;
        return false;
      }
      reservedRequests += 1;
      return true;
    };

    const scanSong = async (lane: SourceScanLane, index: number): Promise<void> => {
      const song = state.songs[index];
      const progress = state.songProgress![index];
      while (!stopRequested && !progress.done) {
        if (options.maxCommentPagesPerSong > 0 && progress.pageInSong >= options.maxCommentPagesPerSong) {
          if (!state.truncatedSongIds.includes(song.id)) state.truncatedSongIds.push(song.id);
          progress.done = true;
          break;
        }
        if (!reserveRequest()) return;
        let page;
        try {
          page = await lane.governor.execute(`comment_music:${song.id}`, () =>
            lane.client.getSongComments(song.id, options.commentPageSize, progress.commentOffset, options.cookie),
          );
        } catch (error) {
          if (error instanceof CooldownRequired || error instanceof RequestBudgetExhausted || error instanceof RunCancelled) throw error;
          throw new SourceLaneFailure(lane.name, error);
        }

        progress.pageInSong += 1;
        progress.commentOffset += options.commentPageSize;
        state.pagesProcessed = (state.pagesProcessed ?? 0) + 1;
        const matches = [...page.hotComments, ...page.comments]
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
        if (!page.more || page.comments.length === 0) {
          progress.done = true;
        } else if (options.maxCommentPagesPerSong > 0 && progress.pageInSong >= options.maxCommentPagesPerSong) {
          if (!state.truncatedSongIds.includes(song.id)) state.truncatedSongIds.push(song.id);
          progress.done = true;
        }
        syncSongCursor(state);
        await checkpoint();
        if (added > 0 && options.stopAfterFirst) {
          matched = true;
          stopRequested = true;
          return;
        }
      }
      syncSongCursor(state);
      await checkpoint();
    };

    const runWorker = async (lane: SourceScanLane): Promise<void> => {
      while (!stopRequested && !blockedLanes.has(lane.name) && !failedLanes.has(lane.name)) {
        const index = queue.shift();
        if (index === undefined) return;
        try {
          await scanSong(lane, index);
          if (!state.songProgress![index].done && !stopRequested) queue.push(index);
        } catch (error) {
          if (error instanceof CooldownRequired) {
            blockedLanes.set(lane.name, error.retryAfterMs);
            if (!state.songProgress![index].done) queue.push(index);
            if (blockedLanes.size + failedLanes.size === lanes.length) stopRequested = true;
            return;
          }
          if (error instanceof SourceLaneFailure) {
            failedLanes.set(lane.name, errorMessage(error.original));
            if (!state.songProgress![index].done) queue.push(index);
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

    await Promise.all(lanes.flatMap((lane) =>
      Array.from({ length: options.workersPerLane }, () => runWorker(lane))
    ));
    syncSongCursor(state);
    state.finished = state.songProgress!.every((progress) => progress.done);
    state.coverageComplete = state.finished && !state.sourceTruncated && state.truncatedSongIds.length === 0 && state.sourceErrors.length === 0;
    if (!state.finished && blockedLanes.size > 0 && blockedLanes.size + failedLanes.size === lanes.length) {
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
      failedLanes.size > 0 ? `暂时失效的出口：${[...failedLanes.keys()].join(", ")}。` : undefined,
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
      if (!state.truncatedSongIds.includes(song.id)) state.truncatedSongIds.push(song.id);
      advanceSong(state);
      await checkpoint();
      continue;
    }

    const page = await governor.execute(`comment_music:${song.id}`, () =>
      client.getSongComments(
        song.id,
        options.commentPageSize,
        state.commentOffset,
        options.cookie,
      ),
    );

    const matches = [...page.hotComments, ...page.comments]
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
    songProgress.commentOffset += options.commentPageSize;
    state.pageInSong = songProgress.pageInSong;
    state.commentOffset = songProgress.commentOffset;
    state.pagesProcessed = (state.pagesProcessed ?? 0) + 1;

    if (!page.more || page.comments.length === 0) advanceSong(state);
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
      return await lane.governor.execute(label, () => request(lane.client));
    } catch (error) {
      if (error instanceof RequestBudgetExhausted || error instanceof RunCancelled) throw error;
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
  if (state.songProgress && state.songProgress.length === state.songs.length) return;
  state.songProgress = state.songs.map((_, index) => ({
    commentOffset: index === state.songIndex ? state.commentOffset : 0,
    pageInSong: index === state.songIndex ? state.pageInSong : 0,
    done: index < state.songIndex || state.finished,
  }));
  state.pagesProcessed ??= state.songProgress.reduce((total, progress) => total + progress.pageInSong, 0);
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
  return error instanceof CooldownRequired ||
    error instanceof RequestBudgetExhausted ||
    error instanceof RunCancelled;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}

function estimateNote(state: ScanState, options: ScanOptions): string {
  const cap = options.maxCommentPagesPerSong > 0
    ? `${options.maxCommentPagesPerSong} 页`
    : "全部可用页";
  return `共 ${state.songs.length} 首去重歌曲；每首最多扫描 ${cap}；每页 ${options.commentPageSize} 条评论。`;
}
