import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { RunCancelled } from "../src/errors";
import { encodeClassicEncryptUin } from "../src/qq-music/classic-encrypt-uin";
import {
  isLoopbackAddress,
  NcmSongSearchRouter,
  normalizeResumeTaskForClient,
  sourceTaskPaths,
  startDashboard,
  UserProbeRouter,
  validateClashConfigSelection,
  type UserProbe,
} from "../src/server";
import type { ProxyPoolFile } from "../src/mihomo-pool";
import type {
  QQMusicPlatformClient,
  QQMusicScanOptions,
  QQMusicScanReport,
} from "../src/qq-music/types";

test("NetEase song-search router rotates verified pool exits", async () => {
  const entries = ["lane-a", "lane-b"].map((name, index) => ({
    name,
    endpoint: `http://127.0.0.1:${18080 + index}`,
    egressIp: index === 0 ? "192.0.2.10" : "198.51.100.10",
    latencyMs: 10,
    ncmLatencyMs: 10,
    ncmVerified: true,
  }));
  const proxies: Array<string | undefined> = [];
  const router = new NcmSongSearchRouter("unused", {
    readPool: async () => ({
      version: 1,
      generatedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
      source: "external",
      active: true,
      entries,
    }),
    search: async (query, _limit, proxy) => {
      proxies.push(proxy);
      return [{ id: "7", name: query, artists: [] }];
    },
  });

  assert.equal((await router.run("first query", 5)).platform, "netease");
  assert.equal((await router.run("second query", 5)).songs[0].name, "second query");
  assert.deepEqual(proxies, entries.map((entry) => entry.endpoint));
});

test("NetEase song-search router never falls back to direct while its pool is running", async () => {
  const entries = ["lane-a", "lane-b"].map((name, index) => ({
    name,
    endpoint: `http://127.0.0.1:${18080 + index}`,
    egressIp: index === 0 ? "192.0.2.10" : "198.51.100.10",
    latencyMs: 10,
    ncmLatencyMs: 10,
    ncmVerified: true,
  }));
  const proxies: Array<string | undefined> = [];
  const router = new NcmSongSearchRouter("unused", {
    readPool: async () => ({
      version: 1,
      generatedAt: new Date().toISOString(),
      source: "external",
      active: true,
      entries,
    }),
    search: async (_query, _limit, proxy) => {
      proxies.push(proxy);
      throw new TypeError("proxy unavailable");
    },
  });

  await assert.rejects(
    router.run("search query", 10),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 502);
      assert.match((error as Error).message, /不会回退到本机直连/);
      return true;
    },
  );
  assert.deepEqual(proxies, entries.map((entry) => entry.endpoint));
  assert.equal(proxies.includes(undefined), false);
});

test("NetEase numeric song lookup rotates to a healthy managed-pool exit", async () => {
  const entries = [
    { name: "lane-a", endpoint: "http://127.0.0.1:18080", egressIp: "192.0.2.10", latencyMs: 10, ncmLatencyMs: 10, ncmVerified: true },
    { name: "lane-b", endpoint: "http://127.0.0.1:18081", egressIp: "198.51.100.10", latencyMs: 10, ncmLatencyMs: 10, ncmVerified: true },
  ];
  const proxies: Array<string | undefined> = [];
  const router = new NcmSongSearchRouter("unused", {
    readPool: async () => ({
      version: 1,
      generatedAt: new Date().toISOString(),
      source: "external",
      active: true,
      entries,
    }),
    lookup: async (songId, proxy) => {
      proxies.push(proxy);
      if (proxy === entries[0].endpoint) throw new TypeError("first proxy failed");
      return { id: songId, name: "Song", artists: ["Artist"] };
    },
  });

  assert.deepEqual(await router.lookup("7"), { id: "7", name: "Song", artists: ["Artist"] });
  assert.deepEqual(proxies, entries.map((entry) => entry.endpoint));
  assert.equal(proxies.includes(undefined), false);
});

test("NetEase numeric song lookup fails closed when a running pool cannot be reverified", async () => {
  let lookupCalls = 0;
  const router = new NcmSongSearchRouter("unused", {
    readPool: async () => ({
      version: 1,
      generatedAt: "2000-01-01T00:00:00.000Z",
      source: "external",
      active: true,
      entries: [{
        name: "stale-lane",
        endpoint: "http://127.0.0.1:18080",
        egressIp: "192.0.2.10",
        latencyMs: 10,
        ncmLatencyMs: 10,
        ncmVerified: false,
      }],
    }),
    verifyPool: async () => { throw new Error("verification failed"); },
    lookup: async (songId) => {
      lookupCalls += 1;
      return { id: songId };
    },
  });

  await assert.rejects(
    router.lookup("7"),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.match((error as Error).message, /不会回退到本机直连/);
      return true;
    },
  );
  assert.equal(lookupCalls, 0);
});

