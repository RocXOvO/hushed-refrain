import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join } from "node:path";
import { startDashboard } from "./server";
import {
  DesktopResultExportError,
  runDesktopResultExport,
  writeDesktopResultPdf,
  type DesktopResultReportSession,
} from "./desktop-result-export";
import {
  DESKTOP_SETTINGS_CHANNELS,
  DESKTOP_EXPORT_CHANNELS,
  DESKTOP_UPDATE_CHANNELS,
  DESKTOP_WINDOW_CHANNELS,
  desktopDashboardUrl,
  desktopResultReportUrl,
  desktopWindowChrome,
  parseDesktopResultExportRequest,
  resultReportFilename,
} from "./window-shell";
import {
  DEFAULT_DESKTOP_SETTINGS,
  DesktopSettingsStore,
  type DesktopCloseBehavior,
  type DesktopSettings,
} from "./desktop-settings";
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
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();

let dashboard: Server | undefined;
let windowsUpdater: WindowsUpdateController | undefined;
let windowsUpdateFallbackState: WindowsUpdateState | undefined;
let mainWindow: BrowserWindow | undefined;
let dashboardUrl: string | undefined;
let resultExportInProgress = false;
let resultExportAbortController: AbortController | undefined;
const desktopSettingsStore = new DesktopSettingsStore(
  join(app.getPath("userData"), "desktop-settings.json"),
  (error) => { writeDesktopLog("desktop-settings-recovery", error); },
);
let desktopSettings: DesktopSettings = { ...DEFAULT_DESKTOP_SETTINGS };
let tray: Tray | undefined;
let isQuitting = false;
let quitApproved = false;
let gracefulQuitPromise: Promise<void> | undefined;
let closeDecisionPending = false;

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
ipcMain.handle(DESKTOP_SETTINGS_CHANNELS.get, (event) => {
  assertMainWindowSender(event);
  return desktopSettings;
});
ipcMain.handle(DESKTOP_SETTINGS_CHANNELS.update, async (event, value: unknown) => {
  assertMainWindowSender(event);
  desktopSettings = await desktopSettingsStore.update(value);
  return desktopSettings;
});
ipcMain.handle(DESKTOP_SETTINGS_CHANNELS.reset, async (event) => {
  assertMainWindowSender(event);
  desktopSettings = await desktopSettingsStore.reset();
  return desktopSettings;
});
ipcMain.handle(DESKTOP_EXPORT_CHANNELS.resultsPdf, async (event, rawRequest: unknown) => {
  const window = senderWindow(event);
  if (!window || window !== mainWindow || !dashboardUrl) throw new Error("当前窗口不能导出报告。");
  if (resultExportInProgress) throw new Error("已有一份 PDF 正在生成，请稍候。");
  const request = parseDesktopResultExportRequest(rawRequest);
  const exportAbort = new AbortController();
  resultExportInProgress = true;
  resultExportAbortController = exportAbort;
  try {
    const reportUrl = desktopResultReportUrl(dashboardUrl, request);
    return await runDesktopResultExport(request, {
      reportUrl,
      chooseDestination: async () => {
        const destination = await dialog.showSaveDialog(window, {
          title: "导出评论检索报告",
          defaultPath: join(app.getPath("documents"), resultReportFilename(request)),
          filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
          properties: ["createDirectory", "showOverwriteConfirmation"],
        });
        return destination.canceled ? undefined : destination.filePath;
      },
      createSession: () => createDesktopReportSession(window, reportUrl),
      write: writeDesktopResultPdf,
      signal: exportAbort.signal,
      onProgress: (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(DESKTOP_EXPORT_CHANNELS.resultsPdfProgress, progress);
        }
      },
    });
  } catch (error) {
    const failure = error instanceof DesktopResultExportError ? error : undefined;
    const stage = failure?.stage ?? "save-dialog";
    const code = failure?.code ?? "failed";
    const category = desktopExportFailureCategory(failure?.cause ?? error);
    const logPath = writeDesktopLog("pdf-export", `stage=${stage} code=${code} category=${category}`);
    return {
      status: "failed",
      message: failure?.message ?? "选择保存位置失败，请重试。",
      logAvailable: Boolean(logPath),
    };
  } finally {
    if (resultExportAbortController === exportAbort) resultExportAbortController = undefined;
    resultExportInProgress = false;
  }
});
ipcMain.handle(DESKTOP_EXPORT_CHANNELS.cancelResultsPdf, (event) => {
  const window = senderWindow(event);
  if (!window || window !== mainWindow) throw new Error("当前窗口不能取消报告导出。");
  resultExportAbortController?.abort(new Error("user-cancelled-pdf-export"));
  return { cancelling: Boolean(resultExportAbortController) };
});

