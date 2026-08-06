import { app, BrowserWindow, ipcMain, shell } from "electron";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join } from "node:path";
import { startDashboard } from "./server";
import { DESKTOP_WINDOW_CHANNELS, desktopDashboardUrl, desktopWindowChrome } from "./window-shell";

let dashboard: Server | undefined;

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
  await window.loadURL(url);
  if (smokeTest) {
    const bridge = await window.webContents.executeJavaScript(`(async () => ({
      platform: window.ncmDesktop?.platform,
      maximized: await window.ncmDesktop?.isMaximized?.()
    }))()` ) as { platform?: string; maximized?: boolean };
    if (bridge.platform !== process.platform || typeof bridge.maximized !== "boolean") {
      throw new Error("Desktop window preload bridge is unavailable.");
    }
    process.stdout.write(`DESKTOP_WINDOW_BRIDGE_OK ${bridge.platform}\n`);
    process.stdout.write(`DESKTOP_SMOKE_OK ${url}\n`);
    setTimeout(() => app.quit(), 250);
  }
}

app.whenReady().then(createWindow).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  dashboard?.close();
  dashboard = undefined;
});