test("dashboard exposes bounded, platform-neutral song-search routes", async (context) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "ncm-dashboard-song-search-"));
  const neteaseCalls: Array<{ query: string; limit: number; proxy?: string }> = [];
  const lookupCalls: string[] = [];
  const classicIdentifier = "123456789012";
  const classicEncryptUin = encodeClassicEncryptUin(classicIdentifier);
  const wechatInternalId = "1150000000000000472";
  const wechatEncryptUin = "oK6koenzoenzoenzoenzoevloc**";
  let publicProfileCalls = 0;
  const client: QQMusicPlatformClient = {
    searchSongs: async (query, limit) => [{
      id: "900719925474099312345",
      mid: "qq-mid",
      name: query,
      artists: [String(limit)],
    }],
    resolveUser: async (input) => ({
      input,
      encryptUin: input === classicIdentifier
        ? encodeClassicEncryptUin(input)
        : "canonical-user",
    }),
    getPublicUserProfile: async (input) => {
      publicProfileCalls += 1;
      const isWechat = input === wechatInternalId || input === wechatEncryptUin;
      return {
        input,
        encryptUin: isWechat ? wechatEncryptUin : classicEncryptUin,
        nickname: isWechat ? "synthetic-wechat-profile" : "synthetic-qq-profile",
        avatarUrl: isWechat
          ? "https://example.invalid/wechat-avatar"
          : "https://example.invalid/qq-avatar",
      };
    },
    getSongInfo: async (songId) => ({ id: songId, name: "song" }),
    getLikedSongsPage: async () => ({ songs: [], hasMore: false, nextOffset: 0 }),
    getNewComments: async () => ({ comments: [], hasMore: false }),
  };
  const server = await startDashboard({
    host: "127.0.0.1",
    port: 0,
    runtimeRoot,
    qqClientFactory: () => client,
    songSearchRouter: {
      readPool: async () => undefined,
      search: async (query, limit, proxy) => {
        neteaseCalls.push({ query, limit, ...(proxy ? { proxy } : {}) });
        return [{ id: "7", name: query, artists: ["Artist"] }];
      },
      lookup: async (songId) => {
        lookupCalls.push(songId);
        return { id: songId, name: "Numeric Song", artists: ["Artist"] };
      },
    },
  });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const netease = await fetch(`${base}/api/song/search?q=${encodeURIComponent("  搜索歌曲  ")}&limit=4`);
  assert.equal(netease.status, 200);
  assert.deepEqual(await netease.json(), {
    platform: "netease",
    query: "搜索歌曲",
    songs: [{ id: "7", name: "搜索歌曲", artists: ["Artist"] }],
  });
  assert.deepEqual(neteaseCalls, [{ query: "搜索歌曲", limit: 4 }]);

  const numericLookup = await fetch(`${base}/api/song?id=7`);
  assert.equal(numericLookup.status, 200);
  assert.deepEqual(await numericLookup.json(), { id: "7", name: "Numeric Song", artists: ["Artist"] });
  assert.deepEqual(lookupCalls, ["7"]);

  const qq = await fetch(`${base}/api/qq/song/search?q=${encodeURIComponent("QQ 搜索")}&limit=3&allowDirect=1`);
  assert.equal(qq.status, 200);
  assert.deepEqual(await qq.json(), {
    platform: "qq",
    query: "QQ 搜索",
    songs: [{
      id: "900719925474099312345",
      mid: "qq-mid",
      name: "QQ 搜索",
      artists: ["3"],
    }],
  });

  const decoded = await fetch(`${base}/api/qq/encrypt-uin/decode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encryptUin: classicEncryptUin }),
  });
  assert.equal(decoded.status, 200);
  assert.deepEqual(await decoded.json(), {
    inputKind: "raw-encrypt-uin",
    resolution: "local",
    format: "classic-qq-short",
    identityKind: "qq-number-candidate",
    encryptUin: classicEncryptUin,
    identifier: classicIdentifier,
    maskedIdentifier: "12****12",
  });

  const decodedWechat = await fetch(`${base}/api/qq/encrypt-uin/decode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encryptUin: wechatEncryptUin }),
  });
  assert.equal(decodedWechat.status, 200);
  assert.deepEqual(await decodedWechat.json(), {
    inputKind: "raw-encrypt-uin",
    resolution: "local",
    format: "wechat-28",
    identityKind: "wxuin-candidate",
    encryptUin: wechatEncryptUin,
    identifier: wechatInternalId,
    maskedIdentifier: "115***472",
  });
  assert.equal(publicProfileCalls, 0);

  const decodedProfileUrl = await fetch(`${base}/api/qq/encrypt-uin/decode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: `https://y.qq.com/n/ryqq_v2/profile?uin=${encodeURIComponent(classicEncryptUin)}`,
    }),
  });
  assert.equal(decodedProfileUrl.status, 200);
  assert.equal((await decodedProfileUrl.json() as { resolution: string }).resolution, "local");
  assert.equal(publicProfileCalls, 0);

  const resolvedNumericProfile = await fetch(`${base}/api/qq/encrypt-uin/decode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: wechatInternalId, allowDirect: true }),
  });
  assert.equal(resolvedNumericProfile.status, 200);
  assert.deepEqual(await resolvedNumericProfile.json(), {
    inputKind: "numeric-identifier",
    resolution: "network",
    format: "wechat-28",
    identityKind: "wxuin-candidate",
    encryptUin: wechatEncryptUin,
    identifier: wechatInternalId,
    maskedIdentifier: "115***472",
  });
  assert.equal(publicProfileCalls, 1);

  const verified = await fetch(`${base}/api/qq/encrypt-uin/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encryptUin: classicEncryptUin, allowDirect: true }),
  });
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), {
    format: "classic-qq-short",
    identityKind: "qq-number-candidate",
    status: "match",
    maskedIdentifier: "12****12",
    checks: { encryptUin: true, nickname: true, avatar: true },
  });

  const verifiedWechat = await fetch(`${base}/api/qq/encrypt-uin/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encryptUin: wechatEncryptUin, allowDirect: true }),
  });
  assert.equal(verifiedWechat.status, 200);
  assert.deepEqual(await verifiedWechat.json(), {
    format: "wechat-28",
    identityKind: "wxuin-candidate",
    status: "match",
    maskedIdentifier: "115***472",
    checks: { encryptUin: true, nickname: true, avatar: true },
  });

  const invalidClassic = await fetch(`${base}/api/qq/encrypt-uin/decode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encryptUin: "n".repeat(32) }),
  });
  assert.equal(invalidClassic.status, 400);
  const invalidClassicBody = await invalidClassic.json() as { code: string; error: string };
  assert.equal(invalidClassicBody.code, "unsupported-format");
  assert.match(invalidClassicBody.error, /不支持此格式/);
  assert.doesNotMatch(invalidClassicBody.error, /n{8}/);

  const invalidProfileUrl = await fetch(`${base}/api/qq/encrypt-uin/decode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "https://example.invalid/n/ryqq/profile/123456" }),
  });
  assert.equal(invalidProfileUrl.status, 400);
  const invalidProfileBody = await invalidProfileUrl.json() as { code: string; error: string };
  assert.equal(invalidProfileBody.code, "invalid-profile-url");
  assert.doesNotMatch(invalidProfileBody.error, /example\.invalid|123456/);

  for (const invalidBody of [null, []]) {
    const invalidObject = await fetch(`${base}/api/qq/encrypt-uin/decode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(invalidBody),
    });
    assert.equal(invalidObject.status, 400);
    assert.match(await invalidObject.text(), /必须是 JSON 对象/);
  }
  const conflictingDecode = await fetch(`${base}/api/qq/encrypt-uin/decode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: classicEncryptUin, encryptUin: wechatEncryptUin }),
  });
  assert.equal(conflictingDecode.status, 400);
  assert.match(await conflictingDecode.text(), /不能同时包含 input 和 encryptUin/);

  const invalidVerifyBody = await fetch(`${base}/api/qq/encrypt-uin/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "null",
  });
  assert.equal(invalidVerifyBody.status, 400);
  assert.match(await invalidVerifyBody.text(), /必须是 JSON 对象/);

  assert.equal((await fetch(`${base}/api/song/search?q=x`)).status, 400);
  assert.equal((await fetch(`${base}/api/song/search?q=valid&limit=11`)).status, 400);
  assert.equal((await fetch(`${base}/api/qq/song/search?q=valid&limit=1`)).status, 409);
  const unsafeVerify = await fetch(`${base}/api/qq/encrypt-uin/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encryptUin: classicEncryptUin }),
  });
  assert.equal(unsafeVerify.status, 409);
  assert.match(await unsafeVerify.text(), /不会回退到本机直连|未检测到可用代理/);
});

test("aborting an HTTP QQ song search releases the lookup lease for the next query", async (context) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "ncm-dashboard-qq-search-abort-"));
  let firstStarted = (): void => {};
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const client: QQMusicPlatformClient = {
    searchSongs: async (query, _limit, signal) => {
      if (query !== "first query") return [{ id: "8", name: query, artists: ["Artist"] }];
      firstStarted();
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) return reject(new RunCancelled());
        signal?.addEventListener("abort", () => reject(new RunCancelled()), { once: true });
      });
    },
    resolveUser: async (input) => ({ input, encryptUin: "canonical-user" }),
    getSongInfo: async (songId) => ({ id: songId, name: "song" }),
    getLikedSongsPage: async () => ({ songs: [], hasMore: false, nextOffset: 0 }),
    getNewComments: async () => ({ comments: [], hasMore: false }),
  };
  const server = await startDashboard({
    host: "127.0.0.1",
    port: 0,
    runtimeRoot,
    qqClientFactory: () => client,
  });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const controller = new AbortController();
  const first = fetch(`${base}/api/qq/song/search?q=first%20query&allowDirect=1`, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(first, (error: unknown) => (error as { name?: string }).name === "AbortError");

  const second = await fetch(`${base}/api/qq/song/search?q=second%20query&allowDirect=1`);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), {
    platform: "qq",
    query: "second query",
    songs: [{ id: "8", name: "second query", artists: ["Artist"] }],
  });
});

test("uses target-v3 per-source checkpoints with one canonical UID result and coverage ledger", () => {
  const record = sourceTaskPaths("/data", "42", "record");
  assert.match(record.statePath, /web-state-42-record-target-v3\.json$/);
  assert.match(record.outputPath, /web-comments-42-target-v3\.jsonl$/);
  assert.match(record.coveragePath, /web-song-coverage-42-target-v3\.json$/);
  const likes = sourceTaskPaths("/data", "42", "likes");
  const both = sourceTaskPaths("/data", "42", "both");
  assert.match(likes.statePath, /web-state-42-likes-target-v3\.json$/);
  assert.match(both.statePath, /web-state-42-both-target-v3\.json$/);
  assert.equal(likes.outputPath, record.outputPath);
  assert.equal(both.outputPath, record.outputPath);
  assert.equal(likes.coveragePath, record.coveragePath);
  assert.doesNotMatch(record.statePath, /web-state-42-record\.json$/);
  assert.doesNotMatch(likes.outputPath, /target-v2/);
});

test("dashboard serves UI assets and estimate API", async (context) => {
  const server = await startDashboard({ host: "127.0.0.1", port: 0 });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const pageText = await page.text();
  assert.match(pageText, /乐评寻踪/);
  assert.match(pageText, /MUSIC COMMENT TRACE/);
  assert.match(pageText, /NETEASE WORKSPACE/);
  assert.match(pageText, /id="primaryNavigation"/);
  assert.match(pageText, /id="taskSidebar"/);
  assert.match(pageText, /id="runtimeInspector"/);
  assert.match(pageText, /id="toolbarStartButton"/);
  assert.match(pageText, /持续扫描并实时输出/);
  assert.match(pageText, /updateProgress/);
  assert.match(pageText, /重启并安装|下载更新/);
  assert.match(pageText, /如何获取用户 UID/);
  assert.match(pageText, /home\?id=123456789/);
  assert.match(pageText, /id="settlementDialog"/);
  assert.match(pageText, /本轮耗时/);
  assert.match(pageText, /累计命中/);
  assert.match(pageText, /id="runtimeTimer"/);
  assert.match(pageText, /id="globalProgressContext"/);
  assert.match(pageText, /id="taskPanelOpenButton"/);
  assert.match(pageText, /id="taskExitLimit"[^>]*min="0"[^>]*max="32"/);
  assert.match(pageText, /id="taskHostConcurrency"[^>]*min="1"[^>]*max="32"[^>]*value="8"/);
  assert.match(pageText, /data-nav-view="activity"/);
  assert.match(pageText, /id="activityPanel"/);
  assert.match(pageText, /id="activeSongCount"/);
  assert.match(pageText, /id="activeWorkerCount"/);
  assert.match(pageText, /id="activeSongsList"/);
  assert.match(pageText, /id="exportResultsButton"/);
  assert.match(pageText, /id="runtimeInspectorBody"/);
  assert.match(pageText, /PDF 将包含截至导出时已经保存的全部结果/);
  assert.match(pageText, /评论读取进度/);
  assert.match(pageText, /总工作线程上限限制任务整体调度/);
  assert.match(pageText, /任务出口上限/);
  assert.match(pageText, /每出口请求启动间隔/);
  assert.match(pageText, /请求上限（0不限）/);
  assert.match(pageText, /styles\.css\?v=49/);
  assert.match(pageText, /platform-wave\.js\?v=5/);
  assert.match(pageText, /app\.js\?v=61/);
  assert.match(pageText, /id="loginButton"[^>]+aria-label="二维码登录"/);
  assert.match(pageText, /id="globalPlatformSwitch"[^>]*role="tablist"/);
  assert.match(pageText, /data-platform-target="netease"[^>]*aria-controls="neteaseWorkbench"/);
  assert.match(pageText, /data-platform-target="qq"[^>]*aria-controls="qqWorkbench"/);
  assert.match(pageText, /id="neteaseWorkbench"[^>]*data-workbench="netease"/);
  assert.match(pageText, /id="qqWorkbench"[^>]*data-workbench="qq"[^>]*hidden[^>]*inert/);
  assert.match(pageText, /id="neteaseModeSwitch"[^>]*role="radiogroup"/);
  assert.match(pageText, /name="neteaseMode"[^>]*value="parallel"/);
  assert.match(pageText, /id="qqModeSwitch"[^>]*role="radiogroup"/);
  assert.match(pageText, /name="qqMode"[^>]*value="song"/);
  assert.ok(pageText.indexOf('id="globalPlatformSwitch"') < pageText.indexOf('id="taskSidebar"'));
  assert.doesNotMatch(pageText, /id="platformSwitch"/);
  assert.match(pageText, /id="qqSongForm"/);
  assert.match(pageText, /id="qqLikesForm"/);
  const qqLikesMarkup = pageText.match(/<form id="qqLikesForm"[\s\S]*?<\/form>/)?.[0] ?? "";
  assert.doesNotMatch(qqLikesMarkup, /name="workersPerProxy"/);
  assert.match(qqLikesMarkup, /实际 Worker 由顶部“总工作线程上限”统一控制/);
  assert.match(pageText, /data-open-classic-encrypt-uin/);
  assert.match(pageText, /id="classicEncryptUinDialog"/);
  assert.match(pageText, /先判断输入类型/);
  assert.match(pageText, /EncryptUin \/ QQ音乐个人主页链接 \/ 数字标识/);
  assert.match(pageText, /32 位新式 ID/);
  assert.match(pageText, /完整候选标识属于个人标识符/);
  assert.match(pageText, /代理池或显式代理存在时请求 fail-closed/);
  assert.match(pageText, /显示完整标识/);
  assert.match(pageText, /复制完整标识/);
  assert.match(pageText, /不会批量导入、枚举或反查/);
  assert.match(pageText, /name="pageSize"[^>]*max="25"[^>]*value="25"/);
  assert.match(pageText, /name="likedPageSize"[^>]*max="500"[^>]*value="500"/);
  assert.match(pageText, /任务聚合发车间隔默认为 50ms/);
  assert.match(pageText, /id="neteaseSongQuery"/);
  assert.match(pageText, /id="neteaseSongResults"[^>]*role="listbox"/);
  assert.match(pageText, /id="qqSongQuery"/);
  assert.match(pageText, /id="qqSongResults"[^>]*role="listbox"/);
  assert.match(pageText, /id="parameterHelpDialog"/);
  assert.match(pageText, /data-help-key="total-workers"/);
  assert.match(pageText, /id="runtimeInspectorBody"[^>]*inert[^>]*aria-hidden="true"/);
  assert.match(pageText, /id="settlementFootnote"/);
  assert.match(pageText, /id="settlementCoverage"/);
  assert.match(pageText, /id="speedMetric"/);
  assert.match(pageText, /id="poolStateIndicator"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(pageText, /class="pool-source-switch segmented two"[^>]*role="radiogroup"[^>]*aria-label="代理池来源"/);
  assert.doesNotMatch(pageText, /id="songProgressBar"/);
  assert.match(pageText, /主机保护/);
  assert.match(pageText, /允许本机直连/);
  assert.match(pageText, /id="logsPanel"/);
  assert.match(pageText, /IPv4 \/24.*IPv6 \/48/);
  assert.match(pageText, /id="poolSize"[^>]*max="32"[^>]*value="8"/);
  assert.match(pageText, /id="poolCandidates"[^>]*max="128"[^>]*value="48"/);
  assert.match(pageText, /id="clashConfigSelectAllButton"/);
  assert.match(pageText, /name="pageSize"[^>]*max="2000"[^>]*value="1000"/);
  assert.doesNotMatch(pageText, /首条命中后/);

  const app = await fetch(`${base}/app.js`);
  assert.equal(app.status, 200);
  const appText = await app.text();
  assert.match(appText, /year:\s*"numeric"/);
  assert.match(appText, /clockDuration/);
  assert.match(appText, /renderRuntimeTimer/);
  assert.match(appText, /proxyTransportMaxConcurrent/);
  assert.match(appText, /observeTaskSettlement/);
  assert.match(appText, /new URLSearchParams\(\{ mode: view\.taskMode/);
  assert.match(appText, /prepareTaskForUpdate/);
  assert.match(appText, /\/api\/resume/);
  assert.match(appText, /保存进度并重启/);
  assert.match(appText, /if \(refreshInFlight\) return refreshInFlight/);
  assert.match(appText, /scheduleResultsRender/);
  assert.match(appText, /Date\.now\(\) - lastLogsRefreshAt < 3_000/);
  assert.match(appText, /poolStatus === "starting"/);
  assert.match(appText, /syncTaskStartAvailability/);
  assert.match(appText, /startSubmissionBusy \|\| qqLookupBusy \|\| Boolean\(activeTaskMode\)/);
  assert.match(appText, /activateNavigation/);
  assert.match(appText, /syncToolbarContext/);
  assert.match(appText, /"QQ 目标已填写"/);
  assert.match(appText, /job\?\.targetLabel/);
  assert.doesNotMatch(appText, /`QQ \$\{target\}`/);
  assert.match(appText, /visibleResultOrder/);
  assert.match(appText, /resultGenerations/);
  assert.match(appText, /"qq:song"/);
  assert.match(appText, /"qq:likes"/);
  assert.match(appText, /job\.configuredLanes/);
  assert.doesNotMatch(appText, /job\.requestedTarget/);
  assert.doesNotMatch(appText, /job\.displayTarget/);
  assert.match(appText, /job\.targetLabel/);
  assert.match(appText, /taskBase\(taskMode\)/);
  assert.match(appText, /\/api\/tasks\/prepare-update/);
  assert.match(appText, /\/api\/tasks\/cancel-update/);
  assert.match(appText, /installState\?\.phase === "error"/);
  assert.match(appText, /next\?\.phase === "error"/);
  assert.match(appText, /代理池正在构建、导入或后台复测/);
  assert.match(appText, /QQ 检查点累计/);
  assert.doesNotMatch(appText, /有界工作线程/);
  assert.match(appText, /主机线程上限/);
  assert.match(appText, /可调度.*工作线程/);
  assert.match(appText, /Math\.ceil\(hostConcurrency \/ lanes\)/);
  assert.match(appText, /platform === "qq" \? hostConcurrency : Math\.min\(lanes \* workersPerLane, hostConcurrency\)/);
  assert.match(appText, /showNeteaseAuth = platform === "netease" && neteaseAuthCookiePresent/);
  assert.match(appText, /已保存网易云登录/);
  assert.match(appText, /baselineIds/);
  assert.match(appText, /tabSwitchVersion/);
  assert.match(appText, /renderActiveSongs/);
  assert.match(appText, /renderSongReadProgress/);
  assert.match(appText, /refreshActiveSongRequestAges/);
  assert.match(appText, /个分片请求中/);
  assert.match(appText, /inspectorOverlayQuery\.addEventListener\("change"/);
  assert.match(appText, /addEventListener\("pageshow", \(event\) => \{[\s\S]*event\.persisted[\s\S]*pageLifecycleSuspended = false/);
  assert.match(appText, /pageLifecycleSuspended = false[\s\S]*startRuntimeTimer\(\)[\s\S]*scheduleRefreshLoop\(0\)[\s\S]*scheduleAuthRefreshLoop\(0\)[\s\S]*connectResultStream\(\)/);
  assert.match(appText, /function scheduleRefreshLoop[\s\S]*if \(pageLifecycleSuspended\) return/);
  assert.match(appText, /时间覆盖/);
  assert.match(appText, /topologyCapacityNote/);
  assert.match(appText, /工作线程活跃/);
  assert.match(appText, /formatRate\(job\.commentsPerSecond\)/);
  assert.match(appText, /proxyTransportEffectiveConcurrent/);
  assert.match(appText, /poolRefreshing/);
  assert.match(appText, /状态灯变绿/);
  assert.match(appText, /maxProxyLanes/);
  assert.match(appText, /value\.hostConcurrency = Number\(el\.hostConcurrency\.value\)/);
  assert.match(appText, /requested > 0 \? requested : poolLaneCount/);
  assert.match(appText, /observedCommentsPerPage/);
  assert.match(appText, /pageRequestAttempts/);
  assert.match(appText, /proxyTransportEffectiveStartDelayMs/);
  assert.match(appText, /result\.route === "managed-pool"/);
  assert.match(appText, /任务产生 3 次页面请求后自动校准/);
  assert.match(appText, /exportResultsPdf/);
  assert.match(appText, /inspectorBody\.inert/);
  assert.match(appText, /\/api\/song\/search/);
  assert.match(appText, /\/api\/qq\/song\/search/);
  assert.match(appText, /\/api\/qq\/encrypt-uin\/decode/);
  assert.match(appText, /\/api\/qq\/encrypt-uin\/verify/);
  assert.match(appText, /"QQ号候选"/);
  assert.match(appText, /"QQ音乐微信内部ID（wxuin候选）"/);
  assert.match(appText, /不是微信号，也不能公开转换为微信号/);
  assert.match(appText, /decoded\.identifier/);
  assert.match(appText, /decoded\.maskedIdentifier/);
  assert.doesNotMatch(appText, /decoded\.qq|decoded\.maskedQq|classicMaskedQq/);
  assert.match(appText, /navigator\.clipboard\.writeText/);
  assert.match(appText, /qqLookupControllers\.add\(controller\)/);
  assert.match(appText, /classicVerificationController\?\.abort\(\)/);
  assert.match(appText, /window\.addEventListener\("pagehide", \(\) => \{[\s\S]*el\.classicInput\.value = "";[\s\S]*resetClassicDecodeState\(\)/);
  assert.match(appText, /if \(classicVerificationController === controller\) \{[\s\S]*classicVerify\.disabled = false/);
  assert.match(appText, /new AbortController\(\)/);
  assert.match(appText, /job\.commentsInspected/);
  assert.match(appText, /function createPlatformTransition/);
  assert.match(appText, /function commitPlatformSelection/);
  assert.match(appText, /function armPlatformScrollRestore/);
  assert.match(appText, /function restorePendingPlatformScroll/);
  assert.match(appText, /pending\.switchVersion !== platformSwitchVersion[\s\S]*pending\.targetPlatform !== platform[\s\S]*pending\.targetPlatform !== desiredPlatform/);
  assert.match(appText, /if \(items\.length\) restorePendingPlatformScroll\(\)/);
  assert.match(appText, /deferScrollRestore:\s*true/);
  assert.match(appText, /PlatformWaveTransition/);
  assert.match(appText, /platformSwitchVersion/);
  assert.match(appText, /selectedTabs/);
  assert.match(appText, /input\[name="neteaseMode"\], input\[name="qqMode"\]/);
  assert.match(appText, /data-platform-target/);
  assert.match(appText, /platform-switching/);
  assert.match(appText, /desiredPlatform/);
  assert.match(appText, /platformTransition\?\.cancel\(\)/);
  assert.match(appText, /cancelInterfaceMotions\(\)/);
  assert.match(appText, /function connectResultStream\(\) \{[\s\S]*if \(pageLifecycleSuspended\) return/);
  assert.match(appText, /#runtimeInspector/);
  assert.match(appText, /#globalPlatformSwitch/);
  assert.match(appText, /const expanded = details\.dataset\.expanded === "true";[\s\S]*details\.open = expanded/);
  assert.match(appText, /let commitRecovered = false;[\s\S]*commitPlatformSelection\(value, switchVersion, commitOptions\)[\s\S]*commitRecovered = true/);
  assert.match(appText, /let streamConnected = false;[\s\S]*streamConnected = commitPlatformSelection[\s\S]*if \(!streamConnected\) connectResultStream\(\)/);
  assert.match(appText, /direction,\s*sourceAnchor,\s*targetAnchor,\s*commit/s);
  assert.match(appText, /committed = commit\(\) === true/);
  assert.match(appText, /desiredPlatform !== platform[\s\S]*commitPlatformSelection\(desiredPlatform/);
  assert.doesNotMatch(appText, /motionLayers:/);
  assert.match(appText, /function cancelSongLookup/);
  assert.doesNotMatch(appText, /function cancelSongLookup[\s\S]*?qqLookupControllers\.delete[\s\S]*?function renderSongResults/);
  assert.match(appText, /modeSwitchVersion \+= 1/);
  assert.match(appText, /platform === ownerPlatform/);
  assert.match(appText, /function renderSelectedTaskSnapshot/);
  assert.match(appText, /resetVisibleLogs\(\);\s*renderSelectedTaskSnapshot\(\);\s*connectResultStream\(\)/);
  assert.match(appText, /function refreshSelectedTaskPresentation/);
  assert.match(appText, /!outcome\.committed \|\| platform !== value/);
  assert.match(appText, /panel\.setAttribute\("aria-hidden", String\(hidden\)\)/);
  assert.match(appText, /shouldCommit = \(\) => true/);
  assert.doesNotMatch(appText, /当前生效配置（合并）/);
  assert.doesNotMatch(appText, /resultTimestamp/);
  assert.doesNotMatch(appText, /setInterval\(\(\) => void refresh\(\), 1500\)/);

  const platformWave = await fetch(`${base}/platform-wave.js`);
  assert.equal(platformWave.status, 200);
  const platformWaveText = await platformWave.text();
  assert.match(platformWaveText, /getContext\("webgl2"/);
  assert.match(platformWaveText, /gl_VertexID/);
  assert.match(platformWaveText, /createVertexArray/);
  assert.match(platformWaveText, /gl\.drawArrays\(gl\.TRIANGLES, 0, 3\)/);
  assert.match(platformWaveText, /const DURATION_MS = 680/);
  assert.match(platformWaveText, /const COMMIT_MS = 326/);
  assert.match(platformWaveText, /const MAX_DPR = 1\.25/);
  assert.match(platformWaveText, /const MAX_COLOR_PIXELS = 1_600_000/);
  assert.match(platformWaveText, /fwidth/);
  assert.match(platformWaveText, /for \(int contourIndex = 0; contourIndex < 5/);
  assert.match(platformWaveText, /elapsedMs >= COVER_END[\s\S]*alpha = 1\.0/);
  assert.doesNotMatch(platformWaveText, /Math\.random|POINTS|TRIANGLE_STRIP|createBuffer|createTexture|createFramebuffer|readPixels|translate3d|will-change/);
  assert.match(platformWaveText, /prefers-reduced-motion: reduce/);
  assert.match(platformWaveText, /webglcontextlost/);
  assert.match(platformWaveText, /deleteProgram/);
  assert.match(platformWaveText, /commitAttempted/);
  assert.match(platformWaveText, /committed = commit\(\) === true/);
  assert.match(platformWaveText, /return immediate\(commit\)/);
  assert.match(platformWaveText, /function safely/);
  assert.match(platformWaveText, /powerPreference: "low-power"/);
  assert.match(platformWaveText, /WEBGL_lose_context/);

  const icon = await fetch(`${base}/icons/search.svg`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type") ?? "", /image\/svg\+xml/);

  const reportScript = await fetch(`${base}/report.js`);
  assert.equal(reportScript.status, 200);
  assert.match(await reportScript.text(), /window\.print/);

  const invalidReport = await fetch(`${base}/report/results?mode=source&jobId=not-a-uuid`);
  assert.equal(invalidReport.status, 400);
  const legacyNeteaseReport = await fetch(`${base}/report/results?mode=source&jobId=00000000-0000-4000-8000-000000000000&uid=42`);
  assert.equal(legacyNeteaseReport.status, 409);

  const styles = await fetch(`${base}/styles.css`);
  assert.equal(styles.status, 200);
  const styleText = await styles.text();
  assert.match(styleText, /scrollbar-color:/);
  assert.match(styleText, /::-webkit-scrollbar-thumb/);
  assert.match(styleText, /\.navigation-rail/);
  assert.match(styleText, /\.song-read-track/);
  assert.match(styleText, /\.navigation-rail\s*\{[^}]*position:\s*sticky/s);
  assert.match(styleText, /\.sidebar\s*\{[^}]*position:\s*fixed/s);
  assert.match(styleText, /body\.task-panel-collapsed/);
  assert.match(styleText, /body\.inspector-collapsed/);
  assert.match(styleText, /grid-template-columns:\s*minmax\(520px,\s*1fr\) 310px/);
  assert.match(styleText, /grid-template-columns:\s*minmax\(520px,\s*1fr\) 54px/);
  assert.match(styleText, /transition:\s*grid-template-columns 260ms/);
  assert.match(styleText, /@media \(max-width:\s*1280px\)/);
  assert.match(styleText, /body\[data-platform="qq"\]/);
  assert.match(styleText, /\.platform-transition-canvas/);
  assert.match(styleText, /\.platform-portal/);
  assert.doesNotMatch(styleText, /body\[data-platform="qq"\] \.app-shell\s*\{/s);
  assert.doesNotMatch(styleText, /body\[data-platform="qq"\] \.navigation-label\s*\{/s);
  assert.doesNotMatch(styleText, /body\[data-platform="qq"\] \.sidebar\s*\{[^}]*left:/s);
  assert.doesNotMatch(styleText, /body\[data-platform="qq"\] \.main-pane\s*\{/s);
  assert.doesNotMatch(styleText, /body\[data-platform="qq"\] \.workbench-intro\s*\{/s);
  assert.doesNotMatch(styleText, /body\[data-platform="qq"\] \.metric\s*\{[^}]*min-height:/s);
  assert.doesNotMatch(styleText, /body\[data-platform="qq"\] \.tab\s*\{[^}]*min-height:/s);
  assert.match(styleText, /\.workbench-intro\s*\{[^}]*height:\s*112px[^}]*min-height:\s*112px/s);
  assert.match(styleText, /\.task-command-bar\s*\{[^}]*min-height:\s*64px[^}]*padding:\s*10px 11px 10px 13px/s);
  assert.match(styleText, /\.metric\s*\{[^}]*min-height:\s*67px[^}]*padding:\s*11px 12px/s);
  assert.match(styleText, /\.tabs\s*\{[^}]*padding:\s*3px[^}]*border:\s*1px solid/s);
  assert.doesNotMatch(styleText, /body\.platform-switching[\s\S]{0,180}task-command-bar\s*\{\s*pointer-events:\s*none/s);
  assert.match(styleText, /body\.platform-switching \.platform-surface[\s\S]*animation-play-state:\s*paused !important;[\s\S]*transition:\s*none !important;/s);
  assert.doesNotMatch(styleText, /body\.platform-switching > :not\(\.platform-transition-canvas\)/);
  assert.match(styleText, /body\.platform-switching dialog\[open\],[\s\S]*body\.platform-switching \.toast\s*\{[\s\S]*animation:\s*none !important;/s);
  assert.match(appText, /async function playMotion[\s\S]{0,180}classList\.contains\("platform-switching"\)/);
  assert.match(appText, /async function animateDisclosure[\s\S]{0,900}classList\.contains\("platform-switching"\)/);
  assert.match(styleText, /\.navigation-rail\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(styleText, /@media \(max-width:\s*820px\)[\s\S]*?height:\s*calc\(100dvh - 126px\)/s);
  assert.match(styleText, /\.task-command-bar > \*\s*\{[^}]*min-width:\s*0/s);
  assert.match(styleText, /@container \(max-width:\s*560px\)[\s\S]*?\.toolbar-context > \.toolbar-topology\s*\{[^}]*flex-basis:\s*100%/s);
  assert.match(appText, /!collapsed && inspectorOverlayQuery\.matches && !document\.body\.classList\.contains\("inspector-collapsed"\)/);
  assert.match(appText, /!collapsed && inspectorOverlayQuery\.matches && !document\.body\.classList\.contains\("task-panel-collapsed"\)/);
  assert.match(appText, /matchMedia\("\(max-width: 1280px\)"\)/);
  assert.match(styleText, /\.netease-workbench/);
  assert.match(styleText, /\.qq-workbench/);
  assert.match(styleText, /\.parameter-help-button/);
  assert.match(styleText, /\.classic-encrypt-uin-dialog/);
  assert.match(styleText, /max-height:\s*calc\(100dvh - 24px\)/);
  assert.match(styleText, /\.classic-encrypt-uin-content\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(styleText, /\[data-desktop-platform="win32"\] \.topbar/s);
  assert.match(styleText, /body\.inspector-collapsed \.inspector-heading > div\s*\{[^}]*position:\s*absolute/s);
  assert.match(styleText, /\.inspector-body\s*\{[^}]*transition:/s);
  assert.match(styleText, /\.inspector-body\s*\{[^}]*min-width:\s*0/s);
  assert.match(styleText, /prefers-reduced-motion:\s*reduce/);
  assert.match(styleText, /transform 210ms/);
  assert.match(styleText, /font-size:\s*16px/);
  assert.match(styleText, /\.pool-state-indicator\.is-ready \.pool-state-led/);
  assert.match(styleText, /container-type:\s*inline-size/);
  assert.match(styleText, /@container \(max-width:\s*1210px\)/);
  assert.match(styleText, /@container \(max-width:\s*560px\)/);
  assert.match(styleText, /\.task-actions\s*\{[^}]*min-width:\s*max-content/);
  assert.doesNotMatch(styleText, /backdrop-filter:/);

  const idleJob = await fetch(`${base}/api/job`);
  assert.equal(idleJob.status, 200);
  assert.equal((await idleJob.json() as { commentsPerSecond: number }).commentsPerSecond, 0);

  const results = await fetch(`${base}/api/results?limit=50`);
  assert.equal(results.status, 200);
  assert.deepEqual(await results.json(), { results: [] });

  const qqIdle = await fetch(`${base}/api/qq/job`);
  assert.equal(qqIdle.status, 200);
  const qqIdleValue = await qqIdle.json() as { platform: string; status: string };
  assert.equal(qqIdleValue.platform, "qq");
  assert.equal(qqIdleValue.status, "idle");

  const missingQQGeneration = await fetch(`${base}/api/qq/results?limit=50`);
  assert.equal(missingQQGeneration.status, 400);

  const estimate = await fetch(`${base}/api/estimate?comments=500000`);
  assert.equal(estimate.status, 200);
  const value = await estimate.json() as { pages: number; expectedSeconds: number };
  assert.equal(value.pages, 500);
  assert.equal(value.expectedSeconds, 1_450);

  const parallelDefaults = await fetch(`${base}/api/estimate?mode=parallel&comments=100000&pageSize=1000&lanes=4&workersPerLane=3&proxyTransport=1`);
  assert.equal(parallelDefaults.status, 200);
  const parallelDefaultValue = await parallelDefaults.json() as { expectedSeconds: number; proxyTransportStartDelayMs: number };
  assert.equal(parallelDefaultValue.expectedSeconds, 5);
  assert.equal(parallelDefaultValue.proxyTransportStartDelayMs, 50);

  const qqDefaults = await fetch(`${base}/api/estimate?platform=qq&mode=likes&comments=100000&pageSize=25&partitions=10&lanes=8&workersPerLane=1&proxyTransport=1&hostConcurrency=8`);
  assert.equal(qqDefaults.status, 200);
  const qqDefaultValue = await qqDefaults.json() as { expectedSeconds: number; proxyTransportStartDelayMs: number };
  assert.equal(qqDefaultValue.expectedSeconds, 200);
  assert.equal(qqDefaultValue.proxyTransportStartDelayMs, 50);

  const pooledEstimate = await fetch(`${base}/api/estimate?comments=100000&pageSize=100&minDelayMs=2500&jitterMs=800&networkMs=400&lanes=4&workersPerLane=1`);
  assert.equal(pooledEstimate.status, 200);
  const pooledValue = await pooledEstimate.json() as { expectedSeconds: number; totalWorkers: number };
  assert.equal(pooledValue.expectedSeconds, 725);
  assert.equal(pooledValue.totalWorkers, 4);

  const parallelEstimate = await fetch(`${base}/api/estimate?comments=100000&pageSize=1000&minDelayMs=333&jitterMs=100&networkMs=400&lanes=4&workersPerLane=3`);
  assert.equal(parallelEstimate.status, 200);
  const parallelValue = await parallelEstimate.json() as { pages: number; expectedSeconds: number; totalWorkers: number };
  assert.equal(parallelValue.pages, 100);
  assert.equal(parallelValue.expectedSeconds, 10);
  assert.equal(parallelValue.totalWorkers, 12);

  const protectedEstimate = await fetch(`${base}/api/estimate?comments=100000&pageSize=1000&minDelayMs=333&jitterMs=100&networkMs=400&lanes=4&workersPerLane=3&proxyTransport=1`);
  const protectedValue = await protectedEstimate.json() as { expectedSeconds: number; effectiveWorkers: number; proxyTransportMaxConcurrent: number };
  assert.equal(protectedValue.expectedSeconds, 10);
  assert.equal(protectedValue.effectiveWorkers, 8);
  assert.equal(protectedValue.proxyTransportMaxConcurrent, 8);

  const customProtectedEstimate = await fetch(`${base}/api/estimate?comments=100000&pageSize=1000&minDelayMs=333&jitterMs=100&networkMs=400&lanes=4&workersPerLane=3&proxyTransport=1&hostConcurrency=4`);
  const customProtectedValue = await customProtectedEstimate.json() as { effectiveWorkers: number; proxyTransportMaxConcurrent: number };
  assert.equal(customProtectedValue.effectiveWorkers, 4);
  assert.equal(customProtectedValue.proxyTransportMaxConcurrent, 4);

  const qqEstimate = await fetch(`${base}/api/estimate?platform=qq&mode=likes&comments=100000&pageSize=25&partitions=10&minDelayMs=3000&jitterMs=1000&networkMs=400&lanes=8&workersPerLane=2&proxyTransport=1&hostConcurrency=8`);
  assert.equal(qqEstimate.status, 200);
  const qqEstimateValue = await qqEstimate.json() as { platform: string; effectiveWorkers: number; checkpointSlots: number; proxyTransportMaxConcurrent: number; proxyTransportStartDelayMs: number };
  assert.equal(qqEstimateValue.platform, "qq");
  assert.equal(qqEstimateValue.effectiveWorkers, 8);
  assert.equal(qqEstimateValue.checkpointSlots, 8);
  assert.equal(qqEstimateValue.proxyTransportMaxConcurrent, 8);
  assert.equal(qqEstimateValue.proxyTransportStartDelayMs, 50);
  const qqSingleLaneHostEstimate = await fetch(`${base}/api/estimate?platform=qq&mode=likes&comments=100000&pageSize=25&partitions=32&minDelayMs=0&jitterMs=0&networkMs=400&lanes=1&workersPerLane=32&proxyTransport=1&hostConcurrency=32`);
  assert.equal(qqSingleLaneHostEstimate.status, 200);
  const qqSingleLaneHostValue = await qqSingleLaneHostEstimate.json() as { effectiveWorkers: number; proxyTransportMaxConcurrent: number };
  assert.equal(qqSingleLaneHostValue.effectiveWorkers, 32);
  assert.equal(qqSingleLaneHostValue.proxyTransportMaxConcurrent, 32);
  const qqSongEstimate = await fetch(`${base}/api/estimate?platform=qq&mode=song&comments=100000&pageSize=25&partitions=1&minDelayMs=3000&jitterMs=1000&networkMs=400&lanes=8&workersPerLane=8&proxyTransport=1&hostConcurrency=32`);
  assert.equal(qqSongEstimate.status, 200);
  const qqSongEstimateValue = await qqSongEstimate.json() as { effectiveWorkers: number; serialRequestChain: boolean };
  assert.equal(qqSongEstimateValue.effectiveWorkers, 1);
  assert.equal(qqSongEstimateValue.serialRequestChain, true);
  assert.equal((await fetch(`${base}/api/estimate?platform=qq&comments=100&pageSize=25`)).status, 400);
  const invalidQQPageSize = await fetch(`${base}/api/estimate?platform=qq&mode=song&comments=100&pageSize=26&minDelayMs=3000&jitterMs=1000`);
  assert.equal(invalidQQPageSize.status, 400);

  const calibratedEstimate = await fetch(`${base}/api/estimate?comments=60000&pageSize=1000&partitions=100&observedCommentsPerPage=600&requestSuccessRatio=0.8&networkMs=550&lanes=8&workersPerLane=2&proxyTransport=1&hostConcurrency=8&proxyTransportEffectiveConcurrent=4&minDelayMs=0&jitterMs=0`);
  assert.equal(calibratedEstimate.status, 200);
  const calibratedValue = await calibratedEstimate.json() as { pages: number; estimatedRequests: number; effectiveWorkers: number };
  assert.equal(calibratedValue.pages, 100);
  assert.equal(calibratedValue.estimatedRequests, 125);
  assert.equal(calibratedValue.effectiveWorkers, 4);
});

test("recognizes only local socket addresses for private result reports", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.19.2.3"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.1.5"), false);
  assert.equal(isLoopbackAddress("::ffff:192.168.1.5"), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test("rotates UID lookups across the managed pool and fails over to another exit", async () => {
  const entries = [
    { name: "node-a", endpoint: "http://127.0.0.1:17891", egressIp: "1.1.1.1", latencyMs: 10, ncmLatencyMs: 20, ncmVerified: true },
    { name: "node-b", endpoint: "http://127.0.0.1:17892", egressIp: "2.2.2.2", latencyMs: 11, ncmLatencyMs: 21, ncmVerified: true },
  ];
  const pool: ProxyPoolFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    source: "external",
    active: true,
    entries,
  };
  const calls: Array<string | undefined> = [];
  const successfulProbe = (uid: string): UserProbe => ({
    profile: { userId: uid, nickname: `user-${uid}` },
    record: { status: "available", songs: 1 },
    likes: { status: "available", songs: 2 },
    sessionPresent: false,
    elapsedMs: 10,
    route: "direct",
    routeAttempts: 1,
  });
  const router = new UserProbeRouter("/cookie", "/pool", {
    readPool: async () => pool,
    probe: async (uid, proxy) => {
      calls.push(proxy);
      if (proxy === entries[0].endpoint) throw new Error("broken exit");
      return successfulProbe(uid);
    },
  });

  const first = await router.run("101");
  const second = await router.run("202");
  assert.deepEqual(calls, [entries[0].endpoint, entries[1].endpoint, entries[1].endpoint]);
  assert.deepEqual(
    { route: first.route, name: first.routeName, attempts: first.routeAttempts },
    { route: "managed-pool", name: "node-b", attempts: 2 },
  );
  assert.deepEqual(
    { route: second.route, name: second.routeName, attempts: second.routeAttempts },
    { route: "managed-pool", name: "node-b", attempts: 1 },
  );
});

test("keeps a failed managed-pool UID lookup from silently falling back to direct", async () => {
  const pool: ProxyPoolFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    source: "external",
    active: true,
    entries: [{ name: "node-a", endpoint: "http://127.0.0.1:17891", egressIp: "1.1.1.1", latencyMs: 10, ncmLatencyMs: 20, ncmVerified: true }],
  };
  const calls: Array<string | undefined> = [];
  const router = new UserProbeRouter("/cookie", "/pool", {
    readPool: async () => pool,
    probe: async (_uid, proxy) => { calls.push(proxy); throw new Error("upstream failed"); },
  });
  await assert.rejects(router.run("303"), (error: unknown) => {
    assert.equal((error as { status?: number }).status, 502);
    assert.match((error as Error).message, /1 个代理出口/);
    return true;
  });
  assert.deepEqual(calls, [pool.entries[0].endpoint]);
});

test("turns user_detail 404 into an actionable UID error without rotating every exit", async () => {
  const pool: ProxyPoolFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    source: "external",
    active: true,
    entries: [
      { name: "node-a", endpoint: "http://127.0.0.1:17891", egressIp: "1.1.1.1", latencyMs: 10, ncmLatencyMs: 20, ncmVerified: true },
      { name: "node-b", endpoint: "http://127.0.0.1:17892", egressIp: "2.2.2.2", latencyMs: 11, ncmLatencyMs: 21, ncmVerified: true },
    ],
  };
  const calls: Array<string | undefined> = [];
  const router = new UserProbeRouter("/cookie", "/pool", {
    readPool: async () => pool,
    probe: async (_uid, proxy) => {
      calls.push(proxy);
      throw Object.assign(new Error("user_detail failed (404)"), { status: 404 });
    },
  });
  await assert.rejects(router.run("404404"), (error: unknown) => {
    assert.equal((error as { status?: number }).status, 404);
    assert.match((error as Error).message, /用户主页中的纯数字 UID/);
    return true;
  });
  assert.deepEqual(calls, [pool.entries[0].endpoint]);
});

test("validates multiple Clash config selections against one discovery snapshot", () => {
  const discovery = {
    platform: process.platform,
    installed: true,
    configPath: "/profiles/a.yaml",
    mihomoPath: "/bin/mihomo",
    configCandidates: ["/profiles/a.yaml"],
    mihomoCandidates: ["/bin/mihomo"],
    profiles: [{ uid: "b", name: "B", path: "/profiles/b.yaml", type: "remote" as const, active: false }],
  };
  assert.deepEqual(
    validateClashConfigSelection(["/profiles/a.yaml", "/profiles/b.yaml"], discovery),
    [resolve("/profiles/a.yaml"), resolve("/profiles/b.yaml")],
  );
  assert.throws(
    () => validateClashConfigSelection(["/profiles/a.yaml", "/profiles/nope.yaml"], discovery),
    /已发现的代理配置/,
  );
});

test("dashboard restores the last task descriptor from the persistent runtime root", async (context) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "ncm-dashboard-resume-"));
  const dataDirectory = join(runtimeRoot, "data");
  await mkdir(dataDirectory, { recursive: true });
  const descriptor = {
    version: 1,
    mode: "parallel",
    updatedAt: "2026-08-07T00:00:00.000Z",
    input: {
      uid: "42",
      songId: "186016",
      workersPerProxy: 3,
      shards: 96,
      pageSize: 1000,
    },
  };
  await writeFile(join(dataDirectory, "resume-task.json"), JSON.stringify(descriptor));
  const server = await startDashboard({ host: "127.0.0.1", port: 0, runtimeRoot });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;

  const response = await fetch(`http://127.0.0.1:${address.port}/api/resume`);
  assert.equal(response.status, 200);
  const restored = await response.json() as {
    task: { version: number; platform: string; requestIntervalSemantics: string; input: Record<string, unknown> };
    adjustments: string[];
  };
  assert.equal(restored.task.version, 3);
  assert.equal(restored.task.platform, "netease");
  assert.equal(restored.task.requestIntervalSemantics, "per-start-v1");
  assert.equal(restored.task.input.minDelayMs, 111);
  assert.equal(restored.task.input.jitterMs, 34);
  assert.equal(restored.task.input.songId, descriptor.input.songId);
  assert.deepEqual(restored.adjustments, ["netease-request-spacing-per-start-v1"]);
  const persisted = JSON.parse(await readFile(join(dataDirectory, "resume-task.json"), "utf8")) as {
    version: number;
    requestIntervalSemantics: string;
  };
  assert.equal(persisted.version, 3);
  assert.equal(persisted.requestIntervalSemantics, "per-start-v1");
  const second = await fetch(`http://127.0.0.1:${address.port}/api/resume`);
  assert.equal(second.status, 200);
  const secondValue = await second.json() as { task: { version: number }; adjustments?: string[] };
  assert.equal(secondValue.task.version, 3);
  assert.equal(secondValue.adjustments, undefined);
});

