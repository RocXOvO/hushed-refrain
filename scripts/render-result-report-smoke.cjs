const { app, BrowserWindow } = require("electron");
const { mkdir, writeFile } = require("node:fs/promises");
const { resolve } = require("node:path");
const { renderResultReportHtml } = require("../dist/result-report.js");

async function render() {
  const output = resolve(process.env.NCM_REPORT_SMOKE_OUTPUT || "tmp/pdfs/result-report-smoke.pdf");
  await mkdir(resolve(output, ".."), { recursive: true });
  const comments = Array.from({ length: 42 }, (_, index) => ({
    commentId: String(9_000_000 + index),
    userId: "9000000001",
    nickname: index === 0 ? "测试用户 <安全转义>" : "测试用户",
    content: index === 8
      ? `这是一条用于验证跨页排版的长评论。${"中文内容、标点与 emoji 🎵 会保持可读。".repeat(95)}`
      : `第 ${index + 1} 条实时命中：中文评论内容与换行测试。\n第二行仍应留在同一个单元格中。`,
    songId: String(180_000 + index % 7),
    songName: `测试歌曲 ${index % 7 + 1}`,
    likedCount: index * 3,
    time: Date.UTC(2026, 7, 7, 12, index),
    route: "song-comments",
    capturedAt: new Date(Date.UTC(2026, 7, 7, 12, index)).toISOString(),
  }));
  const html = renderResultReportHtml({
    mode: "source",
    jobId: "1b0f6738-eeb3-4ed5-97db-58dc5344df77",
    uid: "9000000001",
    status: "running",
    source: "both",
    startedAt: "2026-08-07T11:58:00.000Z",
    elapsedMs: 372_000,
    matches: comments.length,
    requestsTotal: 87,
    pagesProcessed: 74,
    coverageLabel: "38 / 126 首歌曲",
    exportedAt: "2026-08-07T12:04:12.000Z",
    comments,
  });
  const window = new BrowserWindow({
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await window.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
    await window.webContents.executeJavaScript("Promise.resolve(document.fonts?.ready)");
    const pdf = await window.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: "A4",
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: '<div style="width:100%;padding:0 10mm;display:flex;justify-content:space-between;color:#7b888d;font:8px sans-serif"><span>乐评寻踪</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
      margins: { top: 0.4, bottom: 0.55, left: 0.35, right: 0.35 },
    });
    await writeFile(output, pdf);
    process.stdout.write(`${output}\n`);
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

app.whenReady()
  .then(render)
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    app.exit(1);
  });
