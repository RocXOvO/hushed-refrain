import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlResultWriter, neteaseCommentUrl } from "../src/results";

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
});
