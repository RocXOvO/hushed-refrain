import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("assisted Windows installer exposes launch and desktop shortcut choices", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    build?: { nsis?: Record<string, unknown> };
  };
  const nsis = manifest.build?.nsis;
  assert.equal(nsis?.oneClick, false);
  assert.equal(nsis?.runAfterFinish, true);
  assert.equal(nsis?.createDesktopShortcut, true);
  assert.equal(nsis?.include, "build/installer.nsh");
  assert.deepEqual(nsis?.installerLanguages, ["zh_CN"]);

  const include = await readFile("build/installer.nsh", "utf8");
  assert.match(include, /customPageAfterChangeDir/);
  assert.match(include, /在桌面创建/);
  assert.match(include, /NSD_GetState/);
  assert.match(include, /Delete "\$newDesktopLink"/);
  assert.doesNotMatch(include, /ExecShellAsUser[^\n]*\$appExe/);
});
