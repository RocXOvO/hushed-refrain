import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopDashboardUrl,
  desktopResultReportUrl,
  desktopWindowChrome,
  parseDesktopResultExportRequest,
  resultReportFilename,
} from "../src/window-shell";

test("uses a frameless window only on Windows", () => {
  assert.deepEqual(desktopWindowChrome("win32"), { frame: false });
  assert.deepEqual(desktopWindowChrome("darwin"), {});
  assert.deepEqual(desktopWindowChrome("linux"), {});
});

test("marks the dashboard URL with the desktop platform", () => {
  assert.equal(
    desktopDashboardUrl("http://127.0.0.1:4321/", "win32"),
    "http://127.0.0.1:4321/?desktop=win32",
  );
});

test("validates PDF export messages and creates a loopback report URL", () => {
  const request = parseDesktopResultExportRequest({
    mode: "source",
    jobId: "1b0f6738-eeb3-4ed5-97db-58dc5344df77",
    uid: "1767856290",
  });
  assert.equal(
    desktopResultReportUrl("http://127.0.0.1:4321/?desktop=win32", request),
    "http://127.0.0.1:4321/report/results?mode=source&jobId=1b0f6738-eeb3-4ed5-97db-58dc5344df77&uid=1767856290",
  );
  assert.throws(() => parseDesktopResultExportRequest({ ...request, uid: "1/../2" }), /UID/);
  assert.throws(() => parseDesktopResultExportRequest({ ...request, jobId: "not-a-uuid" }), /任务 ID/);
  assert.equal(
    resultReportFilename("1767856290", new Date("2026-08-07T00:00:00.000Z")),
    "网易云评论报告-UID-1767856290-2026-08-07.pdf",
  );
});
