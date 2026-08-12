import assert from "node:assert/strict";
import { test } from "node:test";
import { renderResultReportHtml, type ResultReport } from "../src/result-report";

function report(): ResultReport {
  return {
    mode: "source",
    jobId: "1b0f6738-eeb3-4ed5-97db-58dc5344df77",
    uid: "9000000001",
    status: "running",
    source: "record",
    startedAt: "2026-08-07T12:00:00.000Z",
    elapsedMs: 62_000,
    matches: 1,
    requestsTotal: 9,
    pagesProcessed: 3,
    floorPagesProcessed: 2,
    commentsInspected: 2_345,
    coverageLabel: "2 / 100 首歌曲",
    exportedAt: "2026-08-07T12:01:02.000Z",
    comments: [{
      commentId: "987654",
      userId: "9000000001",
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

function qqReport(): ResultReport {
  return {
    platform: "qq",
    mode: "likes",
    jobId: "a8d7e2b4-62c5-4b30-875d-8a4371513cc9",
    target: { kind: "encryptUin", value: "opaque-user_1234" },
    targetLabel: "opaq****1234",
    status: "complete",
    startedAt: "2026-08-07T12:00:00.000Z",
    elapsedMs: 62_000,
    matches: 1,
    requestsTotal: 9,
    pagesProcessed: 3,
    commentsInspected: 75,
    coverageLabel: "2 / 100 首公开喜欢歌曲",
    exportedAt: "2026-08-07T12:01:02.000Z",
    comments: [{
      platform: "qq",
      targetEncryptUin: "opaque-user_1234",
      commentId: "qq-comment-1",
      seqNo: "12345678901234567890",
      authorEncryptUin: "opaque-user_1234",
      nickname: '<img src=x onerror="alert(1)">',
      content: '<script>alert("qq")</script> QQ 评论',
      songId: "102065756",
      songMid: 'bad"><script>alert(1)</script>',
      songName: "测试 QQ 歌曲 <危险>",
      artists: ["艺人 <A>"],
      capturedAt: "2026-08-07T12:00:30.000Z",
      commentUrl: "https://evil.example/stored-link",
    }],
  };
}

test("renders a printable Chinese report while escaping all scanned content", () => {
  const html = renderResultReportHtml(report());
  assert.match(html, /UID 9000000001 评论检索报告/);
  assert.match(html, /name="result-report-uid" content="9000000001"/);
  assert.match(html, /文件累计 1 · 检查点统计 1/);
  assert.match(html, /已读评论 · 顶层\/楼中楼页<\/span><strong>2,345 · 3 \/ 2 页/);
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

test("labels a NetEase floor match with its parent comment provenance", () => {
  const value = report();
  value.comments[0].route = "song-comment-floor";
  value.comments[0].parentCommentId = "root-123";
  const html = renderResultReportHtml(value);
  assert.match(html, /楼中楼回复（父评论 root-123）/);
  assert.match(html, /music\.163\.com\/#\/song\?id=123456&amp;commentId=987654/);
});

test("lets Chromium paginate one continuous result table from measured row heights", () => {
  const value = report();
  value.comments = Array.from({ length: 20 }, (_, index) => ({
    ...value.comments[0],
    commentId: String(10_000 + index),
    content: index % 4 === 0 ? `第 ${index + 1} 条较长评论 `.repeat(8) : `第 ${index + 1} 条评论`,
  }));
  const html = renderResultReportHtml(value);
  assert.equal((html.match(/<table>/g) ?? []).length, 1);
  assert.equal((html.match(/<thead>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /continued-table/);
  assert.doesNotMatch(html, /break-before:\s*page|page-break-before:\s*always/);
  assert.match(html, /thead \{ display: table-header-group; \}/);
  assert.match(html, /tr \{ break-inside: avoid; page-break-inside: avoid; \}/);
  assert.match(html, /footer \{ display: none; \}/);
});

test("lays out the long coverage summary in a wide top-aligned card", () => {
  const value = report();
  value.status = "complete";
  value.elapsedMs = 2_770_000;
  value.commentsInspected = 43_517_145;
  value.pagesProcessed = 44_824;
  value.requestsTotal = 45_026;
  value.coverageLabel = "1,850 / 1,850 首歌曲；目录 1,850，历史完成 913，复用 0，新增待扫 0；仅扫描顶层评论，未读取楼中楼";
  const html = renderResultReportHtml(value);

  assert.match(html, /class="summary-coverage"[^>]*><span>覆盖进度<\/span>/);
  assert.match(html, /class="summary-comments"[^>]*><span>已读评论 · 顶层\/楼中楼页<\/span><strong>43,517,145 · 44,824 \/ 2 页<\/strong>/);
  assert.match(html, /grid-template-columns: repeat\(12, minmax\(0, 1fr\)\)/);
  assert.match(html, /grid-template-areas: "mode mode mode target target target status status elapsed elapsed result result" "coverage coverage coverage coverage coverage coverage comments comments comments comments requests requests"/);
  assert.match(html, /justify-content: flex-start/);
  assert.doesNotMatch(html, /align-content: space-between/);
});

test("renders QQ reports with generation metadata and rebuilds only trusted QQ Music links", () => {
  const html = renderResultReportHtml(qqReport());
  assert.match(html, /QQ 音乐评论检索报告/);
  assert.match(html, /name="result-report-platform" content="qq"/);
  assert.match(html, /name="result-report-mode" content="likes"/);
  assert.match(html, /name="result-report-target-kind" content="encryptUin"/);
  assert.match(html, /name="result-report-target" content="opaque-user_1234"/);
  assert.match(html, /公开喜欢/);
  assert.match(html, /已读评论 · 顶层\/楼中楼页<\/span><strong>75 · 3 \/ 0 页/);
  assert.match(html, /opaq\*\*\*\*1234/);
  assert.match(html, /测试 QQ 歌曲 &lt;危险&gt;/);
  assert.match(html, /https:\/\/y\.qq\.com\/n\/ryqq\/songDetail\/102065756/);
  assert.doesNotMatch(html, /bad%22%3E%3Cscript/);
  assert.doesNotMatch(html, /evil\.example/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>alert\("qq"\)<\/script>/);
  assert.doesNotMatch(html, /authorEncryptUin/);
  assert.match(html, /评论内容及用户信息来自任务扫描时的 QQ 音乐公开响应/);
  const body = html.match(/<body>([\s\S]*?)<\/body>/)?.[1] ?? "";
  assert.doesNotMatch(body, /opaque-user_1234/);
});
