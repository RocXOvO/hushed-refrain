import type { FoundComment, SourceSelection } from "./types";
import { neteaseCommentUrl } from "./results";
import { qqMusicCommentUrl } from "./qq-music/result-writer";
import type { QQMusicFoundComment } from "./qq-music/types";

export type ResultReportMode = "source" | "parallel" | "song" | "likes";
const MAX_PRINTABLE_COMMENT_CHARS = 320;
const FIRST_PRINT_PAGE_UNITS = 6;
const CONTINUED_PRINT_PAGE_UNITS = 10;

interface PrintableRow {
  html: string;
  units: number;
}

interface ResultReportBase<Comment> {
  jobId: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  elapsedMs: number;
  matches: number;
  requestsTotal: number;
  pagesProcessed: number;
  coverageLabel: string;
  exportedAt: string;
  comments: Comment[];
}

export interface NeteaseResultReport extends ResultReportBase<FoundComment> {
  platform?: "netease";
  mode: "source" | "parallel";
  uid: string;
  target?: { kind: "uid"; value: string };
  source?: SourceSelection;
  songId?: string;
  songName?: string;
}

export interface QQResultReport extends ResultReportBase<QQMusicFoundComment> {
  platform: "qq";
  mode: "song" | "likes";
  target: { kind: "encryptUin"; value: string };
  targetLabel: string;
  songId?: string;
  songName?: string;
}

export type ResultReport = NeteaseResultReport | QQResultReport;

export function renderResultReportHtml(report: ResultReport): string {
  const qq = report.platform === "qq";
  const title = qq ? "QQ 音乐评论检索报告" : `UID ${report.uid} 评论检索报告`;
  const modeLabel = qq
    ? report.mode === "song" ? "QQ 单曲" : "QQ 公开喜欢"
    : report.mode === "parallel" ? "单曲并行" : "用户来源";
  const targetLabel = qq
    ? qqTargetLabel(report)
    : report.mode === "parallel"
      ? `${report.songName || "未命名歌曲"}${report.songId ? `（${report.songId}）` : ""}`
      : sourceLabel(report.source);
  const target = qq ? report.target : report.target ?? { kind: "uid" as const, value: report.uid };
  const resultTables = report.comments.length > 0
    ? printablePages(qq
      ? report.comments.flatMap((comment, index) => qqCommentRows(comment, index + 1))
      : report.comments.flatMap((comment, index) => neteaseCommentRows(comment, index + 1)))
      .map((page, index) => resultTable(page.map((row) => row.html).join(""), index > 0))
      .join("")
    : resultTable('<tr class="empty"><td colspan="6">当前任务尚未命中该用户的评论</td></tr>', false);
  return `<!doctype html>
<html lang="zh-CN" data-result-report="ready">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="result-report-platform" content="${qq ? "qq" : "netease"}">
  <meta name="result-report-mode" content="${escapeHtml(report.mode)}">
  <meta name="result-report-job" content="${escapeHtml(report.jobId)}">
  <meta name="result-report-target-kind" content="${escapeHtml(target.kind)}">
  <meta name="result-report-target" content="${escapeHtml(target.value)}">
  ${qq ? "" : `<meta name="result-report-uid" content="${escapeHtml(report.uid)}">`}
  <title>${escapeHtml(title)}</title>
  <style>${REPORT_STYLE}</style>
</head>
<body>
  <div class="report-actions" role="toolbar" aria-label="报告操作">
    <span>报告已生成，可打印或另存为 PDF</span>
    <button id="printReportButton" type="button">打印 / 保存 PDF</button>
  </div>
  <main>
    <header class="report-header">
      <div class="brand"><span>云评检索台</span><small>${qq ? "QQ MUSIC COMMENT FINDER" : "NCM COMMENT FINDER"}</small></div>
      <p class="eyebrow">COMMENT SEARCH REPORT</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="subtitle">导出的是任务文件中截至生成时刻已经保存的全部命中结果。</p>
    </header>

    <section class="summary" aria-label="任务摘要">
      <div><span>检索模式</span><strong>${modeLabel}</strong></div>
      <div><span>目标范围</span><strong>${escapeHtml(targetLabel)}</strong></div>
      <div><span>任务状态</span><strong>${escapeHtml(statusLabel(report.status))}</strong></div>
      <div><span>覆盖进度</span><strong>${escapeHtml(report.coverageLabel)}</strong></div>
      <div><span>已扫页面</span><strong>${formatNumber(report.pagesProcessed)}</strong></div>
      <div><span>累计请求</span><strong>${formatNumber(report.requestsTotal)}</strong></div>
      <div><span>任务耗时</span><strong>${formatDuration(report.elapsedMs)}</strong></div>
      <div class="accent"><span>文件累计结果</span><strong>${formatNumber(report.comments.length)} 条</strong></div>
    </section>

    <section class="metadata">
      <span>任务 ID：${escapeHtml(report.jobId)}</span>
      <span>任务开始：${formatDate(report.startedAt)}</span>
      <span>报告生成：${formatDate(report.exportedAt)}</span>
    </section>

    <section class="results">
      <div class="section-title"><div><p class="eyebrow">MATCHED COMMENTS</p><h2>命中评论</h2></div><strong>文件累计 ${formatNumber(report.comments.length)} · 检查点统计 ${formatNumber(report.matches)}</strong></div>
      ${resultTables}
    </section>

    <footer>本报告由云评检索台生成 · 评论内容及用户信息来自任务扫描时的${qq ? " QQ 音乐" : "网易云"}公开响应</footer>
  </main>
  <script src="/report.js"></script>
</body>
</html>`;
}

