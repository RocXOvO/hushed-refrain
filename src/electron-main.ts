import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join } from "node:path";
import { startDashboard } from "./server";
import { writeAtomicBuffer } from "./atomic-file";
import {
  DESKTOP_EXPORT_CHANNELS,
  DESKTOP_UPDATE_CHANNELS,
  DESKTOP_WINDOW_CHANNELS,
  desktopDashboardUrl,
  desktopResultReportIdentityMatches,
  desktopResultReportLoadError,
  desktopResultReportUrl,
  desktopWindowChrome,
  parseDesktopResultExportRequest,
  redactDesktopResultExportText,
  resultReportFilename,
} from "./window-shell";
import {
  isWindowsAutoUpdateSupported,
  unsupportedWindowsUpdateState,
  WindowsUpdateController,
  type WindowsUpdateState,
  type WindowsUpdaterBackend,
} from "./windows-updater";

// The visible product name may change, but checkpoints, logs and updater
// handoff must continue using the established v0.x data directory.
app.setPath("userData", join(app.getPath("appData"), "ncm-comment-finder"));

let dashboard: Server | undefined;
let windowsUpdater: WindowsUpdateController | undefined;
let windowsUpdateFallbackState: WindowsUpdateState | undefined;
let mainWindow: BrowserWindow | undefined;
let dashboardUrl: string | undefined;
let resultExportInProgress = false;

function currentUpdateState() {
  return windowsUpdater?.getState() ?? windowsUpdateFallbackState ?? unsupportedWindowsUpdateState(app.getVersion());
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function writeDesktopLog(scope: string, detail: unknown): string | undefined {
  try {
    const logDirectory = join(app.getPath("userData"), "logs");
    const logPath = join(logDirectory, "desktop.log");
    mkdirSync(logDirectory, { recursive: true });
    appendFileSync(logPath, `[${new Date().toISOString()}] ${scope}\n${errorText(detail)}\n\n`, "utf8");
    return logPath;
  } catch {
    return undefined;
  }
}

function initializeWindowsUpdater(window: BrowserWindow): void {
  if (!isWindowsAutoUpdateSupported(process.platform, app.isPackaged)) return;
  try {
    // Keep the optional updater out of the startup import graph. If its native
    // Windows initialization fails, the dashboard must still remain usable.
    const electronUpdater = require("electron-updater") as typeof import("electron-updater");
    if (typeof electronUpdater.NsisUpdater !== "function") {
      throw new Error("Electron updater module exports are unavailable.");
    }
    const backend = electronUpdater.autoUpdater as unknown as WindowsUpdaterBackend;
    windowsUpdater = new WindowsUpdateController(
      backend,
      app.getVersion(),
      (state) => {
        if (!window.isDestroyed()) window.webContents.send(DESKTOP_UPDATE_CHANNELS.stateChanged, state);
      },
    );
  } catch (error) {
    const message = errorText(error).replace(/[\r\n]+/g, " ").slice(0, 500);
    windowsUpdateFallbackState = {
      supported: false,
      phase: "error",
      currentVersion: app.getVersion(),
      error: `自动更新组件不可用：${message}`,
    };
    writeDesktopLog("windows-updater-init", error);
  }
}

function senderWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined;
}

