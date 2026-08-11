import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { readAtomicJson, removeAtomicFile, writeAtomicJson } from "./atomic-file";
import {
  commentScopeComplete,
  includesCommentFloors,
  normalizeCommentFloorThreads,
} from "./comment-floor";
import type { ScanOptions, ScanState } from "./types";

export const SOURCE_CATALOG_VERSION = 3;
export const SOURCE_STATE_VERSION = 4;
export const SOURCE_RESULT_VERSION = 3;
export const SOURCE_COVERAGE_VERSION = 4;

export function createState(
  options: ScanOptions,
  strategy: "scan" | "history",
): ScanState {
  const now = new Date().toISOString();
  return {
    version: 4,
    commentPagination: "cursor-v1",
    commentScope: options.commentScope,
    commentPageSize: options.commentPageSize,
    uid: options.uid,
    strategy,
    strategyResolved: options.strategy !== "auto",
    source: options.source,
    recordScope: options.recordScope,
    sourcesLoaded: strategy === "history",
    songs: [],
    songProgress: [],
    sourceSongCount: 0,
    sourceTruncated: false,
    sourceErrors: [],
    sourceCatalogVersion: SOURCE_CATALOG_VERSION,
    reusedSongs: 0,
    historicalCompletedSongs: 0,
    newPendingSongs: 0,
    songIndex: 0,
    commentOffset: 0,
    pageInSong: 0,
    historyTime: 0,
    seenCommentIds: [],
    matchCount: 0,
    requestCount: 0,
    pagesProcessed: 0,
    floorPagesProcessed: 0,
    replyCommentsInspected: 0,
    truncatedSongIds: [],
    finished: false,
    coverageComplete: false,
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadState(path: string): Promise<ScanState | undefined> {
  return readAtomicJson(path, (value) => {
    const parsed = value as ScanState;
    if (![1, 2, 3, 4].includes(parsed.version)) throw new Error(`Unsupported state version: ${parsed.version}`);
    const needsFloorRescan = parsed.version < 4 && parsed.strategy === "scan";
    parsed.version = 4;
    parsed.commentScope ??= "root-and-floor-v1";
    if (parsed.commentScope !== "root-only-v1" && parsed.commentScope !== "root-and-floor-v1") {
      throw new Error("Invalid comment scope in source checkpoint.");
    }
    parsed.strategyResolved ??= true;
    parsed.sourcesLoaded ??= parsed.songs.length > 0 || parsed.sourceSongCount > 0 || parsed.finished;
    parsed.sourceErrors ??= [];
    parsed.reusedSongs ??= 0;
    parsed.historicalCompletedSongs ??= 0;
    parsed.newPendingSongs ??= 0;
    parsed.songProgress ??= parsed.songs.map((_, index) => ({
      commentOffset: index === parsed.songIndex ? parsed.commentOffset : 0,
      pageInSong: index === parsed.songIndex ? parsed.pageInSong : 0,
      done: index < parsed.songIndex || parsed.finished,
    }));
    for (const progress of parsed.songProgress) {
      progress.floorThreads = normalizeCommentFloorThreads(progress.floorThreads);
      if (!includesCommentFloors(parsed.commentScope) && progress.floorThreads.length > 0) {
        throw new Error("Root-only source checkpoint contains comment floor work.");
      }
      progress.rootDone ??= progress.done;
      progress.done = commentScopeComplete(parsed.commentScope, Boolean(progress.rootDone), progress.floorThreads);
      progress.floorPagesProcessed ??= progress.floorThreads.reduce((total, thread) => total + thread.pagesProcessed, 0);
      progress.replyCommentsProcessed ??= progress.floorThreads.reduce((total, thread) => total + thread.repliesProcessed, 0);
      for (const shard of progress.commentShards ?? []) {
        if (!Number.isInteger(shard.pageNo) || shard.pageNo < 2) shard.pageNo = 2;
      }
      if (!Number.isInteger(progress.commentEndTime)) {
        const shardEndTime = Math.max(
          ...((progress.commentShards ?? [])
            .map((shard) => shard.endTime)
            .filter((value) => Number.isInteger(value))),
          Number.NEGATIVE_INFINITY,
        );
        const initialCursor = progress.pageInSong === 0 ? Number(progress.commentCursor) : Number.NaN;
        progress.commentEndTime = Number.isInteger(shardEndTime)
          ? shardEndTime
          : Number.isInteger(initialCursor)
          ? initialCursor
          : undefined;
      }
    }
    parsed.pagesProcessed ??= parsed.songProgress.reduce((total, progress) => total + progress.pageInSong, 0);
    parsed.floorPagesProcessed ??= parsed.songProgress.reduce((total, progress) => total + (progress.floorPagesProcessed ?? 0), 0);
    parsed.replyCommentsInspected ??= parsed.songProgress.reduce((total, progress) => total + (progress.replyCommentsProcessed ?? 0), 0);
    if (parsed.strategy === "scan") {
      parsed.finished = parsed.songProgress.every((progress) =>
        commentScopeComplete(parsed.commentScope!, Boolean(progress.rootDone), progress.floorThreads)
      );
      parsed.coverageComplete &&= parsed.finished;
    }
    if (needsFloorRescan) {
      for (const progress of parsed.songProgress) {
        const rescanEndTime = Number.isInteger(progress.commentEndTime)
          ? progress.commentEndTime!
          : Date.parse(parsed.createdAt);
        progress.commentOffset = 0;
        progress.totalComments = undefined;
        progress.pageInSong = 0;
        progress.floorPagesProcessed = 0;
        progress.replyCommentsProcessed = 0;
        progress.commentCursor = String(Number.isInteger(rescanEndTime) ? rescanEndTime : Date.now());
        progress.commentPageNo = 1;
        progress.commentShards = undefined;
        progress.floorThreads = [];
        progress.rootDone = false;
        progress.done = false;
      }
      parsed.songIndex = 0;
      parsed.commentOffset = 0;
      parsed.pageInSong = 0;
      parsed.pagesProcessed = 0;
      parsed.floorPagesProcessed = 0;
      parsed.replyCommentsInspected = 0;
      parsed.truncatedSongIds = [];
      parsed.finished = false;
      parsed.coverageComplete = false;
    }
    return parsed;
  });
}

export async function saveState(path: string, state: ScanState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeAtomicJson(path, state);
}

/**
 * Moves the one legacy checkpoint shape that used the all-time path for a
 * weekly scan into its scoped path. The target is made durable and verified
 * before the conflicting legacy document and its recovery files are removed.
 */
export async function migrateLegacyWeekState(
  legacyPath: string,
  targetPath: string,
  uid: string,
  source: "record" | "both",
): Promise<boolean> {
  await mkdir(dirname(legacyPath), { recursive: true });
  const release = await lockfile.lock(legacyPath, {
    realpath: false,
    stale: 120_000,
    update: 20_000,
    retries: { retries: 40, factor: 1.2, minTimeout: 5, maxTimeout: 100, randomize: true },
  });
  try {
    const legacy = await loadState(legacyPath);
    if (!isMatchingLegacyWeekState(legacy, uid, source)) return false;

    const current = await loadState(targetPath);
    if (current && !isMatchingLegacyWeekState(current, uid, source)) {
      throw new Error("Scoped weekly checkpoint does not match the legacy checkpoint identity.");
    }
    if (!current) {
      await writeAtomicJson(targetPath, legacy);
    }
    const verified = await loadState(targetPath);
    if (!isMatchingLegacyWeekState(verified, uid, source)) {
      throw new Error("Weekly checkpoint migration could not verify its durable target.");
    }
    await removeAtomicFile(legacyPath);
    return true;
  } finally {
    await release().catch(() => {});
  }
}

function isMatchingLegacyWeekState(
  state: ScanState | undefined,
  uid: string,
  source: "record" | "both",
): state is ScanState {
  return state?.uid === uid && state.source === source && state.recordScope === "week";
}

export function assertCompatibleState(state: ScanState, options: ScanOptions): void {
  const mismatches: string[] = [];
  if (state.uid !== options.uid) mismatches.push("uid");
  if (state.source !== options.source) mismatches.push("source");
  if (state.recordScope !== options.recordScope) mismatches.push("recordScope");
  if (state.commentScope !== options.commentScope) mismatches.push("commentScope");
  if (
    (options.source === "likes" || options.source === "playlists" || options.source === "both" || options.source === "all") &&
    state.sourceCatalogVersion !== SOURCE_CATALOG_VERSION
  ) mismatches.push("目标用户喜欢歌曲目录版本");
  if (options.strategy !== "auto" && state.strategy !== options.strategy) {
    mismatches.push("strategy");
  }
  if (
    state.strategy === "scan" &&
    state.commentPagination === "cursor-v1" &&
    state.commentPageSize !== options.commentPageSize
  ) {
    mismatches.push("commentPageSize");
  }
  if (mismatches.length > 0) {
    throw new Error(
      `State file does not match current options (${mismatches.join(", ")}); use another --state path or --fresh`,
    );
  }
  if (state.strategy === "scan" && state.commentPagination !== "cursor-v1") {
    migrateLegacyOffsetState(state, options);
  }
}

function migrateLegacyOffsetState(state: ScanState, options: ScanOptions): void {
  const createdAt = Date.parse(state.createdAt);
  const initialCommentCursor = String(Number.isFinite(createdAt) ? createdAt : Date.now());
  const truncated = new Set(state.truncatedSongIds);
  let resetPages = 0;
  let resetAny = false;

  for (let index = 0; index < state.songs.length; index += 1) {
    const progress = state.songProgress![index];
    const shouldReset = !progress.done || truncated.has(state.songs[index].id);
    if (!shouldReset) continue;
    resetPages += progress.pageInSong;
    progress.commentOffset = 0;
    progress.pageInSong = 0;
    progress.commentEndTime = Number(initialCommentCursor);
    progress.commentCursor = initialCommentCursor;
    progress.commentPageNo = 1;
    progress.done = false;
    truncated.delete(state.songs[index].id);
    resetAny = true;
  }

  state.commentPagination = "cursor-v1";
  state.commentPageSize = options.commentPageSize;
  state.truncatedSongIds = [...truncated];
  if (!resetAny) return;
  state.finished = false;
  state.coverageComplete = false;
  state.pagesProcessed = Math.max(0, (state.pagesProcessed ?? 0) - resetPages);
  const nextIndex = state.songProgress!.findIndex((progress) => !progress.done);
  state.songIndex = nextIndex < 0 ? state.songs.length : nextIndex;
  state.commentOffset = nextIndex < 0 ? 0 : state.songProgress![nextIndex].commentOffset;
  state.pageInSong = nextIndex < 0 ? 0 : state.songProgress![nextIndex].pageInSong;
}
