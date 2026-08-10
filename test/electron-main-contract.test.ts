import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("desktop shell is single-instance and exits through one bounded checkpoint handoff", async () => {
  const source = await readFile("src/electron-main.ts", "utf8");
  assert.match(source, /requestSingleInstanceLock\(\)/);
  assert.match(source, /app\.on\("second-instance", showMainWindow\)/);
  assert.match(source, /function requestGracefulQuit\(\)/);
  assert.match(source, /\/api\/tasks\/prepare-update/);
  assert.match(source, /\/api\/tasks\/active/);
  assert.match(source, /45_000/);
  assert.match(source, /app\.on\("before-quit", \(event\) => \{[\s\S]*event\.preventDefault\(\)[\s\S]*requestGracefulQuit\(\)/);
  assert.match(source, /label: "退出应用"[\s\S]*requestGracefulQuit\(\)/);
  assert.doesNotMatch(source, /label: "退出应用"[\s\S]{0,180}app\.quit\(\)/);
});

test("desktop shell keeps the window visible when tray setup cannot complete", async () => {
  const source = await readFile("src/electron-main.ts", "utf8");
  assert.match(source, /icon\.isEmpty\(\)/);
  assert.match(source, /function moveWindowToBackground[\s\S]*try \{[\s\S]*ensureTray\(\)[\s\S]*window\.hide\(\)[\s\S]*catch \(error\)[\s\S]*window\.show\(\)/);
  assert.match(source, /const nextTray = new Tray\(icon\)[\s\S]*nextTray\.setContextMenu[\s\S]*tray = nextTray[\s\S]*return nextTray/);
  assert.match(source, /catch \(error\) \{[\s\S]*nextTray\.destroy\(\)[\s\S]*throw error/);
  assert.match(source, /requestWindowClose\(window\)\.catch/);
});

test("desktop close confirmation is rendered inside the client instead of a native Windows prompt", async () => {
  const source = await readFile("src/electron-main.ts", "utf8");
  const requestWindowClose = source.slice(
    source.indexOf("async function requestWindowClose"),
    source.indexOf("async function prepareDashboardForQuit"),
  );
  assert.match(source, /ipcMain\.handle\(DESKTOP_WINDOW_CHANNELS\.closeDecision/);
  assert.match(source, /window\.webContents\.send\(DESKTOP_WINDOW_CHANNELS\.closeRequested\)/);
  assert.match(requestWindowClose, /await requestRendererCloseDecision\(window\)/);
  assert.doesNotMatch(requestWindowClose, /dialog\.showMessageBox/);
  assert.match(requestWindowClose, /decision\.action === "cancel"/);
  assert.match(requestWindowClose, /decision\.remember/);
});
