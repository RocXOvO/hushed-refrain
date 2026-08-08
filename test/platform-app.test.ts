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

test("platform transition preference defaults safely and persists an accessible mode toggle", async () => {
  const stored = new Map<string, string>([["ncm-platform-transition-pattern-v1", "future-mode"]]);
  const attributes = new Map<string, string>();
  const label = { textContent: "" };
  const button = {
    dataset: {} as Record<string, string>,
    title: "",
    setAttribute(name: string, value: string) { attributes.set(name, value); },
    querySelector() { return label; },
  };
  const messages: string[] = [];
  const savedPatterns: string[] = [];
  let switching = false;
  let failSaves = false;
  const context: Record<string, unknown> = {
    localStorage: {
      getItem(key: string) { return stored.get(key) ?? null; },
      setItem(key: string, value: string) { stored.set(key, value); },
    },
    document: { body: { classList: { contains: () => switching } } },
    el: { transitionMode: button },
    async api(_path: string, options?: { body?: string }) {
      if (!options?.body) return { platformTransitionPattern: "ripple" };
      if (failSaves) throw new Error("disk unavailable");
      const body = JSON.parse(options.body) as { platformTransitionPattern: string };
      savedPatterns.push(body.platformTransitionPattern);
      return { version: 1, ...body };
    },
    toast(message: string) { messages.push(message); },
  };
  context.globalThis = context;
  vm.runInNewContext(`
    var platformTransitionPattern = readTransitionPattern();
    var transitionPreferenceVersion = 0;
    var transitionPreferenceWriteTail = Promise.resolve();
    ${extractFunction("readTransitionPattern")}
    ${extractFunction("restoreTransitionPatternPreference")}
    ${extractFunction("persistTransitionPatternPreference")}
    ${extractFunction("syncTransitionModeButton")}
    ${extractFunction("toggleTransitionPattern")}
    globalThis.testApi = {
      readTransitionPattern,
      restoreTransitionPatternPreference,
      syncTransitionModeButton,
      toggleTransitionPattern,
      pattern() { return platformTransitionPattern; },
      settled() { return transitionPreferenceWriteTail; },
    };
  `, context);
  const api = context.testApi as {
    readTransitionPattern(): string;
    restoreTransitionPatternPreference(): Promise<void>;
    syncTransitionModeButton(): void;
    toggleTransitionPattern(): void;
    pattern(): string;
    settled(): Promise<void>;
  };

  assert.equal(api.readTransitionPattern(), "diagonal");
  await api.restoreTransitionPatternPreference();
  assert.equal(api.pattern(), "ripple");
  assert.equal(button.dataset.pattern, "ripple");
  assert.equal(button.title, "切换平台动效：中心涟漪");
  assert.equal(label.textContent, "涟漪");
  assert.equal(attributes.get("aria-label"), "当前平台动效为中心涟漪，点击切换为对角积木波");
  api.toggleTransitionPattern();
  await api.settled();
  assert.equal(api.pattern(), "diagonal");
  assert.equal(stored.get("ncm-platform-transition-pattern-v1"), "diagonal");
  assert.deepEqual(messages, ["平台切换动效已设为对角积木波。"]);
  switching = true;
  api.toggleTransitionPattern();
  await api.settled();
  assert.equal(api.pattern(), "ripple");
  assert.deepEqual(savedPatterns, ["diagonal", "ripple"]);
  assert.equal(messages.at(-1), "平台切换动效已设为中心涟漪，将在下次平台切换时生效。");
  switching = false;
  failSaves = true;
  api.toggleTransitionPattern();
  await api.settled();
  assert.equal(api.pattern(), "diagonal");
  assert.equal(stored.get("ncm-platform-transition-pattern-v1"), "diagonal");
  assert.equal(messages.at(-1), "动效已在本次会话生效，但本机偏好保存失败。");

  const failingContext: Record<string, unknown> = {
    localStorage: { getItem() { throw new Error("storage disabled"); } },
  };
  failingContext.globalThis = failingContext;
  vm.runInNewContext(`${extractFunction("readTransitionPattern")} globalThis.result = readTransitionPattern();`, failingContext);
  assert.equal(failingContext.result, "diagonal");
});

test("a delayed durable preference restore cannot overwrite a newer user selection", async () => {
  let resolveRestore!: (value: { platformTransitionPattern: string }) => void;
  const restoreResponse = new Promise<{ platformTransitionPattern: string }>((resolve) => { resolveRestore = resolve; });
  const stored = new Map<string, string>();
  const label = { textContent: "" };
  const savedPatterns: string[] = [];
  const context: Record<string, unknown> = {
    localStorage: {
      getItem(key: string) { return stored.get(key) ?? null; },
      setItem(key: string, value: string) { stored.set(key, value); },
    },
    document: { body: { classList: { contains: () => false } } },
    el: {
      transitionMode: {
        dataset: {},
        setAttribute() {},
        querySelector() { return label; },
      },
    },
    api(_path: string, options?: { body?: string }) {
      if (!options?.body) return restoreResponse;
      const value = JSON.parse(options.body) as { platformTransitionPattern: string };
      savedPatterns.push(value.platformTransitionPattern);
      return Promise.resolve(value);
    },
    toast() {},
  };
  context.globalThis = context;
  vm.runInNewContext(`
    var platformTransitionPattern = readTransitionPattern();
    var transitionPreferenceVersion = 0;
    var transitionPreferenceWriteTail = Promise.resolve();
    ${extractFunction("readTransitionPattern")}
    ${extractFunction("restoreTransitionPatternPreference")}
    ${extractFunction("persistTransitionPatternPreference")}
    ${extractFunction("syncTransitionModeButton")}
    ${extractFunction("toggleTransitionPattern")}
    globalThis.testApi = {
      restoreTransitionPatternPreference,
      toggleTransitionPattern,
      pattern() { return platformTransitionPattern; },
      settled() { return transitionPreferenceWriteTail; },
    };
  `, context);
  const api = context.testApi as {
    restoreTransitionPatternPreference(): Promise<void>;
    toggleTransitionPattern(): void;
    pattern(): string;
    settled(): Promise<void>;
  };

  const restoring = api.restoreTransitionPatternPreference();
  api.toggleTransitionPattern();
  resolveRestore({ platformTransitionPattern: "diagonal" });
  await restoring;
  await api.settled();

  assert.equal(api.pattern(), "ripple");
  assert.equal(stored.get("ncm-platform-transition-pattern-v1"), "ripple");
  assert.deepEqual(savedPatterns, ["ripple"]);
  assert.equal(label.textContent, "涟漪");
});