test("current request-start spacing descriptors are never migrated twice", () => {
  const descriptor = {
    version: 3 as const,
    platform: "netease" as const,
    mode: "parallel" as const,
    requestIntervalSemantics: "per-start-v1" as const,
    updatedAt: "2026-08-08T00:00:00.000Z",
    input: { uid: "42", songId: "186016", workersPerProxy: 3, minDelayMs: 111, jitterMs: 34 },
  };
  assert.deepEqual(normalizeResumeTaskForClient(descriptor), { task: descriptor });
});

test("legacy QQ resume keeps its saved custom request-start spacing", () => {
  const descriptor = {
    version: 2 as const,
    platform: "qq" as const,
    mode: "likes" as const,
    updatedAt: "2026-08-08T00:00:00.000Z",
    input: { target: "synthetic-target", pageSize: 25, minDelayMs: 3_000, jitterMs: 1_000 },
  };
  const restored = normalizeResumeTaskForClient(descriptor);
  assert.equal(restored.task.version, 3);
  assert.equal(restored.task.input.minDelayMs, 3_000);
  assert.equal(restored.task.input.jitterMs, 1_000);
  assert.equal(restored.adjustments, undefined);
});

test("dashboard normalizes a legacy QQ page size without changing its resume generation", async (context) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "ncm-dashboard-qq-resume-"));
  const dataDirectory = join(runtimeRoot, "data");
  await mkdir(dataDirectory, { recursive: true });
  const descriptor = {
    version: 2,
    platform: "qq",
    mode: "likes",
    updatedAt: "2026-08-08T00:00:00.000Z",
    input: { target: "canonical-user", pageSize: 100, likedPageSize: 500, workersPerProxy: 2 },
  };
  await writeFile(join(dataDirectory, "resume-task.json"), JSON.stringify(descriptor));
  const server = await startDashboard({ host: "127.0.0.1", port: 0, runtimeRoot });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;

  const response = await fetch(`http://127.0.0.1:${address.port}/api/resume`);
  assert.equal(response.status, 200);
  const value = await response.json() as { task: typeof descriptor & { version: number; requestIntervalSemantics: string }; adjustments: string[] };
  assert.equal(value.task.version, 3);
  assert.equal(value.task.requestIntervalSemantics, "per-start-v1");
  assert.equal(value.task.input.pageSize, 25);
  assert.equal(value.task.input.target, descriptor.input.target);
  assert.deepEqual(value.adjustments, ["qq-comment-page-size-25"]);
});

