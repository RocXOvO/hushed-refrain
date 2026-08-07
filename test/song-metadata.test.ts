import assert from "node:assert/strict";
import { test } from "node:test";
import { hydrateMissingSongMetadata } from "../src/song-metadata";

test("hydrates only unnamed songs in bounded batches", async () => {
  const songs = [
    { id: "1", sources: ["likes" as const] },
    { id: "2", name: "already known", sources: ["record" as const] },
    { id: "3", sources: ["likes" as const] },
  ];
  const batches: string[][] = [];

  const hydrated = await hydrateMissingSongMetadata(songs, async (ids) => {
    batches.push([...ids]);
    return ids.map((id) => ({ id, name: `song-${id}`, artists: [`artist-${id}`] }));
  }, 1);

  assert.equal(hydrated, 2);
  assert.deepEqual(batches, [["1"], ["3"]]);
  assert.deepEqual(songs.map((song) => song.name), ["song-1", "already known", "song-3"]);
});

test("skips the metadata API when every song already has a name", async () => {
  let calls = 0;
  const songs = [{ id: "1", name: "known", sources: ["record" as const] }];
  const hydrated = await hydrateMissingSongMetadata(songs, async () => {
    calls += 1;
    return [];
  });
  assert.equal(hydrated, 0);
  assert.equal(calls, 0);
});

test("keeps an applied first batch when a later metadata batch fails", async () => {
  const songs = Array.from({ length: 501 }, (_, index) => ({
    id: String(index + 1),
    sources: ["likes" as const],
  }));
  let calls = 0;

  await assert.rejects(hydrateMissingSongMetadata(songs, async (ids) => {
    calls += 1;
    if (calls === 2) throw new Error("second batch failed");
    return ids.map((id) => ({ id, name: `song-${id}` }));
  }), /second batch failed/);

  assert.equal(calls, 2);
  assert.equal(songs.filter((song) => Boolean(song.name)).length, 500);
  assert.equal(songs[0].name, "song-1");
  assert.equal(songs[500].name, undefined);
});

test("hydrates duplicate candidates without rescanning the full song list per batch", async () => {
  const songs = [
    { id: "1", sources: ["record" as const] },
    { id: "1", sources: ["likes" as const] },
    { id: "2", sources: ["likes" as const] },
  ];

  const hydrated = await hydrateMissingSongMetadata(songs, async (ids) =>
    ids.map((id) => ({ id, name: `song-${id}` })), 1);

  assert.equal(hydrated, 3);
  assert.deepEqual(songs.map((song) => song.name), ["song-1", "song-1", "song-2"]);
});
