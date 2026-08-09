import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_EXPORT_CHANNELS,
  desktopDashboardUrl,
  desktopResultReportIdentityMatches,
  desktopResultReportLoadError,
  desktopResultReportUrl,
  desktopWindowChrome,
  parseDesktopResultExportRequest,
  redactDesktopResultExportText,
  resultReportFilename,
} from "../src/window-shell";

test("keeps PDF export and cancellation on explicit desktop bridge channels", () => {
  assert.deepEqual(DESKTOP_EXPORT_CHANNELS, {
    cancelResultsPdf: "desktop-export:cancel-results-pdf",
    resultsPdf: "desktop-export:results-pdf",
    resultsPdfProgress: "desktop-export:results-pdf-progress",
  });
});

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
    platform: "netease",
    mode: "source",
    jobId: "1b0f6738-eeb3-4ed5-97db-58dc5344df77",
    target: { kind: "uid", value: "9000000001" },
  });
  assert.equal(
    desktopResultReportUrl("http://127.0.0.1:4321/?desktop=win32", request),
    "http://127.0.0.1:4321/report/results?platform=netease&mode=source&jobId=1b0f6738-eeb3-4ed5-97db-58dc5344df77&targetKind=uid&target=9000000001",
  );
  assert.throws(() => parseDesktopResultExportRequest({ ...request, target: { kind: "uid", value: "1/../2" } }), /UID/);
  assert.throws(() => parseDesktopResultExportRequest({ ...request, jobId: "not-a-uuid" }), /任务 ID/);
  assert.equal(
    resultReportFilename(request, new Date("2026-08-07T00:00:00.000Z")),
    "网易云评论报告-UID-9000****0001-2026-08-07.pdf",
  );
});

test("keeps QQ exports distinct from NetEase and masks opaque targets in filenames", () => {
  const request = parseDesktopResultExportRequest({
    platform: "qq",
    mode: "likes",
    jobId: "a8d7e2b4-62c5-4b30-875d-8a4371513cc9",
    target: { kind: "encryptUin", value: "opaque-user_1234" },
  });
  assert.deepEqual(request, {
    platform: "qq",
    mode: "likes",
    jobId: "a8d7e2b4-62c5-4b30-875d-8a4371513cc9",
    target: { kind: "encryptUin", value: "opaque-user_1234" },
  });
  assert.equal(
    desktopResultReportUrl("http://127.0.0.1:4321/", request),
    "http://127.0.0.1:4321/report/results?platform=qq&mode=likes&jobId=a8d7e2b4-62c5-4b30-875d-8a4371513cc9&targetKind=encryptUin&target=opaque-user_1234",
  );
  assert.equal(
    resultReportFilename(request, new Date("2026-08-07T00:00:00.000Z")),
    "QQ音乐评论报告-用户-opaq****1234-2026-08-07.pdf",
  );
  assert.throws(() => parseDesktopResultExportRequest({ ...request, mode: "source" }), /平台.*模式/);
  assert.throws(() => parseDesktopResultExportRequest({ ...request, target: { kind: "uid", value: "123" } }), /目标类型/);
  assert.throws(
    () => parseDesktopResultExportRequest({ ...request, target: { kind: "encryptUin", value: "<script>" } }),
    /EncryptUin/,
  );
});

test("requires every generation field to match before printing a hidden report", () => {
  const request = parseDesktopResultExportRequest({
    platform: "qq",
    mode: "song",
    jobId: "a8d7e2b4-62c5-4b30-875d-8a4371513cc9",
    target: { kind: "encryptUin", value: "opaque-user_1234" },
  });
  const identity = {
    platform: "qq",
    mode: "song",
    jobId: request.jobId,
    targetKind: "encryptUin",
    target: "opaque-user_1234",
  };
  assert.equal(desktopResultReportIdentityMatches(identity, request), true);
  assert.equal(desktopResultReportIdentityMatches({ ...identity, mode: "likes" }, request), false);
  assert.equal(desktopResultReportIdentityMatches({ ...identity, target: "different-user" }, request), false);
  assert.equal(desktopResultReportIdentityMatches({ ...identity, jobId: "" }, request), false);
  assert.equal(desktopResultReportIdentityMatches(null, request), false);
});

test("redacts canonical QQ targets and proxy credentials from PDF export diagnostics", () => {
  const request = parseDesktopResultExportRequest({
    platform: "qq",
    mode: "likes",
    jobId: "a8d7e2b4-62c5-4b30-875d-8a4371513cc9",
    target: { kind: "encryptUin", value: "opaque.user_1234" },
  });
  const detail = redactDesktopResultExportText(
    "load failed for opaque.user_1234 and opaque.user_1234 at http://proxy-user:proxy-pass@127.0.0.1:8080/",
    request,
  );
  assert.doesNotMatch(detail, /opaque\.user_1234/);
  assert.doesNotMatch(detail, /proxy-user|proxy-pass/);
  assert.match(detail, /\[redacted-target\]/);
  assert.match(detail, /http:\/\/\[redacted-credentials\]@127\.0\.0\.1:8080/);
});

test("surfaces a bounded report API error instead of mislabeling it as a stale generation", () => {
  assert.equal(
    desktopResultReportLoadError({ errorText: JSON.stringify({ error: "命中结果过多，无法生成单份 PDF。" }) }),
    "命中结果过多，无法生成单份 PDF。",
  );
  assert.equal(desktopResultReportLoadError({ errorText: "not-json" }), undefined);
  assert.equal(desktopResultReportLoadError({ errorText: JSON.stringify({ error: "" }) }), undefined);
  assert.equal(desktopResultReportLoadError({ errorText: "x".repeat(4_097) }), undefined);
});