test("dashboard composes QQ manager routes with generation-bound results, logs, reports, and global exclusion", async (context) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "ncm-dashboard-qq-routes-"));
  let scanOptions: QQMusicScanOptions | undefined;
  let finishScan = (_report: QQMusicScanReport): void => {};
  const scan = new Promise<QQMusicScanReport>((resolve) => { finishScan = resolve; });
  const client: QQMusicPlatformClient = {
    resolveUser: async (input) => ({ input, encryptUin: "canonical-user" }),
    getSongInfo: async (songId) => ({ id: songId, name: "测试歌曲" }),
    getLikedSongsPage: async () => ({ songs: [], hasMore: false, nextOffset: 0 }),
    getNewComments: async () => ({ comments: [], hasMore: false }),
  };
  const server = await startDashboard({
    host: "127.0.0.1",
    port: 0,
    runtimeRoot,
    qqClientFactory: () => client,
    qqRunner: async (_lanes, options) => { scanOptions = options; return scan; },
  });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const started = await fetch(`${base}/api/qq/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "song", target: "123456789", songId: "7", pageSize: 25, allowDirect: true }),
  });
  assert.equal(started.status, 202);
  const job = await started.json() as { id: string; generation: { target: { value: string }; mode: string } };
  assert.equal(job.generation.target.value, "canonical-user");
  assert.equal(job.generation.mode, "song");
  assert.equal(scanOptions?.pageSize, 25);

  const blockedSource = await fetch(`${base}/api/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: "42", source: "record", allowDirect: true }),
  });
  assert.equal(blockedSource.status, 409);
  const blockedSearch = await fetch(`${base}/api/qq/song/search?q=running%20scan&allowDirect=1`);
  assert.equal(blockedSearch.status, 409);

  const results = await fetch(`${base}/api/qq/results?jobId=${job.id}&limit=50`);
  assert.equal(results.status, 200);
  const resultsValue = await results.json() as { generation: { jobId: string }; results: unknown[] };
  assert.equal(resultsValue.generation.jobId, job.id);
  assert.deepEqual(resultsValue.results, []);

  const logs = await fetch(`${base}/api/logs?mode=qq&jobId=${job.id}&limit=50`);
  assert.equal(logs.status, 200);
  assert.equal((await logs.json() as { generation: { jobId: string } }).generation.jobId, job.id);

  const streamResponse = await fetch(`${base}/api/qq/results/stream?jobId=${job.id}`);
  assert.equal(streamResponse.status, 200);
  scanOptions?.onMatch?.({
    platform: "qq", targetEncryptUin: "canonical-user", songId: "7",
    commentId: "comment-1", seqNo: "10", authorEncryptUin: "author-1",
    content: "hello", capturedAt: "2026-08-08T00:00:00.000Z",
  });
  const streamReader = streamResponse.body!.getReader();
  const decoder = new TextDecoder();
  let streamText = "";
  for (let index = 0; index < 3 && !streamText.includes("event: match"); index += 1) {
    const chunk = await streamReader.read();
    streamText += decoder.decode(chunk.value, { stream: !chunk.done });
  }
  await streamReader.cancel();
  assert.match(streamText, /event: match/);
  assert.match(streamText, /"generation":\{"platform":"qq","mode":"song","jobId":/);
  assert.match(streamText, /"comment":\{"platform":"qq"/);

  const staleStream = await fetch(`${base}/api/qq/results/stream?jobId=00000000-0000-4000-8000-000000000000`);
  assert.equal(staleStream.status, 409);

  const reportQuery = new URLSearchParams({
    platform: "qq", mode: "song", jobId: job.id,
    targetKind: "encryptUin", target: "canonical-user",
  });
  const report = await fetch(`${base}/report/results?${reportQuery}`);
  assert.equal(report.status, 200);
  const reportHtml = await report.text();
  assert.match(reportHtml, /name="result-report-platform" content="qq"/);
  assert.match(reportHtml, /name="result-report-target" content="canonical-user"/);
  reportQuery.set("target", "wrong-generation");
  assert.equal((await fetch(`${base}/report/results?${reportQuery}`)).status, 409);

  assert.equal((await fetch(`${base}/api/estimate?platform=qq&mode=song&comments=100&pageSize=26`)).status, 400);
  const stopping = await fetch(`${base}/api/tasks/stop`, { method: "POST", body: "{}" });
  assert.equal(stopping.status, 200);
  assert.equal((await stopping.json() as { active: boolean; mode: string }).mode, "qq");
  finishScan({
    status: "stopped", mode: "song", targetEncryptUin: "canonical-user",
    songs: 1, songsComplete: 0, lanes: 1, workers: 1, pagesProcessed: 0,
    commentsInspected: 0, matches: 0, requestsThisRun: 0, requestsTotal: 0,
    coverageComplete: false, elapsedMs: 1,
    statePath: scanOptions!.statePath, outputPath: scanOptions!.outputPath,
  });
  for (let index = 0; index < 20; index += 1) {
    const active = await fetch(`${base}/api/tasks/active`).then((response) => response.json()) as { active: boolean };
    if (!active.active) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal((await fetch(`${base}/api/tasks/active`).then((response) => response.json()) as { active: boolean }).active, false);

  const prepared = await fetch(`${base}/api/tasks/prepare-update`, { method: "POST", body: "{}" });
  assert.equal(prepared.status, 200);
  assert.deepEqual(await prepared.json(), { active: false, preparingUpdate: true });
  const blockedDuringUpdate = await fetch(`${base}/api/qq/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "song", target: "123456789", songId: "7", pageSize: 25, allowDirect: true }),
  });
  assert.equal(blockedDuringUpdate.status, 409);
  const cancelledUpdate = await fetch(`${base}/api/tasks/cancel-update`, { method: "POST", body: "{}" });
  assert.equal(cancelledUpdate.status, 200);
  assert.deepEqual(await cancelledUpdate.json(), { active: false, preparingUpdate: false });
});

test("dashboard restores a valid legacy temp descriptor after an interrupted Windows rename", async (context) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "ncm-dashboard-temp-resume-"));
  const dataDirectory = join(runtimeRoot, "data");
  await mkdir(dataDirectory, { recursive: true });
  const descriptor = {
    version: 1,
    mode: "source",
    updatedAt: "2026-08-07T00:00:00.000Z",
    input: { uid: "42", source: "record", pageSize: 1000 },
  };
  await writeFile(join(dataDirectory, "resume-task.json.tmp"), JSON.stringify(descriptor));
  const server = await startDashboard({ host: "127.0.0.1", port: 0, runtimeRoot });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;

  const response = await fetch(`http://127.0.0.1:${address.port}/api/resume`);
  assert.equal(response.status, 200);
  const restored = await response.json() as {
    task: { version: number; platform: string; requestIntervalSemantics: string; input: Record<string, unknown> };
    adjustments: string[];
  };
  assert.equal(restored.task.version, 3);
  assert.equal(restored.task.platform, "netease");
  assert.equal(restored.task.input.uid, "42");
  assert.equal(restored.task.input.minDelayMs, 2_500);
  assert.equal(restored.task.input.jitterMs, 800);
  assert.deepEqual(restored.adjustments, ["netease-request-spacing-per-start-v1"]);
});

test("dashboard reports an empty cross-version task descriptor explicitly", async (context) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "ncm-dashboard-no-resume-"));
  const server = await startDashboard({ host: "127.0.0.1", port: 0, runtimeRoot });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;

  const response = await fetch(`http://127.0.0.1:${address.port}/api/resume`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { task: null });
});

