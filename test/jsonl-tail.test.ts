import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readJsonlTail } from "../src/jsonl-tail";

test("reads the newest JSONL rows across block and UTF-8 boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-jsonl-tail-"));
  const path = join(directory, "events.jsonl");
  const rows = [
    { id: 1, text: "旧记录" },
    { id: 2, text: `跨块-${"歌".repeat(70_000)}` },
    { id: 3, text: "倒数第二条" },
    { id: 4, text: "最新一条" },
  ];
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

  const latest = await readJsonlTail<{ id: number; text: string }>(path, 3);
  assert.deepEqual(latest.map((row) => row.id), [4, 3, 2]);
  assert.equal(latest[2].text, rows[1].text);
});

test("returns an empty tail for a missing file", async () => {
  assert.deepEqual(await readJsonlTail("/definitely/missing/ncm-events.jsonl", 10), []);
});
