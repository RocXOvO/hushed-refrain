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

test("QQ Live Task suppresses profile details for a WeChat identity", () => {
  let rendered: unknown;
  let hidden = 0;
  const context: Record<string, unknown> = {
    renderLiveTaskIdentity(value: unknown) { rendered = value; },
    hideLiveTaskIdentity() { hidden += 1; },
  };
  context.globalThis = context;
  vm.runInNewContext(`
    ${extractFunction("renderQQLiveIdentity")}
    globalThis.renderQQLiveIdentity = renderQQLiveIdentity;
  `, context);
  const renderQQLiveIdentity = context.renderQQLiveIdentity as (job: unknown) => void;

  renderQQLiveIdentity({
    id: "synthetic-job",
    targetLabel: "微信用户",
    targetIdentity: {
      kind: "wechat-user",
      label: "微信用户",
      nickname: "must-not-render",
      avatarUrl: "https://thirdqq.qlogo.cn/must-not-render",
    },
  });

  assert.equal(hidden, 0);
  const identity = rendered as Record<string, unknown>;
  assert.equal(identity.nickname, "微信用户");
  assert.equal(identity.meta, "微信用户");
  assert.equal(identity.platform, "qq");
  assert.equal("avatarUrl" in identity, false);
});

test("QQ preflight renders a public nickname and trusted avatar while keeping WeChat local", () => {
  const context: Record<string, unknown> = {
    fmt(value: unknown) { return String(value); },
    trustedAvatarUrl(value: unknown) {
      return String(value || "").startsWith("https://q1.qlogo.cn/") ? String(value) : undefined;
    },
  };
  context.globalThis = context;
  vm.runInNewContext(`
    ${extractFunction("qqProbeRouteLabel")}
    ${extractFunction("renderQQUserProbe")}
    globalThis.renderQQUserProbe = renderQQUserProbe;
  `, context);
  const render = context.renderQQUserProbe as (probe: unknown, result: unknown) => void;
  const probe = {
    preview: { hidden: true },
    avatar: { src: "/icons/user-round.svg" },
    nickname: { textContent: "-" },
    meta: { textContent: "-" },
  };

  render(probe, {
    identity: {
      kind: "qq-number",
      label: "QQ 123456789",
      nickname: "synthetic-user",
      avatarUrl: "https://q1.qlogo.cn/g?b=qq&nk=123456789&s=100",
    },
    route: "direct",
    routeName: "本机直连",
    routeAttempts: 1,
    elapsedMs: 8,
  });
  assert.equal(probe.preview.hidden, false);
  assert.equal(probe.nickname.textContent, "synthetic-user");
  assert.equal(probe.avatar.src, "https://q1.qlogo.cn/g?b=qq&nk=123456789&s=100");
  assert.match(probe.meta.textContent, /QQ 123456789.*本机直连.*8ms/);

  render(probe, {
    identity: { kind: "wechat-user", label: "微信用户", nickname: "must-not-render" },
    route: "local",
    routeName: "本地识别",
    routeAttempts: 0,
    elapsedMs: 0,
  });
  assert.equal(probe.nickname.textContent, "微信用户");
  assert.equal(probe.avatar.src, "/icons/user-round.svg");
  assert.equal(probe.meta.textContent, "微信用户 · 本地识别");
});

test("task startup capsule advances phases and settles without an elapsed-time surface", () => {
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const classes = new Set<string>();
  const stage = { textContent: "" };
  const progress = {
    hidden: true,
    classList: {
      add(name: string) { classes.add(name); },
      remove(...names: string[]) { for (const name of names) classes.delete(name); },
      contains(name: string) { return classes.has(name); },
    },
  };
  const context: Record<string, unknown> = {
    el: { taskStartupProgress: progress, taskStartupStage: stage },
    taskStartupProgressVersion: 0,
    taskStartupPhaseTimers: [],
    taskStartupHideTimer: undefined,
    setTimeout(callback: () => void) {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id: number | undefined) { if (id) timers.delete(id); },
  };
  context.globalThis = context;
  vm.runInNewContext(`
    ${extractFunction("clearTaskStartupTimers")}
    ${extractFunction("beginTaskStartup")}
    ${extractFunction("finishTaskStartup")}
    globalThis.api = { beginTaskStartup, finishTaskStartup };
  `, context);
  const api = context.api as {
    beginTaskStartup(phases: string[]): void;
    finishTaskStartup(success: boolean, message: string): void;
  };

  api.beginTaskStartup(["提交任务", "解析目标", "创建通道"]);
  assert.equal(progress.hidden, false);
  assert.equal(stage.textContent, "提交任务");
  timers.get(1)?.();
  assert.equal(stage.textContent, "解析目标");

  api.finishTaskStartup(true, "任务已启动");
  assert.equal(stage.textContent, "任务已启动");
  assert.equal(classes.has("is-complete"), true);
  const hide = [...timers.values()].at(-1);
  hide?.();
  assert.equal(progress.hidden, true);
  assert.equal(appSource.includes("taskStartupElapsed"), false);
});

