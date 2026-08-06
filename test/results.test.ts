import assert from "node:assert/strict";
import { test } from "node:test";
import { neteaseCommentUrl } from "../src/results";

test("builds a NetEase song comment link from numeric IDs", () => {
  assert.equal(
    neteaseCommentUrl("186016", "1438569889"),
    "https://music.163.com/#/song?id=186016&commentId=1438569889",
  );
  assert.equal(neteaseCommentUrl(undefined, "1438569889"), undefined);
  assert.equal(neteaseCommentUrl("186016", "not-a-comment"), undefined);
});