function createDesktopReportSession(parent: BrowserWindow, reportUrl: string): DesktopResultReportSession {
  const reportWindow = new BrowserWindow({
    show: false,
    parent,
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
  let closing = false;
  let rejectFatal = (_error: unknown): void => {};
  const fatal = new Promise<never>((_resolve, reject) => { rejectFatal = reject; });
  reportWindow.webContents.once("render-process-gone", () => rejectFatal(new Error("report-renderer-gone")));
  reportWindow.once("unresponsive", () => rejectFatal(new Error("report-window-unresponsive")));
  reportWindow.once("closed", () => {
    if (!closing) rejectFatal(new Error("report-window-closed"));
  });
  const guarded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, fatal]);
  return {
    load: (url) => guarded(reportWindow.loadURL(url)),
    waitForReadyReport: () => guarded(reportWindow.webContents.executeJavaScript(`Promise.resolve(document.fonts?.ready).then(() => ({ platform: document.querySelector('meta[name="result-report-platform"]')?.content, mode: document.querySelector('meta[name="result-report-mode"]')?.content, jobId: document.querySelector('meta[name="result-report-job"]')?.content, targetKind: document.querySelector('meta[name="result-report-target-kind"]')?.content, target: document.querySelector('meta[name="result-report-target"]')?.content, errorText: document.contentType === 'application/json' ? document.body?.innerText : undefined }))`)),
    print: () => guarded(reportWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: "A4",
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: '<div style="width:100%;padding:0 10mm;display:flex;justify-content:space-between;color:#7b888d;font:8px sans-serif"><span>乐评寻踪</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
      margins: { top: 0.4, bottom: 0.55, left: 0.35, right: 0.35 },
    })),
    close: () => {
      if (!reportWindow.isDestroyed()) {
        closing = true;
        reportWindow.destroy();
      }
    },
  };
}