test("dashboard opens a live result event stream", async (context) => {
  const server = await startDashboard({ host: "127.0.0.1", port: 0 });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/results/stream`, {
    signal: controller.signal,
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /connected/);
  const pending = reader.read();
  const state = await Promise.race([
    pending.then((value) => value.done ? "closed" : "data", () => "aborted"),
    new Promise<"open">((done) => setTimeout(() => done("open"), 30)),
  ]);
  assert.equal(state, "open");
  controller.abort();
  await pending.catch(() => undefined);
});

test("dashboard exposes the startup update check", async (context) => {
  const update = {
    currentVersion: "0.1.0",
    latestVersion: "0.2.0",
    updateAvailable: true,
    platform: "win32" as const,
    arch: "x64",
    releaseName: "乐评寻踪 v0.2.0",
    releaseUrl: "https://example.test/releases/v0.2.0",
    assetName: "NCM-Comment-Finder-Setup-0.2.0.exe",
    downloadUrl: "https://example.test/download.exe",
    checkedAt: "2026-08-06T00:00:00.000Z",
  };
  const server = await startDashboard({
    host: "127.0.0.1",
    port: 0,
    currentVersion: "0.1.0",
    updateChecker: async () => update,
  });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/update`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), update);
});

test("dashboard validates UID before starting a job", async (context) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "ncm-dashboard-validation-"));
  const server = await startDashboard({ host: "127.0.0.1", port: 0, runtimeRoot });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: "abc", source: "record", recordScope: "all" }),
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /UID/);

  const lookup = await fetch(`http://127.0.0.1:${address.port}/api/user?uid=abc`);
  assert.equal(lookup.status, 400);
  assert.match(await lookup.text(), /UID/);

  const oversizedPage = await fetch(`http://127.0.0.1:${address.port}/api/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: "42", source: "record", recordScope: "all", pageSize: 2_001 }),
  });
  assert.equal(oversizedPage.status, 400);
  assert.match(await oversizedPage.text(), /pageSize/);

  const excessiveExitLimit = await fetch(`http://127.0.0.1:${address.port}/api/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: "42", source: "record", recordScope: "all", maxProxyLanes: 33 }),
  });
  assert.equal(excessiveExitLimit.status, 400);
  assert.match(await excessiveExitLimit.text(), /maxProxyLanes/);

  for (const hostConcurrency of [0, 33]) {
    const invalidHostConcurrency = await fetch(`http://127.0.0.1:${address.port}/api/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: "42", source: "record", recordScope: "all", hostConcurrency }),
    });
    assert.equal(invalidHostConcurrency.status, 400);
    assert.match(await invalidHostConcurrency.text(), /hostConcurrency/);
  }

  const protectedDirect = await fetch(`http://127.0.0.1:${address.port}/api/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: "42", source: "record", recordScope: "all", allowDirect: false }),
  });
  assert.equal(protectedDirect.status, 409);
  assert.match(await protectedDirect.text(), /允许本机直连/);

  const likedSongsWithoutLogin = await fetch(`http://127.0.0.1:${address.port}/api/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: "42", source: "likes", recordScope: "all", allowDirect: true }),
  });
  assert.equal(likedSongsWithoutLogin.status, 401);
  assert.match(await likedSongsWithoutLogin.text(), /二维码登录/);
});

test("a failed source start does not publish its result path", async (context) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "ncm-dashboard-failed-start-results-"));
  const dataRoot = join(runtimeRoot, "data");
  await mkdir(dataRoot, { recursive: true });
  await writeFile(join(dataRoot, "web-comments-123.jsonl"), `${JSON.stringify({
    commentId: "foreign-result",
    userId: "123",
    content: "must stay hidden",
  })}\n`);
  const server = await startDashboard({ host: "127.0.0.1", port: 0, runtimeRoot });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const start = await fetch(`${base}/api/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: "123", source: "record", recordScope: "all" }),
  });
  assert.equal(start.status, 409);

  const results = await fetch(`${base}/api/results?limit=50`);
  assert.deepEqual(await results.json(), { results: [] });
});

