import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { readAtomicJson, writeAtomicJson } from "./atomic-file";

export const SONG_COVERAGE_VERSION = 3 as const;

export interface SongCoverageEntry {
  completedAt: string;
}

export interface SongCoverageLedger {
  version: typeof SONG_COVERAGE_VERSION;
  uid: string;
  songs: Record<string, SongCoverageEntry>;
  updatedAt: string;
}

export async function loadSongCoverage(path: string, uid: string): Promise<SongCoverageLedger> {
  return (await readAtomicJson(path, (value) => decodeCoverage(value, uid))) ?? emptyCoverage(uid);
}

export async function mergeSongCoverage(
  path: string,
  uid: string,
  songIds: readonly string[],
): Promise<SongCoverageLedger> {
  const normalizedIds = [...new Set(songIds.map(String).filter(Boolean))];
  if (normalizedIds.length === 0) return loadSongCoverage(path, uid);
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
    const ledger = await loadSongCoverage(path, uid);
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

function emptyCoverage(uid: string): SongCoverageLedger {
  return {
    version: SONG_COVERAGE_VERSION,
    uid,
    songs: {},
    updatedAt: new Date(0).toISOString(),
  };
}

function decodeCoverage(value: unknown, expectedUid: string): SongCoverageLedger {
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
    songs,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
  };
}
