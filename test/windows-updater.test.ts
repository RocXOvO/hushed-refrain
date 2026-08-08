import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  isWindowsAutoUpdateSupported,
  unsupportedWindowsUpdateState,
  WindowsUpdateController,
  type WindowsUpdaterBackend,
  type WindowsUpdateState,
} from "../src/windows-updater";

class FakeUpdater extends EventEmitter implements WindowsUpdaterBackend {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  installArguments?: [boolean | undefined, boolean | undefined];

  async checkForUpdates(): Promise<void> {
    this.emit("checking-for-update");
    this.emit("update-available", {
      version: "0.4.0",
      releaseName: "乐评寻踪 v0.4.0",
      releaseDate: "2026-08-07T00:00:00Z",
      releaseNotes: [{ note: "新增自动更新。" }, { note: "修复下载状态。" }],
    });
  }

  async downloadUpdate(): Promise<void> {
    this.emit("download-progress", { percent: 42.5, transferred: 425, total: 1000, bytesPerSecond: 200 });
    this.emit("update-downloaded", { version: "0.4.0", releaseName: "乐评寻踪 v0.4.0" });
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installArguments = [isSilent, isForceRunAfter];
  }
}

test("enables native updates only for packaged Windows clients", () => {
  assert.equal(isWindowsAutoUpdateSupported("win32", true), true);
  assert.equal(isWindowsAutoUpdateSupported("win32", false), false);
  assert.equal(isWindowsAutoUpdateSupported("darwin", true), false);
  assert.deepEqual(unsupportedWindowsUpdateState("0.3.0"), {
    supported: false,
    phase: "unsupported",
    currentVersion: "0.3.0",
  });
});

test("checks, downloads, reports progress, and installs a Windows update", async () => {
  const updater = new FakeUpdater();
  const states: WindowsUpdateState[] = [];
  const controller = new WindowsUpdateController(updater, "0.3.0", (state) => states.push(state));

  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);

  const available = await controller.check();
  assert.equal(available.phase, "available");
  assert.equal(available.latestVersion, "0.4.0");
  assert.equal(available.releaseNotes, "新增自动更新。\n\n修复下载状态。");

  const downloaded = await controller.download();
  assert.equal(downloaded.phase, "downloaded");
  assert.equal(downloaded.percent, 100);
  assert.equal(downloaded.releaseNotes, "新增自动更新。\n\n修复下载状态。");
  assert.ok(states.some((state) => state.phase === "downloading" && state.percent === 42.5));

  assert.equal((await controller.check()).phase, "downloaded");

  controller.install();
  assert.deepEqual(updater.installArguments, [true, true]);
});

test("returns a safe error state when checking fails", async () => {
  const updater = new FakeUpdater();
  updater.checkForUpdates = async () => { throw new Error("network failed\nsecret detail"); };
  const controller = new WindowsUpdateController(updater, "0.3.0", () => {});

  const state = await controller.check();
  assert.equal(state.phase, "error");
  assert.equal(state.error, "network failed secret detail");
});

test("converts HTML release notes into readable safe text", async () => {
  const updater = new FakeUpdater();
  updater.checkForUpdates = async () => {
    updater.emit("update-available", {
      version: "0.4.1",
      releaseNotes: `<h2>更新内容</h2><ul>
        <li><strong>修复</strong>启动闪退</li>
        <li>并发 &amp; 估算同步 &#x1F680;</li>
      </ul><p>感谢使用&nbsp;乐评寻踪。</p><script>alert("hidden")</script>`,
    });
  };
  const controller = new WindowsUpdateController(updater, "0.4.0", () => {});

  const state = await controller.check();

  assert.equal(state.releaseNotes, "更新内容\n• 修复启动闪退\n• 并发 & 估算同步 🚀\n感谢使用 乐评寻踪。");
  assert.doesNotMatch(state.releaseNotes ?? "", /<[^>]+>|alert\(/);
});