test("task completion waits for the startup capsule to leave before opening settlement", () => {
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const classes = new Set<string>();
  const rendered: string[] = [];
  const context: Record<string, unknown> = {
    el: {
      taskStartupProgress: {
        hidden: true,
        classList: {
          add(name: string) { classes.add(name); },
          remove(...names: string[]) { for (const name of names) classes.delete(name); },
          contains(name: string) { return classes.has(name); },
        },
      },
      taskStartupStage: { textContent: "" },
    },
    taskStartupProgressVersion: 0,
    taskStartupPhaseTimers: [],
    taskStartupHideTimer: undefined,
    pendingStartupSettlement: undefined,
    settlementPending: { "netease:parallel": "job-1" },
    setTimeout(callback: () => void) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id: number | undefined) { if (id) timers.delete(id); },
    renderSettlement(_job: unknown, viewKey: string) { rendered.push(viewKey); },
  };
  context.globalThis = context;
  vm.runInNewContext(`
    ${extractFunction("clearTaskStartupTimers")}
    ${extractFunction("beginTaskStartup")}
    ${extractFunction("finishTaskStartup")}
    ${extractFunction("observeTaskSettlement")}
    globalThis.api = { beginTaskStartup, finishTaskStartup, observeTaskSettlement };
  `, context);
  const api = context.api as {
    beginTaskStartup(phases: string[]): void;
    finishTaskStartup(success: boolean, message: string): void;
    observeTaskSettlement(job: { id: string; status: string }, viewKey: string): void;
  };

  api.beginTaskStartup(["提交", "准备", "启动"]);
  api.observeTaskSettlement({ id: "job-1", status: "complete" }, "netease:parallel");
  assert.deepEqual(rendered, []);
  api.finishTaskStartup(true, "已启动");
  const hide = [...timers.entries()].at(-1);
  assert.ok(hide);
  timers.delete(hide![0]);
  hide![1]();
  assert.deepEqual(rendered, [], "settlement keeps a short visual gap after the capsule");
  const followup = [...timers.entries()].at(-1);
  assert.ok(followup);
  followup![1]();
  assert.deepEqual(rendered, ["netease:parallel"]);
});

test("NetEase user probe is single-flight, cached for a minute, and bounded", async () => {
  let calls = 0;
  let resolveFirst = (_value: unknown): void => {};
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const cache = new Map();
  const context: Record<string, unknown> = {
    Date,
    encodeURIComponent,
    neteaseUserProbeCache: cache,
    NETEASE_USER_PROBE_CACHE_LIMIT: 24,
    NETEASE_USER_PROBE_CACHE_TTL_MS: 60_000,
    api: async () => {
      calls += 1;
      return calls === 1 ? first : { profile: { userId: String(calls) } };
    },
  };
  context.globalThis = context;
  vm.runInNewContext(`${extractFunction("loadNeteaseUserProbe")} globalThis.load = loadNeteaseUserProbe;`, context);
  const load = context.load as (uid: string) => Promise<unknown>;

  const pendingA = load("42");
  const pendingB = load("42");
  assert.equal(calls, 1);
  resolveFirst({ profile: { userId: "42" } });
  assert.deepEqual(await pendingA, await pendingB);
  await load("42");
  assert.equal(calls, 1);
  (cache.get("42") as { expiresAt: number }).expiresAt = 0;
  await load("42");
  assert.equal(calls, 2);
  for (let uid = 100; uid < 130; uid += 1) await load(String(uid));
  assert.equal(cache.size, 24);
  assert.equal(cache.has("42"), false, "old previews are evicted when the cache reaches its bound");
});

test("source preview distinguishes privacy from cooldown and generic restrictions", () => {
  const target = { className: "", textContent: "" };
  const context: Record<string, unknown> = { fmt: (value: number) => String(value) };
  context.globalThis = context;
  vm.runInNewContext(`${extractFunction("probe")} globalThis.renderProbe = probe;`, context);
  const render = context.renderProbe as (target: typeof target, label: string, value: unknown) => void;

  render(target, "喜欢歌曲", { status: "private" });
  assert.equal(target.className, "private");
  assert.equal(target.textContent, "喜欢歌曲 已开启隐私");
  render(target, "喜欢歌曲", { status: "restricted" });
  assert.equal(target.textContent, "喜欢歌曲 查询受限");
});