test("dashboard keeps proxy-pool state under the configured runtime root", async (context) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "ncm-dashboard-"));
  const server = await startDashboard({ host: "127.0.0.1", port: 0, runtimeRoot });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/pool`);
  assert.equal(response.status, 200);
  const pool = await response.json() as { status: string; poolPath: string; entries: unknown[] };
  assert.equal(pool.status, "not-running");
  assert.equal(pool.poolPath, join(runtimeRoot, ".ncm", "proxy-pool.json"));
  assert.deepEqual(pool.entries, []);
});

test("dashboard caches Clash discovery across frequent pool status polls", async (context) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "ncm-dashboard-discovery-cache-"));
  let discoveryCalls = 0;
  const server = await startDashboard({
    host: "127.0.0.1",
    port: 0,
    runtimeRoot,
    poolDiscoveryIntervalMs: 25,
    poolDiscoverer: () => {
      discoveryCalls += 1;
      return {
        platform: process.platform,
        installed: false,
        configCandidates: [],
        mihomoCandidates: [],
        profiles: [],
      };
    },
  });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${address.port}/api/pool`;

  await Promise.all([fetch(endpoint), fetch(endpoint), fetch(endpoint)]);
  assert.equal(discoveryCalls, 1);

  await new Promise((done) => setTimeout(done, 30));
  await fetch(endpoint);
  assert.equal(discoveryCalls, 2);
});

