import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (path: string): Buffer => readFileSync(join(root, path));
const text = (path: string): string => read(path).toString("utf8");

test("uses one Hushed Refrain product and repository contract", () => {
  const manifest = JSON.parse(text("package.json")) as {
    name: string;
    version: string;
    bin: Record<string, string>;
    build: {
      appId: string;
      productName: string;
      publish: Array<{ owner: string; repo: string }>;
      win: { artifactName: string };
      mac: { artifactName: string };
      dmg: { title: string };
      nsis: { guid: string; shortcutName: string };
    };
  };
  assert.equal(manifest.name, "hushed-refrain");
  assert.equal(manifest.version, "1.3.1");
  assert.equal(manifest.build.appId, "cn.local.hushedrefrain");
  assert.equal(manifest.build.productName, "Hushed Refrain");
  assert.deepEqual(manifest.build.publish, [{ provider: "github", owner: "RocXOvO", repo: "hushed-refrain", releaseType: "release" }]);
  assert.equal(manifest.build.win.artifactName, "Hushed-Refrain-Setup-${version}.${ext}");
  assert.equal(manifest.build.mac.artifactName, "Hushed-Refrain-${version}-${arch}.${ext}");
  assert.equal(manifest.build.dmg.title, "Hushed Refrain ${version}");
  assert.equal(manifest.build.nsis.shortcutName, "Hushed Refrain");
  assert.equal(manifest.build.nsis.guid, "3777d05b-f162-546a-af88-e2bc45e86bda");
  assert.equal(manifest.bin["hushed-refrain"], "dist/cli.js");
  assert.equal(manifest.bin["ncm-comments"], "dist/cli.js");

  const updater = text("src/update.ts");
  assert.match(updater, /RocXOvO\/hushed-refrain/);
  assert.doesNotMatch(updater, /RocXOvO\/ncm-comment-finder/);
  const main = text("src/electron-main.ts");
  assert.match(main, /setAppUserModelId\("cn\.local\.hushedrefrain"\)/);
  assert.match(main, /resolveBrandedUserDataDirectory/);
  const workflow = text(".github/workflows/windows-package.yml");
  assert.match(workflow, /win-unpacked\\Hushed Refrain\.exe/);
  assert.match(workflow, /Hushed-Refrain-Setup-/);
  assert.doesNotMatch(workflow, /NCM-Comment-Finder|乐评寻踪/);
});

test("removes the previous display brand from every user-visible surface", () => {
  const surfaces = [
    "web/index.html",
    "web/app.js",
    "src/electron-main.ts",
    "src/result-report.ts",
    "src/cli.ts",
    "src/qq-cli.ts",
    "build/installer.nsh",
  ];
  for (const path of surfaces) {
    const source = text(path);
    assert.match(source, /Hushed Refrain/, path);
    assert.doesNotMatch(source, /乐评寻踪|MUSIC COMMENT TRACE/, path);
  }
  const page = text("web/index.html");
  assert.match(page, /THE WORDS LEFT BETWEEN SONGS/);
  assert.match(page, /写不出的喜欢，藏在听过的歌里。/);
});

test("exports one deterministic Veiled Echo icon family", () => {
  assert.equal(execFileSync(process.execPath, ["scripts/build-icons.cjs", "--check"], { cwd: root, encoding: "utf8" }).trim(), "ICON_ASSETS_CURRENT");
  const svg = text("build/icon.svg");
  assert.match(svg, /#17171B/);
  assert.match(svg, /#F4F0E8/);
  assert.match(svg, /#8C829C/);
  assert.doesNotMatch(svg, /<text\b|#d33a43|#31c27c/i);

  const png = read("build/icon.png");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  assert.equal(png[25], 6, "PNG must be RGBA");
  assert.deepEqual(read("web/app-icon.png"), png);

  const ico = read("build/icon.ico");
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const count = ico.readUInt16LE(4);
  const sizes = Array.from({ length: count }, (_, index) => {
    const width = ico[6 + index * 16];
    return width === 0 ? 256 : width;
  });
  assert.deepEqual(sizes, [256, 128, 64, 48, 32, 24, 18, 16]);

  const icns = read("build/icon.icns");
  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
});
