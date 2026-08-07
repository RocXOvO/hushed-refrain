import assert from "node:assert/strict";
import { test } from "node:test";
import { renderResultReportHtml, type ResultReport } from "../src/result-report";

function report(): ResultReport {
  return {
    mode: "source",
    jobId: "1b0f6738-eeb3-4ed5-97db-58dc5344df77",
    uid: "1767856290",
    status: "running",
    source: "record",
    startedAt: "2026-08-07T12:00:00.000Z",
    elapsedMs: 62_000,
    matches: 1,
    requestsTotal: 9,
    pagesProcessed: 3,
    coverageLabel: "2 / 100 首歌曲",
    exportedAt: "2026-08-07T12:01:02.000Z",
    comments: [{
      commentId: "987654",
      userId: "1767856290",
      nickname: '<img src=x onerror="alert(1)">',
      content: '<script>alert("x")</script> 中文评论 & 换行\n第二行',
      songId: "123456",
      songName: "测试歌曲 <危险>",
      route: "song-comments",
      capturedAt: "2026-08-07T12:00:30.000Z",
      commentUrl: "javascript:alert(1)",
    }],
  };
}

test("renders a printable Chinese report while escaping all scanned content", () => {
  const html = renderResultReportHtml(report());
  assert.match(html, /UID 1767856290 评论检索报告/);
  assert.match(html, /name="result-report-uid" content="1767856290"/);
  assert.match(html, /文件累计 1 · 检查点统计 1/);
  assert.match(html, /中文评论 &amp; 换行/);
  assert.match(html, /测试歌曲 &lt;危险&gt;/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /music\.163\.com\/#\/song\?id=123456&amp;commentId=987654/);
  assert.doesNotMatch(html, /javascript:alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /@page \{ size: A4/);
  assert.match(html, /<script src="\/report\.js"><\/script>/);
});

test("splits an unusually long comment into printable continuation rows without truncating it", () => {
  const value = report();
  value.comments[0].content = "长".repeat(600);
  const html = renderResultReportHtml(value);
  assert.match(html, /<tr class="continued">/);
  const printableContent = [...html.matchAll(/<td class="content"><p>(长+)<\/p>/g)]
    .map((match) => match[1])
    .join("");
  assert.equal(printableContent, "长".repeat(600));
});