test("dashboard periodically refreshes active proxy latency", async (context) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "ncm-dashboard-pool-refresh-"));
  const poolDirectory = join(runtimeRoot, ".ncm");
  const poolPath = join(poolDirectory, "proxy-pool.json");
  await mkdir(poolDirectory, { recursive: true });
  const initial: ProxyPoolFile = {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    lastCheckedAt: new Date(0).toISOString(),
    source: "external",
    active: true,
    entries: [{
      name: "external-1",
      endpoint: "http://127.0.0.1:17891",
      egressIp: "1.1.1.1",
      latencyMs: 20,
      ncmLatencyMs: 30,
      ncmVerified: true,
    }],
  };
  await writeFile(poolPath, JSON.stringify(initial));
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((done) => { releaseRefresh = done; });
  let refreshCalls = 0;
  const server = await startDashboard({
    host: "127.0.0.1",
    port: 0,
    runtimeRoot,
    poolRefreshIntervalMs: 60_000,
    poolRefresher: async (path) => {
      refreshCalls += 1;
      await refreshGate;
      const current = JSON.parse(await readFile(path, "utf8")) as ProxyPoolFile;
      const refreshed = {
        ...current,
        lastCheckedAt: new Date().toISOString(),
        entries: current.entries.map((value) => ({ ...value, ncmLatencyMs: 145 })),
      };
      await writeFile(path, JSON.stringify(refreshed));
      return refreshed;
    },
  });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const first = await fetch(`${base}/api/pool`);
  const firstPool = await first.json() as { refreshing: boolean };
  assert.equal(firstPool.refreshing, true);
  assert.equal(refreshCalls, 1);
  const updateStop = await fetch(`${base}/api/tasks/stop`, { method: "POST", body: "{}" });
  assert.equal(updateStop.status, 200);
  assert.deepEqual(await updateStop.json(), { active: true, mode: "pool" });
  const updatePrepare = await fetch(`${base}/api/tasks/prepare-update`, { method: "POST", body: "{}" });
  assert.equal(updatePrepare.status, 200);
  assert.deepEqual(await updatePrepare.json(), { active: true, mode: "pool", preparingUpdate: true });
  assert.equal((JSON.parse(await readFile(poolPath, "utf8")) as ProxyPoolFile).active, true);
  const blockedDuringPoolUpdate = await fetch(`${base}/api/qq/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "song", target: "123456789", songId: "7", allowDirect: true }),
  });
  assert.equal(blockedDuringPoolUpdate.status, 409);
  await fetch(`${base}/api/tasks/cancel-update`, { method: "POST", body: "{}" });

  releaseRefresh();
  await new Promise((done) => setTimeout(done, 10));
  const second = await fetch(`${base}/api/pool`);
  const secondPool = await second.json() as {
    refreshing: boolean;
    entries: ProxyPoolFile["entries"];
  };
  assert.equal(secondPool.refreshing, false);
  assert.equal(secondPool.entries[0].ncmLatencyMs, 145);
  assert.equal(refreshCalls, 1);
});

test("dashboard validates an external proxy pool before importing it", async (context) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "ncm-dashboard-proxy-"));
  const server = await startDashboard({ host: "127.0.0.1", port: 0, runtimeRoot });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/pool/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proxies: "" }),
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /代理地址/);
});

test("dashboard rejects an arbitrary Clash Verge config path", async (context) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "ncm-dashboard-config-"));
  const server = await startDashboard({ host: "127.0.0.1", port: 0, runtimeRoot });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/pool/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceConfigPaths: [join(runtimeRoot, "not-a-discovered-profile.yaml")] }),
  });

  assert.equal(response.status, 400);
  assert.match(await response.text(), /已发现的代理配置/);
});
