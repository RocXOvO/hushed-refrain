import assert from "node:assert/strict";
import test from "node:test";
import { desktopDashboardUrl, desktopWindowChrome } from "../src/window-shell";

test("uses a frameless window only on Windows", () => {
  assert.deepEqual(desktopWindowChrome("win32"), { frame: false });
  assert.deepEqual(desktopWindowChrome("darwin"), {});
  assert.deepEqual(desktopWindowChrome("linux"), {});
});

test("marks the dashboard URL with the desktop platform", () => {
  assert.equal(
    desktopDashboardUrl("http://127.0.0.1:4321/", "win32"),
    "http://127.0.0.1:4321/?desktop=win32",
  );
});