function neteaseCommentRows(comment: FoundComment, index: number): PrintableRow[] {
  const song = comment.songName || comment.resourceName || (comment.songId ? `歌曲 ${comment.songId}` : "未知歌曲");
  const songId = comment.songId ? `<small>ID ${escapeHtml(comment.songId)}</small>` : "";
  const user = comment.nickname ? `<small>${escapeHtml(comment.nickname)} · UID ${escapeHtml(comment.userId)}</small>` : `<small>UID ${escapeHtml(comment.userId)}</small>`;
  const url = neteaseCommentUrl(comment.songId, comment.commentId);
  const link = url ? `<a href="${escapeHtml(url)}">查看</a>` : "-";
  const [commentDate, commentClock] = formatCommentTime(comment.time).split(" ");
  return splitPrintableComment(comment.content).map((content, part) => ({
    units: Math.max(1, Math.ceil(content.replace(/\s/g, "").length / 120)),
    html: part === 0
    ? `<tr>
      <td class="number">${formatNumber(index)}</td>
      <td class="time"><span>${escapeHtml(commentDate)}</span>${commentClock ? `<small>${escapeHtml(commentClock)}</small>` : ""}</td>
      <td class="song"><strong>${escapeHtml(song)}</strong>${songId}</td>
      <td class="content"><p>${escapeHtml(content)}</p>${user}</td>
      <td class="likes">${formatNumber(comment.likedCount ?? 0)}</td>
      <td class="link">${link}</td>
    </tr>`
    : `<tr class="continued">
      <td class="number">续</td>
      <td class="time"></td>
      <td class="song"><small>第 ${formatNumber(index)} 条续页</small></td>
      <td class="content"><p>${escapeHtml(content)}</p></td>
      <td class="likes"></td>
      <td class="link"></td>
    </tr>`,
  }));
}

