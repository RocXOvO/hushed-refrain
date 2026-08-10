import type { SongCandidate, SongInfo } from "./types";

export const SONG_METADATA_BATCH_SIZE = 500;

export async function hydrateMissingSongMetadata(
  songs: SongCandidate[],
  loadBatch: (songIds: readonly string[]) => Promise<readonly SongInfo[]>,
  batchSize = SONG_METADATA_BATCH_SIZE,
): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("song metadata batch size must be a positive integer");
  }
  const missingSongsById = new Map<string, SongCandidate[]>();
  for (const song of songs) {
    if (song.name) continue;
    const candidates = missingSongsById.get(song.id) ?? [];
    candidates.push(song);
    missingSongsById.set(song.id, candidates);
  }
  const missingIds = [...missingSongsById.keys()];
  if (missingIds.length === 0) return 0;

  let hydrated = 0;
  for (let index = 0; index < missingIds.length; index += batchSize) {
    const batch = missingIds.slice(index, index + batchSize);
    for (const detail of await loadBatch(batch)) {
      if (!detail.name) continue;
      const candidates = missingSongsById.get(detail.id);
      if (!candidates) continue;
      for (const song of candidates) {
        song.name = detail.name;
        if (detail.artists?.length) song.artists = [...detail.artists];
        if (Number.isFinite(detail.publishTime)) song.publishTime = detail.publishTime;
        hydrated += 1;
      }
      missingSongsById.delete(detail.id);
    }
  }
  return hydrated;
}
