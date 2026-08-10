import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  JsonlResultPersistenceError,
  JsonlResultWriter,
  neteaseCommentUrl,
} from "../src/results";

test("builds a NetEase song comment link from numeric IDs", () => {
  assert.equal(
    neteaseCommentUrl("186016", "1438569889"),
    "https://music.163.com/#/song?id=186016&commentId=1438569889",
  );
  assert.equal(neteaseCommentUrl(undefined, "1438569889"), undefined);
  assert.equal(neteaseCommentUrl("186016", "not-a-comment"), undefined);
});

test("streams large existing result files and cooperatively yields while rebuilding de-duplication", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-result-stream-"));
  const path = join(root, "comments.jsonl");
  const rows = Array.from({ length: 2_500 }, (_, index) => JSON.stringify({ commentId: String(index + 1) }));
  await writeFile(path, `${rows.join("\n")}\n`, "utf8");
  let yields = 0;
  const writer = new JsonlResultWriter(path, undefined, async () => { yields += 1; });

  await writer.initialize();

  assert.equal(yields, 2);
  assert.equal(writer.has("1"), true);
  assert.equal(writer.has("2500"), true);
  await writer.close();
});

test("isolates a damaged JSONL tail before durably appending a new record", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-result-tail-"));
  const path = join(root, "comments.jsonl");
  await writeFile(path, '{"commentId":"damaged"', "utf8");
  const writer = new JsonlResultWriter(path);

  assert.equal(await writer.append({
    commentId: "2",
    userId: "target",
    nickname: "user",
    content: "match",
    route: "song-comments",
    capturedAt: new Date(0).toISOString(),
  }), true);
  await writer.close();

  const contents = await readFile(path, "utf8");
  const lines = contents.split("\n");
  assert.equal(lines[0], '{"commentId":"damaged"');
  assert.equal(JSON.parse(lines[1]!).commentId, "2");
  assert.equal(lines[2], "");
});

test("sync failure is latched before publishing or accepting later records", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-result-sync-failure-"));
  const path = join(root, "comments.jsonl");
  const events: string[] = [];
  let writes = 0;
  const writer = new JsonlResultWriter(
    path,
    () => events.push("published"),
    async () => {},
    {
      async openAppendFile() {
        return {
          async write() { writes += 1; events.push("write"); },
          async sync() { events.push("sync"); throw new Error("disk failed"); },
          async close() { events.push("close"); },
        };
      },
    },
  );
  const record = {
    commentId: "1",
    userId: "target",
    nickname: "user",
    content: "match",
    route: "song-comments" as const,
    capturedAt: new Date(0).toISOString(),
  };

  await assert.rejects(writer.append(record), JsonlResultPersistenceError);
  await assert.rejects(writer.append({ ...record, commentId: "2" }), JsonlResultPersistenceError);
  await writer.close();

  assert.equal(writes, 1);
  assert.deepEqual(events, ["write", "sync", "close"]);
  assert.equal(writer.has("1"), false);
  assert.equal(writer.has("2"), false);
});

test("closes the append handle when damaged-tail repair cannot be synced", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-result-tail-sync-failure-"));
  const path = join(root, "comments.jsonl");
  await writeFile(path, '{"commentId":"damaged"', "utf8");
  const events: string[] = [];
  let opens = 0;
  const writer = new JsonlResultWriter(path, undefined, async () => {}, {
    async openAppendFile() {
      opens += 1;
      return {
        async write(contents) { events.push(`write:${JSON.stringify(contents)}`); },
        async sync() { events.push("sync"); throw new Error("disk failed"); },
        async close() { events.push("close"); },
      };
    },
  });

  await assert.rejects(writer.initialize(), JsonlResultPersistenceError);
  await assert.rejects(writer.initialize(), JsonlResultPersistenceError);
  await writer.close();

  assert.equal(opens, 1);
  assert.deepEqual(events, ['write:"\\n"', "sync", "close"]);
});

test("close drains an already accepted append before closing the handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-result-close-drain-"));
  const path = join(root, "comments.jsonl");
  let releaseWrite!: () => void;
  let announceWrite!: () => void;
  const writeStarted = new Promise<void>((resolve) => { announceWrite = resolve; });
  const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const events: string[] = [];
  const writer = new JsonlResultWriter(path, () => events.push("published"), async () => {}, {
    async openAppendFile() {
      return {
        async write() { events.push("write"); announceWrite(); await writeReleased; },
        async sync() { events.push("sync"); },
        async close() { events.push("close"); },
      };
    },
  });
  const append = writer.append({
    commentId: "1",
    userId: "target",
    content: "match",
    route: "song-comments",
    capturedAt: new Date(0).toISOString(),
  });
  await writeStarted;
  const close = writer.close();
  releaseWrite();

  assert.equal(await append, true);
  await close;
  assert.deepEqual(events, ["write", "sync", "published", "close"]);
  await assert.rejects(writer.append({
    commentId: "2",
    userId: "target",
    content: "late",
    route: "song-comments",
    capturedAt: new Date(0).toISOString(),
  }), /closed|closing/);
});