function qqCommentRows(comment: QQMusicFoundComment, index: number): PrintableRow[] {
  const song = comment.songName || `歌曲 ${comment.songId}`;
  const artists = comment.artists?.filter(Boolean).join(" / ");
  const songDetails = [artists, `ID ${comment.songId}`].filter(Boolean).join(" · ");
  const user = comment.nickname
    ? `<small>${escapeHtml(comment.nickname)} · QQ 音乐用户</small>`
    : "<small>QQ 音乐用户</small>";
  const url = trustedQQMusicCommentUrl(comment.songMid, comment.songId);
  const link = url ? `<a href="${escapeHtml(url)}">查看</a>` : "-";
  const [commentDate, commentClock] = formatCommentTime(comment.time).split(" ");
  return splitPrintableComment(comment.content).map((content, part) => ({
    units: Math.max(1, Math.ceil(content.replace(/\s/g, "").length / 120)),
    html: part === 0
    ? `<tr>
      <td class="number">${formatNumber(index)}</td>
      <td class="time"><span>${escapeHtml(commentDate)}</span>${commentClock ? `<small>${escapeHtml(commentClock)}</small>` : ""}</td>
      <td class="song"><strong>${escapeHtml(song)}</strong><small>${escapeHtml(songDetails)}</small></td>
      <td class="content"><p>${escapeHtml(content)}</p>${user}</td>
      <td class="likes">${formatNumber(comment.likedCount ?? 0)}</td>
      <td class="link">${link}</td>
    </tr>`
    : `<tr class="continued">
      <td class="number">续</td>
      <td class="time"></td>
      <td class="song"><small>第 ${formatNumber(index)} 条续页</small></td>
      <td class="content"><p>${escapeHtml(content)}</p></td>
      <td class="likes"></td>
      <td class="link"></td>
    </tr>`,
  }));
}

function qqTargetLabel(report: QQResultReport): string {
  const user = `用户 ${report.targetLabel}`;
  if (report.mode === "likes") return `${user} · 公开喜欢歌曲`;
  const song = report.songName || "未命名歌曲";
  return `${user} · ${song}${report.songId ? `（${report.songId}）` : ""}`;
}

function trustedQQMusicCommentUrl(songMid: string | undefined, songId: string): string | undefined {
  const mid = songMid?.trim();
  if (mid && /^[A-Za-z0-9]{4,64}$/.test(mid)) return qqMusicCommentUrl(mid, songId);
  if (/^\d+$/.test(songId)) return qqMusicCommentUrl(undefined, songId);
  return undefined;
}

function splitPrintableComment(content: string): string[] {
  if (content.length === 0) return [""];
  const chunks: string[] = [];
  for (let start = 0; start < content.length;) {
    let end = Math.min(content.length, start + MAX_PRINTABLE_COMMENT_CHARS);
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end -= 1;
    chunks.push(content.slice(start, end));
    start = end;
  }
  return chunks;
}

