import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_DESKTOP_SETTINGS,
  decodeDesktopSettings,
  DesktopSettingsStore,
  parseDesktopSettingsPatch,
} from "../src/desktop-settings";

test("desktop settings decode unknown or future values to safe defaults", () => {
  assert.deepEqual(decodeDesktopSettings(undefined), DEFAULT_DESKTOP_SETTINGS);
  assert.deepEqual(decodeDesktopSettings({ version: 99, closeBehavior: "unknown" }), DEFAULT_DESKTOP_SETTINGS);
  assert.deepEqual(decodeDesktopSettings({ version: 1, closeBehavior: "background" }), {
    version: 2,
    closeBehavior: "background",
    cursorTrailEnabled: true,
  });
  assert.deepEqual(decodeDesktopSettings({ version: 2, closeBehavior: "exit", cursorTrailEnabled: false }), {
    version: 2,
    closeBehavior: "exit",
    cursorTrailEnabled: false,
  });
});

test("desktop settings accept safe partial updates", () => {
  assert.deepEqual(parseDesktopSettingsPatch({ closeBehavior: "exit" }), { closeBehavior: "exit" });
  assert.deepEqual(parseDesktopSettingsPatch({ cursorTrailEnabled: false }), { cursorTrailEnabled: false });
  assert.deepEqual(parseDesktopSettingsPatch({ closeBehavior: "background", cursorTrailEnabled: true }), {
    closeBehavior: "background",
    cursorTrailEnabled: true,
  });
  assert.throws(() => parseDesktopSettingsPatch(null), /格式/);
  assert.throws(() => parseDesktopSettingsPatch({}), /没有可更新/);
  assert.throws(() => parseDesktopSettingsPatch({ closeBehavior: "minimize" }), /行为无效/);
  assert.throws(() => parseDesktopSettingsPatch({ cursorTrailEnabled: "yes" }), /开关无效/);
});

test("desktop settings persist atomically and can restore defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-desktop-settings-"));
  const path = join(root, "desktop-settings.json");
  const store = new DesktopSettingsStore(path);
  assert.deepEqual(await store.load(), DEFAULT_DESKTOP_SETTINGS);
  assert.deepEqual(await store.update({ closeBehavior: "background" }), {
    version: 2,
    closeBehavior: "background",
    cursorTrailEnabled: true,
  });
  assert.deepEqual(await store.update({ cursorTrailEnabled: false }), {
    version: 2,
    closeBehavior: "background",
    cursorTrailEnabled: false,
  });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    version: 2,
    closeBehavior: "background",
    cursorTrailEnabled: false,
  });

  const reloaded = new DesktopSettingsStore(path);
  assert.deepEqual(await reloaded.load(), { version: 2, closeBehavior: "background", cursorTrailEnabled: false });
  assert.deepEqual(await reloaded.reset(), DEFAULT_DESKTOP_SETTINGS);
});

test("desktop settings serialize concurrent writes in invocation order", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-desktop-settings-order-"));
  const path = join(root, "desktop-settings.json");
  const store = new DesktopSettingsStore(path);
  await store.load();
  const first = store.update({ closeBehavior: "background" });
  const second = store.update({ cursorTrailEnabled: false });
  const third = store.reset();
  assert.deepEqual(await Promise.all([first, second, third]), [
    { version: 2, closeBehavior: "background", cursorTrailEnabled: true },
    { version: 2, closeBehavior: "background", cursorTrailEnabled: false },
    DEFAULT_DESKTOP_SETTINGS,
  ]);
  assert.deepEqual(store.get(), DEFAULT_DESKTOP_SETTINGS);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), DEFAULT_DESKTOP_SETTINGS);
});

test("desktop settings recover a corrupt file to safe defaults without blocking startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-desktop-settings-corrupt-"));
  const path = join(root, "desktop-settings.json");
  await writeFile(path, "{not-json", "utf8");
  const failures: unknown[] = [];
  const store = new DesktopSettingsStore(path, (error) => failures.push(error));
  assert.deepEqual(await store.load(), DEFAULT_DESKTOP_SETTINGS);
  assert.equal(failures.length, 1);
  assert.deepEqual(await store.update({ closeBehavior: "background" }), {
    version: 2,
    closeBehavior: "background",
    cursorTrailEnabled: true,
  });
});
