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
  if (mismatches.length > 0) {
    throw new Error(
      `State file does not match current options (${mismatches.join(", ")}); use another --state path or --fresh`,
    );
  }
}
