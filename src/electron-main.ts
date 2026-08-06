import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join } from "node:path";
import { startDashboard } from "./server";
import { DESKTOP_UPDATE_CHANNELS, DESKTOP_WINDOW_CHANNELS, desktopDashboardUrl, desktopWindowChrome } from "./window-shell";
import {
  isWindowsAutoUpdateSupported,
  unsupportedWindowsUpdateState,
  WindowsUpdateController,
  type WindowsUpdateState,
  type WindowsUpdaterBackend,
} from "./windows-updater";

let dashboard: Server | undefined;
let windowsUpdater: WindowsUpdateController | undefined;
let windowsUpdateFallbackState: WindowsUpdateState | undefined;

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

async function createWindow(): Promise<void> {
  dashboard = await startDashboard({
    host: "127.0.0.1",
    port: 0,
    runtimeRoot: app.getPath("userData"),
    currentVersion: app.getVersion(),
  });
  const address = dashboard.address() as AddressInfo;
  const url = desktopDashboardUrl(`http://127.0.0.1:${address.port}/`, process.platform);
  const smokeTest = process.env.NCM_DESKTOP_SMOKE === "1";
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: !smokeTest,
    backgroundColor: "#f3f5f6",
    autoHideMenuBar: true,
    title: "云评检索台",
    ...desktopWindowChrome(process.platform),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "electron-preload.js"),
    },
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
      updateState: await window.ncmDesktop?.getUpdateState?.()
    }))()` ) as { platform?: string; maximized?: boolean; updateState?: { supported?: boolean } };
    if (bridge.platform !== process.platform || typeof bridge.maximized !== "boolean" || typeof bridge.updateState?.supported !== "boolean") {
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
  dialog.showErrorBox("云评检索台启动失败", `${errorText(error)}\n\n${detail}`);
  process.stderr.write(`${errorText(error)}\n`);
  app.exit(1);
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  dashboard?.close();
  dashboard = undefined;
  windowsUpdater = undefined;
  windowsUpdateFallbackState = undefined;
});