ipcMain.on(DESKTOP_WINDOW_CHANNELS.minimize, (event) => senderWindow(event)?.minimize());
ipcMain.on(DESKTOP_WINDOW_CHANNELS.close, (event) => senderWindow(event)?.close());
ipcMain.handle(DESKTOP_WINDOW_CHANNELS.getMaximized, (event) => senderWindow(event)?.isMaximized() ?? false);
ipcMain.handle(DESKTOP_WINDOW_CHANNELS.toggleMaximize, (event) => {
  const window = senderWindow(event);
  if (!window) return false;
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
  return window.isMaximized();
});
ipcMain.handle(DESKTOP_UPDATE_CHANNELS.getState, () => currentUpdateState());
ipcMain.handle(DESKTOP_UPDATE_CHANNELS.check, async () => windowsUpdater?.check() ?? currentUpdateState());
ipcMain.handle(DESKTOP_UPDATE_CHANNELS.download, async () => windowsUpdater?.download() ?? currentUpdateState());
ipcMain.handle(DESKTOP_UPDATE_CHANNELS.install, () => {
  windowsUpdater?.install();
  return currentUpdateState();
});
ipcMain.handle(DESKTOP_EXPORT_CHANNELS.resultsPdf, async (event, rawRequest: unknown) => {
  const window = senderWindow(event);
  if (!window || window !== mainWindow || !dashboardUrl) throw new Error("当前窗口不能导出报告。");
  if (resultExportInProgress) throw new Error("已有一份 PDF 正在生成，请稍候。");
  const request = parseDesktopResultExportRequest(rawRequest);
  resultExportInProgress = true;
  let reportWindow: BrowserWindow | undefined;
  try {
    const destination = await dialog.showSaveDialog(window, {
      title: "导出评论检索报告",
      defaultPath: join(app.getPath("documents"), resultReportFilename(request)),
      filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (destination.canceled || !destination.filePath) return { status: "cancelled" };
    const reportUrl = desktopResultReportUrl(dashboardUrl, request);
    reportWindow = new BrowserWindow({
      show: false,
      parent: window,
      backgroundColor: "#ffffff",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    reportWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    reportWindow.webContents.on("will-navigate", (navigationEvent, target) => {
      if (target !== reportUrl) navigationEvent.preventDefault();
    });
    await reportWindow.loadURL(reportUrl);
    const readyReport = await reportWindow.webContents.executeJavaScript(`Promise.resolve(document.fonts?.ready).then(() => ({ platform: document.querySelector('meta[name="result-report-platform"]')?.content, mode: document.querySelector('meta[name="result-report-mode"]')?.content, jobId: document.querySelector('meta[name="result-report-job"]')?.content, targetKind: document.querySelector('meta[name="result-report-target-kind"]')?.content, target: document.querySelector('meta[name="result-report-target"]')?.content, errorText: document.contentType === 'application/json' ? document.body?.innerText : undefined }))`);
    const reportError = desktopResultReportLoadError(readyReport);
    if (reportError) throw new Error(reportError);
    if (!desktopResultReportIdentityMatches(readyReport, request)) {
      throw new Error("报告数据已过期，请重新点击导出。");
    }
    const pdf = await reportWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: "A4",
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: '<div style="width:100%;padding:0 10mm;display:flex;justify-content:space-between;color:#7b888d;font:8px sans-serif"><span>乐评寻踪</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
      margins: { top: 0.4, bottom: 0.55, left: 0.35, right: 0.35 },
    });
    await writeAtomicBuffer(destination.filePath, pdf);
    return { status: "saved", path: destination.filePath };
  } catch (error) {
    const logDetail = redactDesktopResultExportText(errorText(error), request);
    const userDetail = redactDesktopResultExportText(error instanceof Error ? error.message : String(error), request);
    writeDesktopLog("pdf-export", logDetail);
    throw new Error(`PDF 导出失败：${userDetail}`);
  } finally {
    resultExportInProgress = false;
    if (reportWindow && !reportWindow.isDestroyed()) reportWindow.destroy();
  }
});

async function createWindow(): Promise<void> {
  dashboard = await startDashboard({
    host: "127.0.0.1",
    port: 0,
    runtimeRoot: app.getPath("userData"),
    currentVersion: app.getVersion(),
  });
  const address = dashboard.address() as AddressInfo;
  const url = desktopDashboardUrl(`http://127.0.0.1:${address.port}/`, process.platform);
  dashboardUrl = url;
  const smokeTest = process.env.NCM_DESKTOP_SMOKE === "1";
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: !smokeTest,
    backgroundColor: "#f3f5f6",
    autoHideMenuBar: true,
    title: "乐评寻踪",
    ...desktopWindowChrome(process.platform),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "electron-preload.js"),
    },
  });
  mainWindow = window;
  initializeWindowsUpdater(window);
  const sendMaximizedState = (): void => {
    if (!window.isDestroyed()) {
      window.webContents.send(DESKTOP_WINDOW_CHANNELS.maximizedChanged, window.isMaximized());
    }
  };
  window.on("maximize", sendMaximizedState);
  window.on("unmaximize", sendMaximizedState);
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (target !== url) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    writeDesktopLog("render-process-gone", JSON.stringify(details));
  });
  window.on("unresponsive", () => writeDesktopLog("window-unresponsive", "The main window stopped responding."));
  await window.loadURL(url);
  if (smokeTest) {
    const electronUpdater = require("electron-updater") as typeof import("electron-updater");
    if (typeof electronUpdater.NsisUpdater !== "function") {
      throw new Error("Electron updater module exports are unavailable.");
    }
    const bridge = await window.webContents.executeJavaScript(`(async () => ({
      platform: window.ncmDesktop?.platform,
      maximized: await window.ncmDesktop?.isMaximized?.(),
      updateState: await window.ncmDesktop?.getUpdateState?.(),
      exportReady: typeof window.ncmDesktop?.exportResultsPdf === "function"
    }))()` ) as { platform?: string; maximized?: boolean; updateState?: { supported?: boolean }; exportReady?: boolean };
    if (bridge.platform !== process.platform || typeof bridge.maximized !== "boolean" || typeof bridge.updateState?.supported !== "boolean" || bridge.exportReady !== true) {
      throw new Error("Desktop window preload bridge is unavailable.");
    }
    if (process.platform === "win32" && app.isPackaged && bridge.updateState.supported !== true) {
      throw new Error(`Packaged Windows updater failed to initialize. See ${writeDesktopLog("windows-updater-smoke", windowsUpdateFallbackState?.error ?? "unknown error") ?? "desktop log"}.`);
    }
    const smokeResult = `DESKTOP_WINDOW_BRIDGE_OK ${bridge.platform}\nDESKTOP_SMOKE_OK ${url}\n`;
    if (process.env.NCM_DESKTOP_SMOKE_RESULT) {
      writeFileSync(process.env.NCM_DESKTOP_SMOKE_RESULT, smokeResult, "utf8");
    }
    process.stdout.write(`DESKTOP_WINDOW_BRIDGE_OK ${bridge.platform}\n`);
    process.stdout.write(`DESKTOP_SMOKE_OK ${url}\n`);
    setTimeout(() => app.quit(), 250);
  }
}

app.whenReady().then(createWindow).catch((error) => {
  const logPath = writeDesktopLog("startup-fatal", error);
  const detail = logPath
    ? `启动日志已保存到：\n${logPath}`
    : "启动日志写入失败，请截图此提示并反馈。";
  dialog.showErrorBox("乐评寻踪启动失败", `${errorText(error)}\n\n${detail}`);
  process.stderr.write(`${errorText(error)}\n`);
  app.exit(1);
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  dashboard?.close();
  dashboard = undefined;
  dashboardUrl = undefined;
  mainWindow = undefined;
  windowsUpdater = undefined;
  windowsUpdateFallbackState = undefined;
});