function printablePages(rows: PrintableRow[]): PrintableRow[][] {
  const pages: PrintableRow[][] = [];
  let page: PrintableRow[] = [];
  let used = 0;
  let capacity = FIRST_PRINT_PAGE_UNITS;
  for (const row of rows) {
    if (page.length > 0 && used + row.units > capacity) {
      pages.push(page);
      page = [];
      used = 0;
      capacity = CONTINUED_PRINT_PAGE_UNITS;
    }
    page.push(row);
    used += row.units;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

function resultTable(rows: string, continued: boolean): string {
  return `<table${continued ? ' class="continued-table"' : ""}>
    <thead><tr><th class="number">#</th><th class="time">时间</th><th class="song">歌曲</th><th>评论内容</th><th class="likes">点赞</th><th class="link">来源</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function sourceLabel(source: SourceSelection | undefined): string {
  return source === "record" ? "听歌排行" : source === "likes" ? "喜欢歌曲" : source === "both" ? "听歌排行 + 喜欢歌曲" : "当前用户来源";
}

function statusLabel(status: string): string {
  return ({
    idle: "空闲", running: "运行中", stopping: "停止中", complete: "已完成",
    matched: "已命中", paused: "已暂停", cooldown: "冷却中", stopped: "已停止",
    error: "异常结束", "dry-run": "歌曲已读取",
  } as Record<string, string>)[status] ?? status;
}

function formatCommentTime(value: number | undefined): string {
  if (!Number.isFinite(value)) return "-";
  return formatDate(new Date(value!).toISOString());
}

function formatDate(value: string | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date).replaceAll("/", "-");
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(Number(milliseconds) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}时` : "", minutes || hours ? `${minutes}分` : "", `${remainder}秒`].join("");
}

function formatNumber(value: number): string {
  return Math.max(0, Number(value) || 0).toLocaleString("zh-CN");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const REPORT_STYLE = `
:root { color-scheme: light; font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif; color: #1e2529; background: #edf1f2; }
* { box-sizing: border-box; }
body { margin: 0; background: #edf1f2; font-size: 12px; line-height: 1.55; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
main { width: min(1100px, calc(100% - 32px)); margin: 24px auto; padding: 34px 38px 28px; background: #fff; box-shadow: 0 18px 60px rgba(24, 42, 47, .10); }
.report-actions { position: sticky; z-index: 10; top: 0; min-height: 48px; padding: 8px 18px; display: flex; align-items: center; justify-content: center; gap: 18px; color: #3b4b50; background: rgba(246, 249, 249, .96); border-bottom: 1px solid #d8e0e2; }
.report-actions button { padding: 8px 14px; color: #fff; background: #078999; border: 0; border-radius: 7px; font: inherit; font-weight: 700; cursor: pointer; }
.report-header { padding-bottom: 22px; border-bottom: 2px solid #078999; }
.brand { display: flex; align-items: baseline; justify-content: space-between; color: #078999; font-weight: 800; }
.brand small { color: #778489; font-size: 9px; letter-spacing: .14em; }
.eyebrow { margin: 18px 0 4px; color: #078999; font-size: 9px; font-weight: 800; letter-spacing: .12em; }
h1 { margin: 0; font-size: 27px; line-height: 1.25; letter-spacing: -.02em; }
.subtitle { margin: 7px 0 0; color: #6d7a7f; }
.summary { margin: 18px 0 12px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid #d8e0e2; border-radius: 10px; overflow: hidden; }
.summary > div { min-height: 65px; padding: 11px 13px; display: grid; align-content: space-between; border-right: 1px solid #d8e0e2; border-bottom: 1px solid #d8e0e2; }
.summary > div:nth-child(4n) { border-right: 0; }
.summary > div:nth-last-child(-n + 4) { border-bottom: 0; }
.summary span { color: #748187; font-size: 9px; }
.summary strong { font-size: 13px; overflow-wrap: anywhere; }
.summary .accent { color: #078999; background: #edf8f9; }
.metadata { margin: 0 0 21px; padding: 8px 11px; display: flex; flex-wrap: wrap; gap: 7px 20px; color: #68757a; background: #f5f7f7; border-left: 3px solid #078999; }
.section-title { margin-bottom: 9px; display: flex; align-items: flex-end; justify-content: space-between; }
.section-title .eyebrow { margin-top: 0; }
h2 { margin: 0; font-size: 17px; }
.section-title > strong { color: #078999; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
thead { display: table-header-group; }
th { padding: 8px 7px; color: #5c6a70; background: #edf2f3; border-top: 1px solid #cdd8da; border-bottom: 1px solid #cdd8da; font-size: 9px; text-align: left; }
td { padding: 9px 7px; vertical-align: top; border-bottom: 1px solid #e2e8e9; overflow-wrap: anywhere; }
tr { break-inside: avoid; page-break-inside: avoid; }
.continued { background: #fafcfc; }
.continued .number, .continued .song small { color: #078999; }
.continued-table { margin-top: 0; }
.continued-table thead { display: none; }
.number { width: 4%; color: #7a878b; text-align: center; }
.time { width: 16%; white-space: nowrap; }
.song { width: 17%; }
.likes { width: 6%; text-align: center; }
.link { width: 6%; text-align: center; }
.time span, .time small { display: block; }
td strong, td small { display: block; }
td small { margin-top: 3px; color: #778489; font-size: 8.5px; }
td p { margin: 0; white-space: pre-wrap; }
a { color: #078999; font-weight: 700; text-decoration: none; }
.empty td { padding: 28px; color: #778489; text-align: center; }
footer { margin-top: 18px; padding-top: 10px; color: #829095; border-top: 1px solid #dbe3e4; font-size: 8.5px; text-align: center; }
@page { size: A4; margin: 14mm 10mm 17mm; }
@media print {
  :root { background: #fff; }
  body { background: #fff; }
  .report-actions { display: none !important; }
  main { width: auto; margin: 0; padding: 0; box-shadow: none; }
  .report-header { break-after: avoid; }
  .summary, .metadata, .section-title { break-inside: avoid; }
  .continued-table { break-before: page; page-break-before: always; }
  .continued-table thead { display: table-header-group; }
}
`;