async function runDesktopPdfSmoke(parent: BrowserWindow, destination: string): Promise<void> {
  const request = parseDesktopResultExportRequest({
    platform: "netease",
    mode: "source",
    jobId: "00000000-0000-4000-8000-000000000001",
    target: { kind: "uid", value: "9000000001" },
  });
  const html = `<!doctype html><meta name="result-report-platform" content="netease"><meta name="result-report-mode" content="source"><meta name="result-report-job" content="${request.jobId}"><meta name="result-report-target-kind" content="uid"><meta name="result-report-target" content="9000000001"><style>@page{size:A4;margin:15mm}body{font:16px sans-serif}</style><h1>乐评寻踪 PDF smoke</h1><p>Chromium hidden report print pipeline.</p>`;
  const reportUrl = `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
  const result = await runDesktopResultExport(request, {
    reportUrl,
    chooseDestination: async () => destination,
    createSession: () => createDesktopReportSession(parent, reportUrl),
    write: writeDesktopResultPdf,
  });
  if (result.status !== "saved") throw new Error("Packaged PDF smoke did not save a file.");
  const bytes = readFileSync(destination);
  if (bytes.length < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Packaged PDF smoke output is invalid.");
  }
}

async function createWindow(): Promise<void> {
  desktopSettings = await desktopSettingsStore.load();
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
  window.on("close", (event) => {
    if (quitApproved) return;
    event.preventDefault();
    void requestWindowClose(window).catch((error) => {
      writeDesktopLog("window-close", error);
      if (!window.isDestroyed()) window.show();
      dialog.showErrorBox("无法关闭窗口", "关闭操作未完成，主窗口已保持打开。请重试。");
    });
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
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
      settings: await window.ncmDesktop?.getSettings?.(),
      exportReady: typeof window.ncmDesktop?.exportResultsPdf === "function"
    }))()` ) as { platform?: string; maximized?: boolean; updateState?: { supported?: boolean }; settings?: { closeBehavior?: string; cursorTrailEnabled?: boolean }; exportReady?: boolean };
    if (bridge.platform !== process.platform || typeof bridge.maximized !== "boolean" || typeof bridge.updateState?.supported !== "boolean" || !["ask", "background", "exit"].includes(bridge.settings?.closeBehavior ?? "") || typeof bridge.settings?.cursorTrailEnabled !== "boolean" || bridge.exportReady !== true) {
      throw new Error("Desktop window preload bridge is unavailable.");
    }
    if (process.platform === "win32" && app.isPackaged && bridge.updateState.supported !== true) {
      throw new Error(`Packaged Windows updater failed to initialize. See ${writeDesktopLog("windows-updater-smoke", windowsUpdateFallbackState?.error ?? "unknown error") ?? "desktop log"}.`);
    }
    let pdfSmoke = "";
    const destination = process.env.NCM_DESKTOP_SMOKE_PDF;
    if (process.platform === "win32" && app.isPackaged && !destination) {
      throw new Error("Packaged Windows PDF smoke destination is missing.");
    }
    if (destination) {
      await runDesktopPdfSmoke(window, destination);
      pdfSmoke = "DESKTOP_PDF_OK\n";
    }
    const smokeResult = `DESKTOP_WINDOW_BRIDGE_OK ${bridge.platform}\n${pdfSmoke}DESKTOP_SMOKE_OK ${url}\n`;
    if (process.env.NCM_DESKTOP_SMOKE_RESULT) {
      writeFileSync(process.env.NCM_DESKTOP_SMOKE_RESULT, smokeResult, "utf8");
    }
    process.stdout.write(`DESKTOP_WINDOW_BRIDGE_OK ${bridge.platform}\n`);
    if (pdfSmoke) process.stdout.write(pdfSmoke);
    process.stdout.write(`DESKTOP_SMOKE_OK ${url}\n`);
    setTimeout(() => app.quit(), 250);
  }
}

function assertMainWindowSender(event: Electron.IpcMainInvokeEvent): void {
  const window = senderWindow(event);
  if (!window || window !== mainWindow) throw new Error("当前窗口不能修改全局设置。");
}

function showMainWindow(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  app.dock?.show();
}

function ensureTray(): Tray {
  if (tray && !tray.isDestroyed()) return tray;
  tray = undefined;
  const icon = nativeImage.createFromPath(join(app.getAppPath(), "web", "app-icon.png")).resize({ width: 18, height: 18 });
  if (icon.isEmpty()) throw new Error("tray-icon-empty");
  const nextTray = new Tray(icon);
  try {
    nextTray.setToolTip("乐评寻踪");
    nextTray.setContextMenu(Menu.buildFromTemplate([
      { label: "显示主界面", click: showMainWindow },
      { type: "separator" },
      {
        label: "退出应用",
        click: () => { void requestGracefulQuit(); },
      },
    ]));
    nextTray.on("click", showMainWindow);
    tray = nextTray;
    return nextTray;
  } catch (error) {
    try {
      nextTray.destroy();
    } catch {
      // The original setup error is more useful than a best-effort cleanup failure.
    }
    throw error;
  }
}

function moveWindowToBackground(window: BrowserWindow): boolean {
  try {
    ensureTray();
    window.hide();
    app.dock?.hide();
    return true;
  } catch (error) {
    writeDesktopLog("tray-create", error);
    if (!window.isDestroyed()) {
      window.show();
      window.focus();
    }
    dialog.showErrorBox("无法转入后台", "系统托盘初始化失败，主窗口已保持打开。");
    return false;
  }
}

async function rememberCloseBehavior(behavior: DesktopCloseBehavior): Promise<void> {
  try {
    desktopSettings = await desktopSettingsStore.update({ closeBehavior: behavior });
  } catch (error) {
    writeDesktopLog("desktop-settings-save", error);
    dialog.showErrorBox("设置保存失败", "本次关闭选择仍会执行，但无法记住到下次启动。");
  }
}

