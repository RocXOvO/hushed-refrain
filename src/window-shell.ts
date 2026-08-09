import type { BrowserWindowConstructorOptions } from "electron";

export const DESKTOP_WINDOW_CHANNELS = {
  close: "desktop-window:close",
  getMaximized: "desktop-window:get-maximized",
  maximizedChanged: "desktop-window:maximized-changed",
  minimize: "desktop-window:minimize",
  toggleMaximize: "desktop-window:toggle-maximize",
} as const;

export const DESKTOP_UPDATE_CHANNELS = {
  check: "desktop-update:check",
  download: "desktop-update:download",
  getState: "desktop-update:get-state",
  install: "desktop-update:install",
  stateChanged: "desktop-update:state-changed",
} as const;

export const DESKTOP_SETTINGS_CHANNELS = {
  get: "desktop-settings:get",
  reset: "desktop-settings:reset",
  update: "desktop-settings:update",
} as const;

export const DESKTOP_EXPORT_CHANNELS = {
  cancelResultsPdf: "desktop-export:cancel-results-pdf",
  resultsPdf: "desktop-export:results-pdf",
  resultsPdfProgress: "desktop-export:results-pdf-progress",
} as const;

export type DesktopResultExportRequest =
  | {
    platform: "netease";
    mode: "source" | "parallel";
    jobId: string;
    target: { kind: "uid"; value: string };
  }
  | {
    platform: "qq";
    mode: "song" | "likes";
    jobId: string;
    target: { kind: "encryptUin"; value: string };
  };

export function parseDesktopResultExportRequest(value: unknown): DesktopResultExportRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("导出参数格式错误。");
  const input = value as Record<string, unknown>;
  const platform = input.platform;
  const mode = input.mode;
  const validMode = platform === "netease"
    ? mode === "source" || mode === "parallel"
    : platform === "qq"
      ? mode === "song" || mode === "likes"
      : false;
  if (!validMode) throw new Error("导出平台与任务模式不匹配。");
  const jobId = String(input.jobId ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    throw new Error("导出任务 ID 格式错误。");
  }
  if (!input.target || typeof input.target !== "object" || Array.isArray(input.target)) {
    throw new Error("导出目标格式错误。");
  }
  const target = input.target as Record<string, unknown>;
  const targetValue = String(target.value ?? "").trim();
  if (platform === "netease") {
    if (target.kind !== "uid") throw new Error("导出目标类型错误。");
    if (!/^\d+$/.test(targetValue)) throw new Error("导出 UID 格式错误。");
    return { platform, mode: mode as "source" | "parallel", jobId, target: { kind: "uid", value: targetValue } };
  }
  if (target.kind !== "encryptUin") throw new Error("导出目标类型错误。");
  if (!/^[A-Za-z0-9*_.-]{4,128}$/.test(targetValue)) throw new Error("导出 EncryptUin 格式错误。");
  return { platform: "qq", mode: mode as "song" | "likes", jobId, target: { kind: "encryptUin", value: targetValue } };
}

export function desktopResultReportUrl(origin: string, request: DesktopResultExportRequest): string {
  const url = new URL("/report/results", origin);
  url.searchParams.set("platform", request.platform);
  url.searchParams.set("mode", request.mode);
  url.searchParams.set("jobId", request.jobId);
  url.searchParams.set("targetKind", request.target.kind);
  url.searchParams.set("target", request.target.value);
  return url.toString();
}

export function desktopResultReportIdentityMatches(
  value: unknown,
  request: DesktopResultExportRequest,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return identity.platform === request.platform
    && identity.mode === request.mode
    && identity.jobId === request.jobId
    && identity.targetKind === request.target.kind
    && identity.target === request.target.value;
}

export function desktopResultReportLoadError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = (value as Record<string, unknown>).errorText;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4_096) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const error = (parsed as Record<string, unknown>).error;
    if (typeof error !== "string" || !error.trim()) return undefined;
    return error.trim().slice(0, 512);
  } catch {
    return undefined;
  }
}

export function resultReportFilename(request: DesktopResultExportRequest, at = new Date()): string {
  const date = Number.isFinite(at.getTime()) ? at.toISOString().slice(0, 10) : "report";
  const target = request.target.value;
  const filename = request.platform === "netease"
    ? `网易云评论报告-UID-${target}-${date}.pdf`
    : `QQ音乐评论报告-用户-${target}-${date}.pdf`;
  return sanitizeWindowsPdfFilename(filename);
}

export function sanitizeWindowsPdfFilename(value: string): string {
  let stem = String(value).replace(/\.pdf$/i, "");
  stem = stem
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "");
  const deviceStem = stem.split(".", 1)[0]?.replace(/[. ]+$/g, "") ?? "";
  if (!stem || /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(deviceStem)) {
    stem = stem ? `_${stem}` : "评论检索报告";
  }
  stem = stem.slice(0, 180).replace(/[. ]+$/g, "") || "评论检索报告";
  return `${stem}.pdf`;
}

export function redactDesktopResultExportText(
  value: unknown,
  request: DesktopResultExportRequest,
): string {
  let result = String(value);
  const target = request.target.value;
  if (target) {
    result = result.replaceAll(target, "[redacted-target]");
    const encodedTarget = encodeURIComponent(target);
    if (encodedTarget !== target) result = result.replaceAll(encodedTarget, "[redacted-target]");
  }
  return result.replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted-credentials]@");
}

export function desktopWindowChrome(platform: NodeJS.Platform): Pick<BrowserWindowConstructorOptions, "frame"> {
  return platform === "win32" ? { frame: false } : {};
}

export function desktopDashboardUrl(origin: string, platform: NodeJS.Platform): string {
  const url = new URL(origin);
  url.searchParams.set("desktop", platform);
  return url.toString();
}
