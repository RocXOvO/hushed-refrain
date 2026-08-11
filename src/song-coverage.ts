import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { readAtomicJson, writeAtomicJson } from "./atomic-file";
import type { CommentScope } from "./types";

export const SONG_COVERAGE_VERSION = 4 as const;

export interface SongCoverageEntry {
  completedAt: string;
}

export interface SongCoverageLedger {
  version: typeof SONG_COVERAGE_VERSION;
  uid: string;
  commentScope: CommentScope;
  songs: Record<string, SongCoverageEntry>;
  updatedAt: string;
}

export async function loadSongCoverage(
  path: string,
  uid: string,
  commentScope: CommentScope = "root-and-floor-v1",
): Promise<SongCoverageLedger> {
  return (await readAtomicJson(path, (value) => decodeCoverage(value, uid, commentScope))) ?? emptyCoverage(uid, commentScope);
}

export async function mergeSongCoverage(
  path: string,
  uid: string,
  commentScopeOrSongIds: CommentScope | readonly string[],
  maybeSongIds?: readonly string[],
): Promise<SongCoverageLedger> {
  const commentScope = Array.isArray(commentScopeOrSongIds)
    ? "root-and-floor-v1"
    : commentScopeOrSongIds as CommentScope;
  const songIds = Array.isArray(commentScopeOrSongIds) ? commentScopeOrSongIds : maybeSongIds ?? [];
  const normalizedIds = [...new Set(songIds.map(String).filter(Boolean))];
  if (normalizedIds.length === 0) return loadSongCoverage(path, uid, commentScope);
  await mkdir(dirname(path), { recursive: true });
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: 120_000,
    update: 20_000,
    retries: {
      retries: 40,
      factor: 1.2,
      minTimeout: 5,
      maxTimeout: 100,
      randomize: true,
    },
  });
  try {
    const ledger = await loadSongCoverage(path, uid, commentScope);
    const completedAt = new Date().toISOString();
    let changed = false;
    for (const songId of normalizedIds) {
      if (ledger.songs[songId]) continue;
      ledger.songs[songId] = { completedAt };
      changed = true;
    }
    if (!changed) return ledger;
    ledger.updatedAt = completedAt;
    await writeAtomicJson(path, ledger);
    return ledger;
  } finally {
    await release().catch(() => {});
  }
}

function emptyCoverage(uid: string, commentScope: CommentScope): SongCoverageLedger {
  return {
    version: SONG_COVERAGE_VERSION,
    uid,
    commentScope,
    songs: {},
    updatedAt: new Date(0).toISOString(),
  };
}

function decodeCoverage(
  value: unknown,
  expectedUid: string,
  expectedScope: CommentScope,
): SongCoverageLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Song coverage ledger is malformed.");
  }
  const candidate = value as Partial<SongCoverageLedger>;
  if (candidate.version !== SONG_COVERAGE_VERSION) {
    throw new Error(`Unsupported song coverage version: ${String(candidate.version)}`);
  }
  if (candidate.uid !== expectedUid) {
    throw new Error("Song coverage UID owner does not match the current task.");
  }
  const storedScope = candidate.commentScope ?? "root-and-floor-v1";
  if (storedScope !== expectedScope) {
    throw new Error("Song coverage scope does not match the current task.");
  }
  if (!candidate.songs || typeof candidate.songs !== "object" || Array.isArray(candidate.songs)) {
    throw new Error("Song coverage ledger has an invalid song map.");
  }
  const songs: Record<string, SongCoverageEntry> = {};
  for (const [songId, entry] of Object.entries(candidate.songs)) {
    if (!songId || !entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Song coverage ledger has an invalid song entry.");
    }
    const completedAt = (entry as Partial<SongCoverageEntry>).completedAt;
    if (typeof completedAt !== "string" || !Number.isFinite(Date.parse(completedAt))) {
      throw new Error("Song coverage ledger has an invalid completion timestamp.");
    }
    songs[songId] = { completedAt };
  }
  return {
    version: SONG_COVERAGE_VERSION,
    uid: expectedUid,
    commentScope: expectedScope,
    songs,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
  };
}
