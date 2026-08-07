import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  JsonlSnapshotLimitError,
  readJsonlSnapshot,
  readJsonlSnapshotDetails,
} from "../src/jsonl-snapshot";

test("reads every complete JSONL record and ignores an incomplete trailing write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-jsonl-snapshot-"));
  const path = join(directory, "results.jsonl");
  await writeFile(path, '{"id":1}\n{"id":2,"text":"中文"}\n{"id":', "utf8");

  assert.deepEqual(await readJsonlSnapshot(path), [
    { id: 1 },
    { id: 2, text: "中文" },
  ]);
});

test("reports the frozen byte boundary and malformed lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-jsonl-details-"));
  const path = join(directory, "results.jsonl");
  const contents = '{"id":1}\nnot-json\n';
  await writeFile(path, contents, "utf8");
  assert.deepEqual(await readJsonlSnapshotDetails(path), {
    byteLimit: Buffer.byteLength(contents),
    records: [{ id: 1 }],
    skippedLines: 1,
  });
});

test("fails explicitly before a report can exhaust memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-jsonl-limit-"));
  const path = join(directory, "results.jsonl");
  await writeFile(path, '{"id":1}\n{"id":2}\n', "utf8");
  await assert.rejects(readJsonlSnapshot(path, { maxRecords: 1 }), (error) => {
    assert.ok(error instanceof JsonlSnapshotLimitError);
    assert.equal(error.limit, "records");
    return true;
  });
  await assert.rejects(readJsonlSnapshot(path, { maxBytes: 1 }), JsonlSnapshotLimitError);
});

test("returns an empty snapshot for a missing result file", async () => {
  assert.deepEqual(await readJsonlSnapshot("/path/that/does/not/exist/results.jsonl"), []);
});
