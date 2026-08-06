import { app, BrowserWindow, shell } from "electron";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { startDashboard } from "./server";

let dashboard: Server | undefined;

async function createWindow(): Promise<void> {
  dashboard = await startDashboard({
    host: "127.0.0.1",
    port: 0,
    runtimeRoot: app.getPath("userData"),
  });
  const address = dashboard.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/`;
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
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