async function requestWindowClose(window: BrowserWindow): Promise<void> {
  if (closeDecisionPending || window.isDestroyed()) return;
  closeDecisionPending = true;
  try {
    let behavior = desktopSettings.closeBehavior;
    if (behavior === "ask") {
      const decision = await dialog.showMessageBox(window, {
        type: "question",
        title: "关闭乐评寻踪",
        message: "要退出应用，还是转入后台继续运行？",
        detail: "转入后台会保留本地服务和正在进行的任务；退出应用会结束当前进程。",
        buttons: ["退出应用", "转入后台", "取消"],
        defaultId: 1,
        cancelId: 2,
        noLink: true,
        checkboxLabel: "记住我的选择",
        checkboxChecked: false,
      });
      if (decision.response === 2) return;
      behavior = decision.response === 0 ? "exit" : "background";
      if (decision.checkboxChecked) await rememberCloseBehavior(behavior);
    }
    if (behavior === "background") {
      moveWindowToBackground(window);
      return;
    }
    await requestGracefulQuit();
  } finally {
    closeDecisionPending = false;
  }
}

async function prepareDashboardForQuit(): Promise<void> {
  const origin = dashboardUrl;
  if (!origin) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("desktop-quit-timeout")), 45_000);
  timeout.unref?.();
  try {
    const prepareResponse = await fetch(new URL("/api/tasks/prepare-update", origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    if (!prepareResponse.ok) throw new Error(`prepare-update-http-${prepareResponse.status}`);
    let state = await prepareResponse.json() as { active?: boolean; mode?: string };
    while (state.active && state.mode !== "pool" && !controller.signal.aborted) {
      await quitDelay(125, controller.signal);
      const activeResponse = await fetch(new URL("/api/tasks/active", origin), { signal: controller.signal });
      if (!activeResponse.ok) throw new Error(`active-task-http-${activeResponse.status}`);
      state = await activeResponse.json() as { active?: boolean; mode?: string };
    }
  } finally {
    clearTimeout(timeout);
  }
}

function requestGracefulQuit(): Promise<void> {
  if (gracefulQuitPromise) return gracefulQuitPromise;
  isQuitting = true;
  gracefulQuitPromise = (async () => {
    try {
      await prepareDashboardForQuit();
    } catch (error) {
      writeDesktopLog("graceful-quit", error);
    }
    quitApproved = true;
    app.quit();
  })();
  return gracefulQuitPromise;
}

function quitDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

if (primaryInstance) app.on("second-instance", showMainWindow);

(primaryInstance ? app.whenReady().then(createWindow) : Promise.resolve()).catch((error) => {
  const logPath = writeDesktopLog("startup-fatal", error);
  const detail = logPath
    ? `启动日志已保存到：\n${logPath}`
    : "启动日志写入失败，请截图此提示并反馈。";
  dialog.showErrorBox("乐评寻踪启动失败", `${errorText(error)}\n\n${detail}`);
  process.stderr.write(`${errorText(error)}\n`);
  app.exit(1);
});

app.on("activate", showMainWindow);
app.on("window-all-closed", () => {
  if (!mainWindow) void requestGracefulQuit();
});
app.on("before-quit", (event) => {
  if (!quitApproved) {
    event.preventDefault();
    void requestGracefulQuit();
    return;
  }
  isQuitting = true;
  resultExportAbortController?.abort(new Error("application-quit"));
  resultExportAbortController = undefined;
  dashboard?.close();
  dashboard = undefined;
  dashboardUrl = undefined;
  mainWindow = undefined;
  windowsUpdater = undefined;
  windowsUpdateFallbackState = undefined;
  tray?.destroy();
  tray = undefined;
});

function desktopExportFailureCategory(error: unknown): string {
  const candidate = error as { code?: unknown; message?: unknown; name?: unknown } | undefined;
  const code = typeof candidate?.code === "string" && /^[A-Z0-9_]{2,40}$/.test(candidate.code)
    ? candidate.code
    : undefined;
  if (code) return `os-${code}`;
  const message = String(candidate?.message ?? "").toLowerCase();
  if (message.includes("renderer-gone")) return "renderer-gone";
  if (message.includes("window-unresponsive")) return "window-unresponsive";
  if (message.includes("window-closed") || message.includes("object has been destroyed")) return "window-closed";
  if (message.includes("print")) return "print-pipeline";
  if (message.includes("load")) return "report-load";
  return typeof candidate?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(candidate.name)
    ? `error-${candidate.name}`
    : "unknown";
}
