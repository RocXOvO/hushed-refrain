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

export const DESKTOP_EXPORT_CHANNELS = {
  resultsPdf: "desktop-export:results-pdf",
} as const;

export interface DesktopResultExportRequest {
  mode: "source" | "parallel";
  jobId: string;
  uid: string;
}

export function parseDesktopResultExportRequest(value: unknown): DesktopResultExportRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("导出参数格式错误。");
  const input = value as Record<string, unknown>;
  if (input.mode !== "source" && input.mode !== "parallel") throw new Error("导出任务模式错误。");
  const jobId = String(input.jobId ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    throw new Error("导出任务 ID 格式错误。");
  }
  const uid = String(input.uid ?? "").trim();
  if (!/^\d+$/.test(uid)) throw new Error("导出 UID 格式错误。");
  return { mode: input.mode, jobId, uid };
}

export function desktopResultReportUrl(origin: string, request: DesktopResultExportRequest): string {
  const url = new URL("/report/results", origin);
  url.searchParams.set("mode", request.mode);
  url.searchParams.set("jobId", request.jobId);
  url.searchParams.set("uid", request.uid);
  return url.toString();
}

export function resultReportFilename(uid: string, at = new Date()): string {
  const date = Number.isFinite(at.getTime()) ? at.toISOString().slice(0, 10) : "report";
  return `网易云评论报告-UID-${uid}-${date}.pdf`;
}

export function desktopWindowChrome(platform: NodeJS.Platform): Pick<BrowserWindowConstructorOptions, "frame"> {
  return platform === "win32" ? { frame: false } : {};
}

export function desktopDashboardUrl(origin: string, platform: NodeJS.Platform): string {
  const url = new URL(origin);
  url.searchParams.set("desktop", platform);
  return url.toString();
}
