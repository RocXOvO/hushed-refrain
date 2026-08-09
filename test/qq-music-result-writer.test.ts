import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  QQMusicResultPersistenceError,
  QQMusicResultWriter,
} from "../src/qq-music/result-writer";

test("QQ result writer separates a damaged non-newline tail before appending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-writer-tail-"));
  const path = join(directory, "comments.jsonl");
  await writeFile(path, '{"commentId":"broken"', "utf8");
  const writer = new QQMusicResultWriter(path);
  await writer.initialize();
  assert.equal(await writer.append({
    platform: "qq",
    targetEncryptUin: "target",
    songId: "7",
    commentId: "valid",
    seqNo: "10",
    authorEncryptUin: "target",
    content: "hello",
    capturedAt: "2026-08-07T00:00:00.000Z",
  }), true);

  const lines = (await readFile(path, "utf8")).split("\n");
  assert.equal(lines[0], '{"commentId":"broken"');
  assert.equal(JSON.parse(lines[1]).commentId, "valid");
  await writer.close();
});

test("QQ result writer de-duplicates by songId and commentId together", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-writer-composite-key-"));
  const path = join(directory, "comments.jsonl");
  const writer = new QQMusicResultWriter(path);
  await writer.initialize();
  const record = {
    platform: "qq" as const,
    targetEncryptUin: "target",
    songId: "7",
    commentId: "shared-comment",
    seqNo: "10",
    authorEncryptUin: "target",
    content: "hello",
    capturedAt: "2026-08-07T00:00:00.000Z",
  };

  assert.equal(await writer.append(record), true);
  assert.equal(await writer.append({ ...record, songId: "8", seqNo: "9" }), true);
  assert.equal(await writer.append(record), false);
  assert.equal(writer.has("7", "shared-comment"), true);
  assert.equal(writer.has("8", "shared-comment"), true);
  await writer.close();

  const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.songId), ["7", "8"]);
});

test("QQ result writer syncs its long-lived handle before publishing onAppend", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-writer-sync-order-"));
  const path = join(directory, "comments.jsonl");
  const events: string[] = [];
  const writer = new QQMusicResultWriter(path, () => events.push("onAppend"), {
    openAppendFile: async () => ({
      write: async () => { events.push("write"); return { bytesWritten: 1 }; },
      sync: async () => { events.push("sync"); },
      close: async () => { events.push("close"); },
    }),
  });
  await writer.initialize();
  assert.equal(await writer.append({
    platform: "qq",
    targetEncryptUin: "target",
    songId: "7",
    commentId: "durable",
    seqNo: "10",
    authorEncryptUin: "target",
    content: "hello",
    capturedAt: "2026-08-07T00:00:00.000Z",
  }), true);
  assert.deepEqual(events, ["write", "sync", "onAppend"]);
  await writer.close();
  assert.deepEqual(events, ["write", "sync", "onAppend", "close"]);
});

test("QQ result writer persists one comment page with one write and one sync", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-writer-page-batch-"));
  const path = join(directory, "comments.jsonl");
  const writes: string[] = [];
  let syncs = 0;
  const writer = new QQMusicResultWriter(path, undefined, {
    openAppendFile: async () => ({
      write: async (contents) => { writes.push(contents); },
      sync: async () => { syncs += 1; },
      close: async () => {},
    }),
  });
  const records = Array.from({ length: 25 }, (_unused, index) => ({
    platform: "qq" as const,
    targetEncryptUin: "target",
    songId: "7",
    commentId: `comment-${index}`,
    seqNo: String(100 - index),
    authorEncryptUin: "target",
    content: `match-${index}`,
    capturedAt: "2026-08-07T00:00:00.000Z",
  }));
  assert.equal((await writer.appendBatch([...records, records[0]])).length, 25);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].trim().split("\n").length, 25);
  assert.equal(syncs, 1);
  await writer.close();
});

test("QQ result writer latches write or sync failure without publishing or rewriting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-writer-sync-failure-"));
  const path = join(directory, "comments.jsonl");
  let writes = 0;
  let published = 0;
  const writer = new QQMusicResultWriter(path, () => { published += 1; }, {
    openAppendFile: async () => ({
      write: async () => { writes += 1; },
      sync: async () => { throw new Error("disk sync failed"); },
      close: async () => {},
    }),
  });
  const record = {
    platform: "qq" as const,
    targetEncryptUin: "target",
    songId: "7",
    commentId: "uncertain-durability",
    seqNo: "10",
    authorEncryptUin: "target",
    content: "hello",
    capturedAt: "2026-08-07T00:00:00.000Z",
  };

  await assert.rejects(writer.append(record), QQMusicResultPersistenceError);
  await assert.rejects(writer.append(record), QQMusicResultPersistenceError);
  assert.equal(writes, 1);
  assert.equal(published, 0);
  assert.equal(writer.has("7", "uncertain-durability"), false);
  await writer.close();
});