test("ordinary song search is single-flight, cached for a minute, and bounded", async () => {
  let apiCalls = 0;
  let completeFirst = (_value: unknown): void => {};
  const firstResponse = new Promise((resolve) => { completeFirst = resolve; });
  const rendered: unknown[] = [];
  const search = {
    platform: "netease",
    query: {
      value: "search song",
      setCustomValidity() {},
      reportValidity() {},
    },
    id: { value: "" },
    preview: { textContent: "", hidden: true },
    button: { disabled: false },
    controller: undefined,
    pendingQuery: "",
    generation: 0,
    cache: new Map(),
  };
  const context: Record<string, unknown> = {
    AbortController,
    URLSearchParams,
    Date,
    search,
    qqLookupControllers: new Set(),
    qqLookupBusy: false,
    async api() {
      apiCalls += 1;
      if (apiCalls === 1) return firstResponse;
      return { songs: [{ id: String(apiCalls), name: "Song", artists: [] }] };
    },
    renderSongResults(_search: unknown, songs: unknown) { rendered.push(songs); },
    renderSongSearchStatus() {},
    clearSongResults() {},
    songLabel() { return "Song"; },
    syncTaskStartAvailability() {},
    toast() {},
  };
  context.globalThis = context;
  vm.runInNewContext(`
    ${extractFunction("songSearchParams")}
    ${extractFunction("runSongSearch")}
    globalThis.runSongSearch = runSongSearch;
  `, context);
  const run = context.runSongSearch as (search: unknown) => Promise<void>;

  const first = run(search);
  await Promise.resolve();
  await run(search);
  assert.equal(apiCalls, 1, "the same pending query shares one request");
  completeFirst({ songs: [{ id: "7", name: "First", artists: [] }] });
  await first;
  await run(search);
  assert.equal(apiCalls, 1, "the fresh cached query does not hit the network");

  const cached = search.cache.get("search song") as { expiresAt: number };
  cached.expiresAt = 0;
  await run(search);
  assert.equal(apiCalls, 2, "an expired entry is fetched again");

  for (let index = 0; index < 25; index += 1) {
    search.query.value = `query ${index}`;
    await run(search);
  }
  assert.equal(search.cache.size, 24);
  assert.equal(rendered.length > 0, true);
});

test("stop always targets the globally active manager and releases cross-platform start state", async () => {
  const requests: string[] = [];
  const notices: string[] = [];
  let refreshes = 0;
  let availabilitySyncs = 0;
  const attributes = new Set<string>();
  const context: Record<string, unknown> = {
    TASK_VIEWS: {
      "netease:parallel": { label: "网易云单曲并行" },
      "qq:song": { label: "QQ 音乐单曲" },
    },
    activeTaskMode: "qq",
    activeTaskViewKey: "qq:song",
    taskViewKey: () => "netease:parallel",
    el: {
      stop: {
        disabled: false,
        setAttribute(name: string) { attributes.add(name); },
        removeAttribute(name: string) { attributes.delete(name); },
      },
    },
    async api(path: string) {
      requests.push(path);
      return path === "/api/tasks/stop"
        ? { active: true, mode: "qq" }
        : { active: false };
    },
    setTimeout(callback: () => void) { callback(); return 1; },
    syncTaskStartAvailability() { availabilitySyncs += 1; },
    toast(value: string) { notices.push(value); },
    async refresh() { refreshes += 1; },
  };
  context.globalThis = context;
  vm.runInNewContext(`
    ${extractFunction("stopJob")}
    globalThis.stopJob = stopJob;
    globalThis.readState = () => ({ activeTaskMode, activeTaskViewKey, disabled: el.stop.disabled });
  `, context);

  await (context.stopJob as () => Promise<void>)();
  assert.deepEqual(requests, ["/api/tasks/stop", "/api/tasks/active"]);
  assert.equal(refreshes, 1);
  assert.equal(availabilitySyncs >= 3, true);
  assert.match(notices.at(-1) || "", /QQ 音乐单曲/);
  const state = (context.readState as () => Record<string, unknown>)();
  assert.equal(state.activeTaskMode, undefined);
  assert.equal(state.activeTaskViewKey, undefined);
  assert.equal(state.disabled, true);
  assert.equal(attributes.has("aria-busy"), false);
});
