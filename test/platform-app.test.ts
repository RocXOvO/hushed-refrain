import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const appSource = readFileSync(join(process.cwd(), "web", "app.js"), "utf8");

function extractFunction(name: string): string {
  const syncStart = appSource.indexOf(`function ${name}(`);
  const asyncStart = appSource.indexOf(`async function ${name}(`);
  const start = [syncStart, asyncStart].filter((value) => value >= 0).sort((left, right) => left - right)[0];
  assert.notEqual(start, undefined, `missing ${name}`);
  const bodyStart = appSource.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < appSource.length; index += 1) {
    if (appSource[index] === "{") depth += 1;
    else if (appSource[index] === "}") {
      depth -= 1;
      if (depth === 0) return appSource.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

test("deferred platform scroll restoration waits for content and rejects stale generations", () => {
  const context: Record<string, unknown> = {};
  context.globalThis = context;
  vm.runInNewContext(`
    var pendingPlatformScrollRestore;
    var platformSwitchVersion = 7;
    var platform = "qq";
    var desiredPlatform = "qq";
    ${extractFunction("armPlatformScrollRestore")}
    ${extractFunction("restorePendingPlatformScroll")}
    globalThis.api = {
      armPlatformScrollRestore,
      restorePendingPlatformScroll,
      setVersion(value) { platformSwitchVersion = value; },
    };
  `, context);
  const api = context.api as {
    armPlatformScrollRestore(platform: string, version: number, restore: () => void): void;
    restorePendingPlatformScroll(): boolean;
    setVersion(value: number): void;
  };

  let scrollHeight = 0;
  let scrollWidth = 0;
  let scrollTop = 0;
  let scrollLeft = 0;
  api.armPlatformScrollRestore("qq", 7, () => {
    scrollTop = Math.min(240, scrollHeight);
    scrollLeft = Math.min(160, scrollWidth);
  });
  assert.equal(scrollTop, 0, "arming must not restore against the empty table");
  assert.equal(scrollLeft, 0);
  scrollHeight = 600;
  scrollWidth = 500;
  assert.equal(api.restorePendingPlatformScroll(), true);
  assert.equal(scrollTop, 240);
  assert.equal(scrollLeft, 160);
  assert.equal(api.restorePendingPlatformScroll(), false, "the restoration is one-shot");

  let staleRestores = 0;
  api.armPlatformScrollRestore("qq", 7, () => { staleRestores += 1; });
  api.setVersion(8);
  assert.equal(api.restorePendingPlatformScroll(), false);
  assert.equal(staleRestores, 0, "a stale platform generation must never move the current view");
});

test("platform switching makes new WAAPI and disclosure motion settle immediately", async () => {
  const context: Record<string, unknown> = {
    document: { body: { classList: { contains: (name: string) => name === "platform-switching" } } },
    disclosureAnimations: new WeakMap(),
    activeDisclosureDetails: new Set(),
    interfaceAnimations: new Set(),
    fallbackMotionElements: new Set(),
    clearFallbackMotion() {},
    matchMedia: () => ({ matches: false }),
  };
  context.globalThis = context;
  vm.runInNewContext(`
    ${extractFunction("playMotion")}
    ${extractFunction("animateDisclosure")}
    globalThis.api = { playMotion, animateDisclosure };
  `, context);
  const api = context.api as {
    playMotion(element: unknown, frames: unknown[], duration: number, easing: string): Promise<void>;
    animateDisclosure(details: unknown, expanded: boolean): Promise<void>;
  };

  let animationCalls = 0;
  await api.playMotion({
    animate() {
      animationCalls += 1;
      return { finished: Promise.resolve() };
    },
  }, [{ opacity: 0 }, { opacity: 1 }], 240, "linear");
  assert.equal(animationCalls, 0);

  const attributes = new Map<string, string>();
  const summary = { setAttribute(name: string, value: string) { attributes.set(name, value); } };
  const content = {
    scrollHeight: 320,
    animate() {
      animationCalls += 1;
      return { finished: Promise.resolve(), cancel() {} };
    },
  };
  const details = {
    open: false,
    dataset: { expanded: "false" },
    classList: { add() {}, remove() {} },
    querySelector(selector: string) { return selector.includes("summary") ? summary : content; },
  };
  await api.animateDisclosure(details, true);
  assert.equal(details.open, true);
  assert.equal(details.dataset.expanded, "true");
  assert.equal(attributes.get("aria-expanded"), "true");
  assert.equal(animationCalls, 0);
});
