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

test("deferred results scroll restoration is scoped, cancellable, and generation safe", () => {
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const context: Record<string, unknown> = {
    setTimeout(callback: () => void) {
      const timer = ++nextTimer;
      timers.set(timer, callback);
      return timer;
    },
    clearTimeout(timer: number) { timers.delete(timer); },
  };
  context.globalThis = context;
  vm.runInNewContext(`
    var pendingPlatformScrollRestore;
    var PLATFORM_SCROLL_RESTORE_TTL_MS = 2500;
    var platformSwitchVersion = 7;
    var platform = "qq";
    var desiredPlatform = "qq";
    var mode = "song";
    var resultRequest = 11;
    var resultGenerationRevisions = { "qq:song": 3, "qq:likes": 0 };
    function taskViewKey() { return platform + ":" + mode; }
    ${extractFunction("cancelPendingPlatformScrollRestore")}
    ${extractFunction("armPlatformScrollRestore")}
    ${extractFunction("restorePendingPlatformScroll")}
    globalThis.api = {
      cancelPendingPlatformScrollRestore,
      armPlatformScrollRestore,
      restorePendingPlatformScroll,
      setVersion(value) { platformSwitchVersion = value; },
      setMode(value) { mode = value; },
      setResultRequest(value) { resultRequest = value; },
      setGenerationRevision(value) { resultGenerationRevisions[taskViewKey()] = value; },
    };
  `, context);
  const api = context.api as {
    cancelPendingPlatformScrollRestore(): void;
    armPlatformScrollRestore(platform: string, mode: string, version: number, state: unknown): void;
    restorePendingPlatformScroll(): boolean;
    setVersion(value: number): void;
    setMode(value: string): void;
    setResultRequest(value: number): void;
    setGenerationRevision(value: number): void;
  };

  const listeners = new Map<string, Set<() => void>>();
  const resultNode = {
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener(type: string, listener: () => void) { listeners.get(type)?.delete(listener); },
    dispatch(type: string) { for (const listener of [...(listeners.get(type) || [])]) listener(); },
  };

  let scrollHeight = 0;
  let scrollWidth = 0;
  let scrollTop = 0;
  let scrollLeft = 0;
  const scrollState = {
    resultNode,
    restoreResult() {
      scrollTop = Math.min(240, scrollHeight);
      scrollLeft = Math.min(160, scrollWidth);
    },
  };
  api.armPlatformScrollRestore("qq", "song", 7, scrollState);
  assert.equal(scrollTop, 0, "arming must not restore against the empty table");
  assert.equal(scrollLeft, 0);
  scrollHeight = 600;
  scrollWidth = 500;
  assert.equal(api.restorePendingPlatformScroll(), true);
  assert.equal(scrollTop, 240);
  assert.equal(scrollLeft, 160);
  assert.equal(api.restorePendingPlatformScroll(), false, "the restoration is one-shot");

  let staleRestores = 0;
  const staleState = { resultNode, restoreResult() { staleRestores += 1; } };
  api.armPlatformScrollRestore("qq", "song", 7, staleState);
  api.setVersion(8);
  assert.equal(api.restorePendingPlatformScroll(), false);
  assert.equal(staleRestores, 0, "a stale platform generation must never move the current view");

  api.setVersion(7);
  api.armPlatformScrollRestore("qq", "song", 7, staleState);
  api.setMode("likes");
  assert.equal(api.restorePendingPlatformScroll(), false);
  assert.equal(staleRestores, 0, "changing mode invalidates deferred movement");

  api.setMode("song");
  let refreshRestores = 0;
  const refreshState = { resultNode, restoreResult() { refreshRestores += 1; } };
  api.armPlatformScrollRestore("qq", "song", 7, refreshState);
  api.setResultRequest(12);
  assert.equal(api.restorePendingPlatformScroll(), true);
  assert.equal(refreshRestores, 1, "ordinary result refresh requests preserve deferred restoration");

  api.armPlatformScrollRestore("qq", "song", 7, staleState);
  api.setGenerationRevision(4);
  assert.equal(api.restorePendingPlatformScroll(), false);
  assert.equal(staleRestores, 0, "a new result job generation cannot inherit the previous table offset");

  api.setResultRequest(11);
  api.setGenerationRevision(3);
  api.armPlatformScrollRestore("qq", "song", 7, staleState);
  resultNode.dispatch("wheel");
  assert.equal(api.restorePendingPlatformScroll(), false);
  assert.equal(staleRestores, 0, "direct user interaction owns the new scroll position");

  api.armPlatformScrollRestore("qq", "song", 7, staleState);
  for (const callback of [...timers.values()]) callback();
  assert.equal(api.restorePendingPlatformScroll(), false, "expired restoration cannot surprise the user later");
  assert.equal(staleRestores, 0);
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
