import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ScanOptions, ScanState } from "./types";

export function createState(
  options: ScanOptions,
  strategy: "scan" | "history",
): ScanState {
  const now = new Date().toISOString();
  return {
    version: 1,
    commentPagination: "cursor-v1",
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
    songIndex: 0,
    commentOffset: 0,
    pageInSong: 0,
    historyTime: 0,
    seenCommentIds: [],
    matchCount: 0,
    requestCount: 0,
    pagesProcessed: 0,
    truncatedSongIds: [],
    finished: false,
    coverageComplete: false,
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadState(path: string): Promise<ScanState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ScanState;
    if (parsed.version !== 1) throw new Error(`Unsupported state version: ${parsed.version}`);
    parsed.strategyResolved ??= true;
    parsed.sourcesLoaded ??= parsed.songs.length > 0 || parsed.sourceSongCount > 0 || parsed.finished;
    parsed.sourceErrors ??= [];
    parsed.songProgress ??= parsed.songs.map((_, index) => ({
      commentOffset: index === parsed.songIndex ? parsed.commentOffset : 0,
      pageInSong: index === parsed.songIndex ? parsed.pageInSong : 0,
      done: index < parsed.songIndex || parsed.finished,
    }));
    parsed.pagesProcessed ??= parsed.songProgress.reduce((total, progress) => total + progress.pageInSong, 0);
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveState(path: string, state: ScanState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export function assertCompatibleState(state: ScanState, options: ScanOptions): void {
  const mismatches: string[] = [];
  if (state.uid !== options.uid) mismatches.push("uid");
  if (state.source !== options.source) mismatches.push("source");
  if (state.recordScope !== options.recordScope) mismatches.push("recordScope");
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
