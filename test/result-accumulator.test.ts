import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ResultAccumulator } from "../src/result-accumulator";
import { JsonlResultWriter } from "../src/results";
import type { FoundComment } from "../src/types";

function record(commentId: string): FoundComment {
  return {
    commentId,
    userId: "42",
    content: `comment ${commentId}`,
    songId: "1",
    route: "song-comments",
    capturedAt: "2026-08-07T00:00:00.000Z",
  };
}

test("counts an existing JSONL row once for a fresh checkpoint without appending it again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-result-accumulator-existing-"));
  const outputPath = join(directory, "results.jsonl");
  await writeFile(outputPath, `${JSON.stringify(record("existing"))}\n`, "utf8");
  const writer = new JsonlResultWriter(outputPath);
  await writer.initialize();
  const checkpoint = { seenCommentIds: [] as string[], matchCount: 0 };
  const accumulator = new ResultAccumulator(writer, checkpoint);

  assert.deepEqual(await accumulator.record(record("existing")), {
    counted: true,
    persisted: false,
  });
  assert.deepEqual(await accumulator.record(record("existing")), {
    counted: false,
    persisted: false,
  });
  assert.deepEqual(checkpoint, { seenCommentIds: ["existing"], matchCount: 1 });
  assert.equal((await readFile(outputPath, "utf8")).trim().split(/\r?\n/).length, 1);
});

test("serializes concurrent duplicate observations into one checkpoint and one JSONL row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-result-accumulator-concurrent-"));
  const outputPath = join(directory, "results.jsonl");
  const writer = new JsonlResultWriter(outputPath);
  await writer.initialize();
  const checkpoint = { seenCommentIds: [] as string[], matchCount: 0 };
  const accumulator = new ResultAccumulator(writer, checkpoint);

  const outcomes = await Promise.all([
    accumulator.record(record("same")),
    accumulator.record(record("same")),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.counted).length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.persisted).length, 1);
  assert.deepEqual(checkpoint, { seenCommentIds: ["same"], matchCount: 1 });
  assert.equal((await readFile(outputPath, "utf8")).trim().split(/\r?\n/).length, 1);
});

test("does not mutate checkpoint state when persistence fails", async () => {
  const checkpoint = { seenCommentIds: [] as string[], matchCount: 0 };
  const accumulator = new ResultAccumulator({
    append: async () => { throw new Error("disk full"); },
  }, checkpoint);

  await assert.rejects(accumulator.record(record("failed")), /disk full/);
  assert.deepEqual(checkpoint, { seenCommentIds: [], matchCount: 0 });
});
