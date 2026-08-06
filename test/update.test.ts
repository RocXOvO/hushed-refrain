import assert from "node:assert/strict";
import { test } from "node:test";
import { checkForUpdate, compareVersions, selectReleaseAsset } from "../src/update";

test("version comparison handles stable and prerelease versions", () => {
  assert.equal(compareVersions("v1.2.0", "1.1.9"), 1);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("1.2.0-beta.2", "1.2.0-beta.10"), -1);
  assert.equal(compareVersions("1.2.0", "1.2.0-rc.1"), 1);
});

test("release asset selection matches the current platform and architecture", () => {
  const assets = [
    { name: "NCM-Comment-Finder-0.2.0-arm64.dmg", browser_download_url: "https://example.test/mac-arm64" },
    { name: "NCM-Comment-Finder-0.2.0-x64.dmg", browser_download_url: "https://example.test/mac-x64" },
    { name: "NCM-Comment-Finder-Setup-0.2.0.exe", browser_download_url: "https://example.test/win-x64" },
    { name: "latest.yml", browser_download_url: "https://example.test/latest" },
  ];

  assert.equal(selectReleaseAsset(assets, "darwin", "arm64")?.browser_download_url, "https://example.test/mac-arm64");
  assert.equal(selectReleaseAsset(assets, "darwin", "x64")?.browser_download_url, "https://example.test/mac-x64");
  assert.equal(selectReleaseAsset(assets, "win32", "x64")?.browser_download_url, "https://example.test/win-x64");
  assert.equal(selectReleaseAsset(assets, "win32", "arm64"), undefined);
  assert.equal(selectReleaseAsset(assets, "linux", "x64"), undefined);
});

test("update check returns the matching download when a newer release exists", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.match(String(input), /RocXOvO\/ncm-comment-finder\/releases\/latest$/);
    assert.ok(init?.signal);
    return new Response(JSON.stringify({
      tag_name: "v0.2.0",
      name: "云评检索台 v0.2.0",
      html_url: "https://example.test/releases/v0.2.0",
      body: "新增启动更新检查。",
      published_at: "2026-08-06T00:00:00Z",
      assets: [
        {
          name: "NCM-Comment-Finder-Setup-0.2.0.exe",
          browser_download_url: "https://example.test/download.exe",
          size: 123,
        },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const value = await checkForUpdate({ currentVersion: "0.1.0", platform: "win32", arch: "x64", fetchImpl });
  assert.equal(value.updateAvailable, true);
  assert.equal(value.currentVersion, "0.1.0");
  assert.equal(value.latestVersion, "0.2.0");
  assert.equal(value.assetName, "NCM-Comment-Finder-Setup-0.2.0.exe");
  assert.equal(value.downloadUrl, "https://example.test/download.exe");
});

test("update check falls back to the public release page when the API is rate limited", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) return new Response("rate limited", { status: 403 });
    if (url.endsWith("/releases/latest")) {
      const response = new Response("latest", { status: 200 });
      Object.defineProperty(response, "url", { value: "https://github.com/RocXOvO/ncm-comment-finder/releases/tag/v0.3.0" });
      return response;
    }
    return new Response('<a href="/RocXOvO/ncm-comment-finder/releases/download/v0.3.0/NCM-Comment-Finder-0.3.0-arm64.dmg">DMG</a>', { status: 200 });
  };

  const value = await checkForUpdate({ currentVersion: "0.2.0", platform: "darwin", arch: "arm64", fetchImpl });
  assert.equal(value.updateAvailable, true);
  assert.equal(value.latestVersion, "0.3.0");
  assert.equal(value.assetName, "NCM-Comment-Finder-0.3.0-arm64.dmg");
});
