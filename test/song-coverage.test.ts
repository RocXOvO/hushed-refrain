import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSongCoverage, mergeSongCoverage } from "../src/song-coverage";

test("concurrent coverage updates merge song IDs without last-writer loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-coverage-lock-"));
  const path = join(directory, "coverage.json");

  await Promise.all(Array.from({ length: 12 }, (_, index) =>
    mergeSongCoverage(path, "42", [`song-${index}`])
  ));

  const ledger = await loadSongCoverage(path, "42");
  assert.deepEqual(Object.keys(ledger.songs).sort(), Array.from({ length: 12 }, (_, index) => `song-${index}`).sort());
});

test("coverage owner mismatch is rejected instead of crossing UID boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-coverage-owner-"));
  const path = join(directory, "coverage.json");
  await mergeSongCoverage(path, "42", ["A"]);

  await assert.rejects(loadSongCoverage(path, "99"), /UID|owner/i);
});
