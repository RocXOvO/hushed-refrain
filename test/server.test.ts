import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import upstream = require("@neteasecloudmusicapienhanced/api");
import { RunCancelled } from "../src/errors";
import { RequestGovernor } from "../src/governor";
import { loadState } from "../src/state";
import { encodeClassicEncryptUin } from "../src/qq-music/classic-encrypt-uin";
import {
  isLoopbackAddress,
  migrateLegacyWeekSourceState,
  NcmSongSearchRouter,
  normalizeResumeTaskForClient,
  parallelCoverageLabel,
  probeNeteaseIdentityDirect,
  probeNeteaseIdentityThroughLanes,
  probeUser,
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

test("parallel PDF coverage distinguishes finished root time from pending floors", () => {
  assert.equal(parallelCoverageLabel(100, false), "顶层时间范围 100.0%，楼中楼尚未完成");
  assert.equal(parallelCoverageLabel(42.345, false), "顶层时间范围 42.3%，任务尚未完整完成");
  assert.equal(parallelCoverageLabel(100, true), "顶层时间范围与楼中楼均已完成");
});

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

test("NetEase auxiliary song lookup can bypass a running pool for a normal direct request", async () => {
  const proxies: Array<string | undefined> = [];
  let poolReads = 0;
  const router = new NcmSongSearchRouter("unused", {
    readPool: async () => {
      poolReads += 1;
      throw new Error("the direct path must not inspect the pool");
    },
    search: async (query, _limit, proxy) => {
      proxies.push(proxy);
      return [{ id: "7", name: query, artists: [] }];
    },
    lookup: async (songId, proxy) => {
      proxies.push(proxy);
      return { id: songId, name: "Song", artists: [] };
    },
  });

  assert.equal((await router.run("direct search", 5, undefined, true)).songs[0].name, "direct search");
  assert.equal((await router.lookup("7", undefined, true)).id, "7");
  assert.deepEqual(proxies, [undefined, undefined]);
  assert.equal(poolReads, 0);
});

test("explicit NetEase lane identity probing remains fail-closed when used internally", async () => {
  const calls: string[] = [];
  const lane = (name: string, fail: boolean) => ({
    name,
    identityRoute: "explicit-proxy" as const,
    identityRouteName: name,
    client: {
      getUserProfile: async (uid: string) => {
        calls.push(name);
        if (fail) throw new TypeError("synthetic proxy failure");
        return { userId: uid, nickname: "synthetic-user" };
      },
    },
    governor: new RequestGovernor({
      requestBudget: 0,
      minDelayMs: 0,
      jitterMs: 0,
      maxRetries: 0,
      forbiddenCooldownMs: 1_000,
    }),
  });

  const result = await probeNeteaseIdentityThroughLanes([
    lane("manual-a", true),
    lane("manual-b", false),
  ], "123456789");
  assert.deepEqual(calls, ["manual-a", "manual-b"]);
  assert.deepEqual(result.profile, { userId: "123456789", nickname: "synthetic-user" });
  assert.equal(result.route, "explicit-proxy");
  assert.equal(result.routeName, "manual-b");
  assert.equal(result.routeAttempts, 2);
});

test("NetEase Live Task identity is a presentation-only direct request", async () => {
  const proxies: Array<string | undefined> = [];
  const result = await probeNeteaseIdentityDirect("123456789", async (uid, proxy) => {
    proxies.push(proxy);
    return {
      profile: { userId: uid, nickname: "direct-live-user" },
      elapsedMs: 4,
    };
  });
  assert.deepEqual(proxies, [undefined]);
  assert.deepEqual(result, {
    profile: { userId: "123456789", nickname: "direct-live-user" },
    elapsedMs: 4,
    route: "direct",
    routeName: "本机直连",
    routeAttempts: 1,
  });
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
  const qqClientProxies: Array<string | undefined> = [];
  const classicIdentifier = "123456789012";
  const classicEncryptUin = encodeClassicEncryptUin(classicIdentifier);
  const wechatInternalId = "1150000000000000472";
  const wechatEncryptUin = "oK6koenzoenzoenzoenzoevloc**";
  let publicProfileCalls = 0;
  let neteaseProfileCalls = 0;
  const neteaseProbeProxies: Array<string | undefined> = [];
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
    qqClientFactory: (proxy) => {
      qqClientProxies.push(proxy);
      return client;
    },
    userProbeRouter: {
      readPool: async () => { throw new Error("ordinary probes must not inspect the pool"); },
      probe: async (uid, proxy) => {
        neteaseProbeProxies.push(proxy);
        return {
          profile: { userId: uid, nickname: "synthetic-netease-user" },
          record: { status: "available", songs: 1 },
          likes: { status: "available", songs: 2 },
          playlists: { status: "available", songs: 3, playlists: 1 },
          sessionPresent: false,
          elapsedMs: 4,
          route: "direct",
          routeAttempts: 1,
        };
      },
      profile: async (uid) => {
        neteaseProfileCalls += 1;
        return {
          profile: {
            userId: uid,
            nickname: "synthetic-netease-user",
            avatarUrl: "https://p1.music.126.net/synthetic-avatar",
            level: 8,
            listenSongs: 456,
          },
          elapsedMs: 5,
        };
      },
    },
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

  const neteaseProbe = await fetch(`${base}/api/user?uid=123456789&proxy=http://127.0.0.1:19999`);
  assert.equal(neteaseProbe.status, 200);
  assert.equal((await neteaseProbe.json() as { route: string }).route, "direct");
  assert.deepEqual(neteaseProbeProxies, [undefined]);

  const neteaseProfile = await fetch(`${base}/api/user/profile?uid=123456789`);
  assert.equal(neteaseProfile.status, 200);
  assert.deepEqual(await neteaseProfile.json(), {
    profile: {
      userId: "123456789",
      nickname: "synthetic-netease-user",
      avatarUrl: "https://p1.music.126.net/synthetic-avatar",
      level: 8,
      listenSongs: 456,
    },
    elapsedMs: 5,
    route: "direct",
    routeName: "本机直连",
    routeAttempts: 1,
  });

  const staleTaskProfile = await fetch(
    `${base}/api/user/profile?uid=123456789&mode=source&jobId=00000000-0000-4000-8000-000000000000`,
  );
  assert.equal(staleTaskProfile.status, 409);
  assert.match((await staleTaskProfile.json()).error, /任务已经切换/);
  assert.equal(neteaseProfileCalls, 1);

  const qq = await fetch(`${base}/api/qq/song/search?q=${encodeURIComponent("QQ 搜索")}&limit=3`);
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
  assert.deepEqual(qqClientProxies, [undefined]);

  for (const [input, expected] of [
    [classicIdentifier, { kind: "qq-number", label: `QQ ${classicIdentifier}` }],
    [classicEncryptUin, { kind: "qq-number", label: `QQ ${classicIdentifier}` }],
    [`https://y.qq.com/n/ryqq_v2/profile?uin=${classicEncryptUin}`, { kind: "qq-number", label: `QQ ${classicIdentifier}` }],
    [wechatInternalId, { kind: "qq-number", label: `QQ ${wechatInternalId}` }],
    [wechatEncryptUin, { kind: "wechat-user", label: "微信用户" }],
    ["opaque-user_1234", { kind: "encrypt-uin", label: "EncryptUin opaque-user_1234" }],
  ] as const) {
    const display = await fetch(`${base}/api/qq/target/display`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    });
    assert.equal(display.status, 200);
    assert.deepEqual(await display.json(), expected);
  }
  assert.equal(publicProfileCalls, 0);

  const qqProfile = await fetch(`${base}/api/qq/user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: classicEncryptUin, proxy: "http://127.0.0.1:18080" }),
  });
  assert.equal(qqProfile.status, 200);
  const qqProfileBody = await qqProfile.json() as {
    platform: string;
    identity: Record<string, unknown>;
    route: string;
    routeName: string;
    routeAttempts: number;
    elapsedMs: number;
  };
  assert.deepEqual(qqProfileBody.identity, {
    kind: "qq-number",
    label: `QQ ${classicIdentifier}`,
    nickname: "synthetic-qq-profile",
    avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${classicIdentifier}&s=100`,
  });
  assert.equal(qqProfileBody.platform, "qq");
  assert.equal(qqProfileBody.route, "direct");
  assert.equal(qqProfileBody.routeName, "本机直连");
  assert.equal(qqProfileBody.routeAttempts, 1);
  assert.equal(Number.isFinite(qqProfileBody.elapsedMs), true);
  assert.deepEqual(qqClientProxies, [undefined, undefined]);
  assert.equal(publicProfileCalls, 1);

  const wechatProfile = await fetch(`${base}/api/qq/user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: wechatEncryptUin }),
  });
  assert.equal(wechatProfile.status, 200);
  assert.deepEqual(await wechatProfile.json(), {
    platform: "qq",
    identity: { kind: "wechat-user", label: "微信用户" },
    route: "local",
    routeName: "本地识别",
    routeAttempts: 0,
    elapsedMs: 0,
  });
  assert.equal(publicProfileCalls, 1);

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
  assert.equal(publicProfileCalls, 1);

  const decodedProfileUrl = await fetch(`${base}/api/qq/encrypt-uin/decode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: `https://y.qq.com/n/ryqq_v2/profile?uin=${encodeURIComponent(classicEncryptUin)}`,
    }),
  });
  assert.equal(decodedProfileUrl.status, 200);
  assert.equal((await decodedProfileUrl.json() as { resolution: string }).resolution, "local");
  assert.equal(publicProfileCalls, 1);

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
  assert.equal(publicProfileCalls, 2);

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
  assert.equal((await fetch(`${base}/api/qq/song/search?q=valid&limit=11`)).status, 400);
  const fixedDirectVerify = await fetch(`${base}/api/qq/encrypt-uin/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      encryptUin: classicEncryptUin,
      proxy: "http://127.0.0.1:18080",
      allowDirect: false,
    }),
  });
  assert.equal(fixedDirectVerify.status, 200);
  assert.equal(qqClientProxies.at(-1), undefined);
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
  const first = fetch(`${base}/api/qq/song/search?q=first%20query`, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(first, (error: unknown) => (error as { name?: string }).name === "AbortError");

  const second = await fetch(`${base}/api/qq/song/search?q=second%20query`);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), {
    platform: "qq",
    query: "second query",
    songs: [{ id: "8", name: "second query", artists: ["Artist"] }],
  });
});

test("uses root-and-floor checkpoints with reusable target-v3 results and isolated v4 coverage", () => {
  const record = sourceTaskPaths("/data", "42", "record");
  assert.match(record.statePath, /web-state-42-record-target-v4\.json$/);
  assert.match(record.outputPath, /web-comments-42-target-v3\.jsonl$/);
  assert.match(record.coveragePath, /web-song-coverage-42-target-v4\.json$/);
  const likes = sourceTaskPaths("/data", "42", "likes");
  const both = sourceTaskPaths("/data", "42", "both");
  const playlists = sourceTaskPaths("/data", "42", "playlists");
  const allRanges = sourceTaskPaths("/data", "42", "record", "both");
  assert.match(likes.statePath, /web-state-42-likes-target-v4\.json$/);
  assert.match(both.statePath, /web-state-42-both-target-v4\.json$/);
  assert.match(playlists.statePath, /web-state-42-playlists-target-v4\.json$/);
  assert.match(allRanges.statePath, /web-state-42-record-record-both-target-v4\.json$/);
  assert.equal(likes.outputPath, record.outputPath);
  assert.equal(both.outputPath, record.outputPath);
  assert.equal(likes.coveragePath, record.coveragePath);
  assert.doesNotMatch(record.statePath, /web-state-42-record\.json$/);
  assert.doesNotMatch(likes.outputPath, /target-v2/);
  const rootOnly = sourceTaskPaths("/data", "42", "record", "all", "root-only-v1");
  assert.match(rootOnly.statePath, /web-state-42-record-root-only-target-v4\.json$/);
  assert.match(rootOnly.outputPath, /web-comments-42-root-only-target-v3\.jsonl$/);
  assert.match(rootOnly.coveragePath, /web-song-coverage-42-root-only-target-v4\.json$/);
  assert.notEqual(rootOnly.statePath, record.statePath);
  assert.notEqual(rootOnly.outputPath, record.outputPath);
  assert.notEqual(rootOnly.coveragePath, record.coveragePath);
});

test("migrates only an exactly matching legacy weekly source checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-week-state-migration-"));
  const legacyPath = sourceTaskPaths(root, "42", "record", "all").statePath;
  const scopedPath = sourceTaskPaths(root, "42", "record", "week").statePath;
  await mkdir(join(legacyPath, ".."), { recursive: true });
  await writeFile(legacyPath, `${JSON.stringify({
    version: 3,
    uid: "42",
    source: "record",
    recordScope: "week",
    strategy: "scan",
    strategyResolved: true,
    sourcesLoaded: true,
    songs: [{ id: "7", sources: ["record-week"] }],
    sourceSongCount: 1,
    sourceTruncated: false,
    sourceErrors: [],
    songIndex: 0,
    commentOffset: 0,
    pageInSong: 0,
    historyTime: 0,
    seenCommentIds: [],
    matchCount: 0,
    requestCount: 1,
    truncatedSongIds: [],
    finished: false,
    coverageComplete: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  })}\n`, "utf8");
  assert.equal(await migrateLegacyWeekSourceState(root, "42", "record"), true);
  assert.equal(JSON.parse(await readFile(scopedPath, "utf8")).recordScope, "week");
  await assert.rejects(readFile(legacyPath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.equal(await migrateLegacyWeekSourceState(root, "42", "record"), false);

  const allTimePath = sourceTaskPaths(root, "42", "record", "all").statePath;
  assert.equal(allTimePath, legacyPath);
  await writeFile(allTimePath, `${JSON.stringify({
    ...JSON.parse(await readFile(scopedPath, "utf8")),
    recordScope: "all",
    updatedAt: "2026-08-02T00:00:00.000Z",
  })}\n`, "utf8");
  assert.equal((await loadState(allTimePath))?.recordScope, "all");
});

test("weekly checkpoint migration is concurrent, idempotent, and never overwrites its scoped authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-week-state-concurrent-"));
  const legacyPath = sourceTaskPaths(root, "42", "both", "all").statePath;
  const scopedPath = sourceTaskPaths(root, "42", "both", "week").statePath;
  const state = {
    version: 3,
    uid: "42",
    source: "both",
    recordScope: "week",
    strategy: "scan",
    sourcesLoaded: true,
    songs: [{ id: "legacy", sources: ["record-week"] }],
    songProgress: [{ commentOffset: 0, pageInSong: 0, done: false }],
    sourceSongCount: 1,
    sourceTruncated: false,
    sourceErrors: [],
    songIndex: 0,
    commentOffset: 0,
    pageInSong: 0,
    historyTime: 0,
    seenCommentIds: [],
    matchCount: 0,
    requestCount: 0,
    pagesProcessed: 0,
    truncatedSongIds: [],
    finished: false,
    coverageComplete: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  };
  await mkdir(join(legacyPath, ".."), { recursive: true });
  await writeFile(legacyPath, `${JSON.stringify(state)}\n`, "utf8");
  await writeFile(scopedPath, `${JSON.stringify({
    ...state,
    songs: [{ id: "scoped", sources: ["record-week"] }],
    updatedAt: "2026-08-02T00:00:00.000Z",
  })}\n`, "utf8");

  const migrated = await Promise.all([
    migrateLegacyWeekSourceState(root, "42", "both"),
    migrateLegacyWeekSourceState(root, "42", "both"),
  ]);
  assert.deepEqual([...migrated].sort(), [false, true]);
  assert.equal((await loadState(scopedPath))?.songs[0].id, "scoped");
  await assert.rejects(readFile(legacyPath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.equal(await migrateLegacyWeekSourceState(root, "42", "both"), false);
  assert.equal(await loadState(sourceTaskPaths(root, "42", "both", "both").statePath), undefined);
});

test("dashboard serves UI assets and estimate API", async (context) => {
  const server = await startDashboard({ host: "127.0.0.1", port: 0 });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /img-src[^;]*\*\.126\.net[^;]*\*\.qlogo\.cn/);
  const pageText = await page.text();
  assert.match(pageText, /乐评寻踪/);
  assert.match(pageText, /MUSIC COMMENT TRACE/);
  assert.match(pageText, /NETEASE WORKSPACE/);
  assert.match(pageText, /id="primaryNavigation"/);
  assert.match(pageText, /id="taskSidebar"/);
  assert.match(pageText, /id="runtimeInspector"/);
  assert.match(pageText, /id="toolbarStartButton"/);
  assert.equal((pageText.match(/name="includeCommentFloors"[^>]*checked/g) ?? []).length, 0);
  assert.equal((pageText.match(/默认关闭。开启后会逐页读取楼中楼回复，扫描速度会极大降低/g) ?? []).length, 2);
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
  assert.match(pageText, /styles\.css\?v=67/);
  assert.match(pageText, /platform-wave\.js\?v=15/);
  assert.match(pageText, /pointer-silk-trail\.js\?v=6/);
  assert.match(pageText, /app\.js\?v=80/);
  assert.match(pageText, /id="sourceSegmented"[^>]*class="segmented source-segmented"/);
  assert.match(pageText, /id="sourceSelectionIndicator"[^>]*aria-hidden="true"/);
  assert.match(pageText, /id="recordScopeRegion"[^>]*class="source-scope-region"/);
  assert.match(pageText, /id="liveTaskIdentity"/);
  assert.doesNotMatch(pageText, /class="navigation-status"/);
  assert.match(pageText, /id="liveTaskAvatar"/);
  assert.match(pageText, /id="pdfExportDialog"/);
  assert.match(pageText, /id="cancelPdfExportButton"/);
  assert.doesNotMatch(pageText, /transitionModeButton|对角积木波|中心涟漪/);
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
  assert.match(pageText, /id="qqSongUserLookupButton"[^>]*aria-label="探测 QQ 音乐用户"/);
  assert.match(pageText, /id="qqLikesUserLookupButton"[^>]*aria-label="探测 QQ 音乐用户"/);
  assert.match(pageText, /id="qqSongUserPreview"[^>]*class="user-preview qq-user-preview"[^>]*aria-live="polite"/);
  assert.match(pageText, /id="qqLikesUserPreview"[^>]*class="user-preview qq-user-preview"[^>]*aria-live="polite"/);
  assert.match(pageText, /id="logPath"[^>]*class="log-path is-placeholder"/);
  assert.match(pageText, /class="navigation-footer"[^>]*>[\s\S]*id="globalSettingsButton"/);
  assert.match(pageText, /id="globalSettingsDialog"/);
  assert.match(pageText, /id="closeAppDialog"[^>]*aria-labelledby="closeAppTitle"/);
  assert.match(pageText, /id="rememberCloseAppDecision"[^>]*type="checkbox"/);
  assert.match(pageText, /id="exitCloseAppButton"/);
  assert.match(pageText, /id="backgroundCloseAppButton"/);
  assert.match(pageText, /安全停止任务、保存最新检查点后退出/);
  assert.match(pageText, /id="mainWorkspace"[^>]*class="main-pane/);
  assert.match(pageText, /id="cursorTrailEnabled"[^>]*type="checkbox"[^>]*checked/);
  assert.match(pageText, /id="cursorTrailSupport"/);
  assert.match(pageText, /name="desktopCloseBehavior" value="ask"/);
  assert.match(pageText, /name="desktopCloseBehavior" value="background"/);
  assert.match(pageText, /name="desktopCloseBehavior" value="exit"/);
  assert.match(pageText, /id="taskStartupProgress"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(pageText, /taskStartupElapsed/);
  const qqLikesMarkup = pageText.match(/<form id="qqLikesForm"[\s\S]*?<\/form>/)?.[0] ?? "";
  assert.doesNotMatch(qqLikesMarkup, /name="workersPerProxy"/);
  assert.match(qqLikesMarkup, /实际 Worker 由顶部“总工作线程上限”统一控制/);
  assert.match(pageText, /data-open-classic-encrypt-uin/);
  assert.match(pageText, /id="classicEncryptUinDialog"/);
  assert.match(pageText, /先判断输入类型/);
  assert.match(pageText, /EncryptUin \/ QQ音乐个人主页链接 \/ 数字标识/);
  assert.match(pageText, /32 位新式 ID/);
  assert.match(pageText, /直接显示完整 QQ 号候选/);
  assert.match(pageText, /低频普通查询固定使用本机直连，不读取代理池/);
  assert.match(pageText, /隐藏完整标识/);
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
  const serverSource = await readFile(resolve("src/server.ts"), "utf8");
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
  assert.doesNotMatch(appText, /song\.coveragePercent/);
  assert.match(appText, /听歌目录本轮暂时无法刷新，已继续使用检查点中的/);
  assert.match(serverSource, /commentProgressPercent\(\s*activity\.commentsProcessed,\s*activity\.totalComments/);
  assert.match(serverSource, /progressBasis: "comments"/);
  assert.match(appText, /song\.truncated \? "达到页数上限"/);
  assert.match(appText, /已完成当前可读取范围/);
  assert.match(appText, /楼中楼/);
  assert.match(appText, /classList\.toggle\("is-complete", song\.done && !song\.truncated\)/);
  assert.match(appText, /classList\.toggle\("is-truncated", song\.truncated\)/);
  assert.match(appText, /refreshActiveSongRequestAges/);
  assert.match(appText, /个分片请求中/);
  assert.match(appText, /inspectorOverlayQuery\.addEventListener\("change"/);
  assert.match(appText, /addEventListener\("pageshow", \(event\) => \{[\s\S]*event\.persisted[\s\S]*pageLifecycleSuspended = false/);
  assert.match(appText, /pageLifecycleSuspended = false[\s\S]*startRuntimeTimer\(\)[\s\S]*scheduleRefreshLoop\(0\)[\s\S]*scheduleAuthRefreshLoop\(0\)[\s\S]*connectResultStream\(\)/);
  assert.match(appText, /function scheduleRefreshLoop[\s\S]*if \(pageLifecycleSuspended\) return/);
  assert.match(appText, /已搜索/);
  assert.doesNotMatch(appText, /`已读 \$\{fmt\(comments\)\} 条 · 时间覆盖/);
  assert.match(appText, /达到每首最大页数，未覆盖全部评论/);
  assert.match(appText, /measuredPercent = !rootOnly && total !== undefined && total > 0 \? comments \/ total \* 100 : undefined/);
  assert.match(appText, /Math\.min\(song\.truncated \|\| !song\.done \? 99\.99 : 100, rawPercent\)/);
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
  assert.match(appText, /cancelResultsPdf/);
  assert.match(appText, /PDF_EXPORT_STAGE_LABELS/);
  assert.match(appText, /showPdfExportProgress/);
  assert.match(appText, /renderQQLiveIdentity/);
  assert.match(appText, /if \(identity\.kind === "wechat-user"\)[\s\S]*nickname: "微信用户"[\s\S]*meta: "微信用户"/);
  assert.match(appText, /renderNeteaseLiveIdentity/);
  assert.match(appText, /\/api\/user\/profile/);
  assert.match(appText, /\/api\/user\/profile\?uid=\$\{encodeURIComponent\(uid\)\}&mode=\$\{encodeURIComponent\(taskMode\)\}&jobId=\$\{encodeURIComponent\(jobId\)\}/);
  assert.doesNotMatch(appText, /\/api\/user\/profile[^`\n]*proxy=/);
  assert.match(appText, /\/api\/qq\/target\/display/);
  assert.match(appText, /\/api\/qq\/user/);
  assert.match(appText, /body:\s*JSON\.stringify\(\{ target \}\)/);
  assert.match(appText, /function renderSongSearchStatus/);
  assert.match(appText, /正在搜索候选歌曲/);
  assert.match(appText, /logPath\.classList\.toggle\("is-placeholder", !data\.path\)/);
  assert.match(appText, /function beginTaskStartup/);
  assert.match(appText, /function finishTaskStartup/);
  assert.match(appText, /setupDesktopSettings/);
  assert.match(appText, /desktop\.onCloseRequested\?\.\(showDesktopClosePrompt\)/);
  assert.match(appText, /submitCloseDecision\(\{[\s\S]*action,[\s\S]*remember:/);
  assert.match(appText, /正在停止活动任务并保存最新检查点/);
  assert.match(appText, /updateSettings\(\{ closeBehavior: selected, cursorTrailEnabled \}\)/);
  assert.match(appText, /resetSettings\(\)/);
  assert.match(appText, /function setupPointerSilkTrail/);
  assert.match(appText, /PointerSilkTrail/);
  assert.match(appText, /pointerSilkTrail\?\.suspend\(pointerTrailReason\)/);
  assert.match(appText, /pointerSilkTrail\?\.resume\(pointerTrailReason\)/);
  assert.match(appText, /document\.querySelector\("dialog\[open\]"\)/);
  assert.match(appText, /destroyPointerSilkTrail\(\)/);
  assert.match(appText, /document\.addEventListener\("visibilitychange"/);
  assert.match(appText, /addEventListener\("blur", \(\) => pointerSilkTrail\?\.suspend\("blur"\)\)/);
  assert.doesNotMatch(appText, /taskStartupElapsed/);
  assert.match(appText, /inspectorBody\.inert/);
  assert.match(appText, /\/api\/song\/search/);
  assert.match(appText, /\/api\/qq\/song\/search/);
  assert.match(appText, /\/api\/qq\/encrypt-uin\/decode/);
  assert.match(appText, /\/api\/qq\/encrypt-uin\/verify/);
  assert.match(appText, /"QQ号候选"/);
  assert.match(appText, /"QQ音乐微信内部ID（wxuin候选）"/);
  assert.match(appText, /不把内部 ID 误称为微信号或 QQ 号/);
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
  assert.match(appText, /pending\.switchVersion !== platformSwitchVersion[\s\S]*pending\.targetPlatform !== platform[\s\S]*pending\.targetMode !== mode[\s\S]*pending\.targetViewKey !== taskViewKey\(\)/);
  assert.match(appText, /PLATFORM_SCROLL_RESTORE_TTL_MS = 2_500/);
  assert.match(appText, /cancelEvents: \["wheel", "touchstart", "pointerdown", "keydown"\]/);
  assert.match(appText, /resultGenerationRevisions\[viewKey\] \+= 1/);
  assert.match(appText, /generationRevision: resultGenerationRevisions\[taskViewKey\(\)\]/);
  assert.match(appText, /pending\.generationRevision !== resultGenerationRevisions\[taskViewKey\(\)\]/);
  assert.match(appText, /restoreImmediate/);
  assert.match(appText, /restoreResult/);
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
  assert.match(appText, /sourcePlatform: platform,\s*targetPlatform,\s*direction,\s*commit/s);
  assert.doesNotMatch(appText, /platformTransitionPattern|transitionModeButton|ncm-platform-transition-pattern-v1|\/api\/preferences/);
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
  assert.doesNotMatch(platformWaveText, /gl_InstanceID/);
  assert.match(platformWaveText, /createVertexArray/);

  const pointerTrail = await fetch(`${base}/pointer-silk-trail.js`);
  assert.equal(pointerTrail.status, 200);
  const pointerTrailText = await pointerTrail.text();
  assert.match(pointerTrailText, /globalThis\.PointerSilkTrail/);
  assert.match(pointerTrailText, /MAX_COLOR_PIXELS = 800_000/);
  assert.match(pointerTrailText, /NUM_POINTS = 20/);
  assert.match(pointerTrailText, /NUM_LINES = 4/);
  assert.match(pointerTrailText, /getContext\("webgl2", CONTEXT_OPTIONS\)/);
  assert.match(pointerTrailText, /gl\.drawArrays\(gl\.TRIANGLE_STRIP/);
  assert.match(pointerTrailText, /Copyright \(c\) 2025 David Ronai/);
  assert.doesNotMatch(pointerTrailText, /Math\.random|localStorage|sessionStorage|preventDefault|stopPropagation/);
  assert.match(platformWaveText, /gl\.drawArrays\(gl\.TRIANGLES, 0, 3\)/);
  assert.doesNotMatch(platformWaveText, /drawArraysInstanced/);
  assert.match(platformWaveText, /const DURATION_MS = 680/);
  assert.match(platformWaveText, /const COMMIT_MS = 326/);
  assert.match(platformWaveText, /const FULLY_COVERED_MS = 244/);
  assert.match(platformWaveText, /const REVEAL_START_MS = 404/);
  assert.match(platformWaveText, /const MAX_DPR = 1\.25/);
  assert.match(platformWaveText, /const MAX_COLOR_PIXELS = 1_200_000/);
  assert.match(platformWaveText, /fwidth/);
  assert.match(platformWaveText, /float foldedEdge/);
  assert.match(platformWaveText, /float curtainAlpha/);
  assert.match(platformWaveText, /elapsedMs >= COVER_AT && elapsedMs <= REVEAL_AT[\s\S]*return 1\.0/);
  assert.match(platformWaveText, /float silkPleat/);
  assert.match(platformWaveText, /float engravedContour/);
  assert.match(platformWaveText, /if \(alpha <= 0\.0005\) discard/);
  assert.match(platformWaveText, /drawAt\(COMMIT_MS\);\s*invokeCommit\(\)/);
  assert.doesNotMatch(platformWaveText, /u_pattern|blockOrder|blockMask|blockFace|diagonal|ripple|contourIndex/);
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

  const removedPreferences = await fetch(`${base}/api/preferences`);
  assert.equal(removedPreferences.status, 404);

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
  assert.match(styleText, /\.activity-status\.is-complete/);
  assert.match(styleText, /\.activity-table\s*\{[^}]*min-width:\s*960px/s);
  assert.match(styleText, /\.activity-table th:nth-child\(4\)\s*\{[^}]*width:\s*340px/s);
  assert.match(styleText, /\.song-read-progress\s*\{[^}]*min-width:\s*300px/s);
  assert.match(styleText, /\.song-read-progress\s*>\s*span:first-child\s*\{[^}]*white-space:\s*normal/s);
  assert.match(styleText, /\.pool-build-notice\s*\{[\s\S]*right:\s*84px;/);
  assert.match(styleText, /@media \(max-width:\s*1280px\)[\s\S]*\.pool-build-notice\s*\{\s*right:\s*108px;/);
  assert.match(styleText, /@media \(max-width:\s*820px\)[\s\S]*\.pool-build-notice\s*\{[^}]*right:\s*82px;[^}]*left:\s*12px;/);
  assert.match(styleText, /scrollbar-color:/);
  assert.match(styleText, /::-webkit-scrollbar-thumb/);
  assert.match(styleText, /\.navigation-rail/);
  assert.match(styleText, /\.song-read-track/);
  assert.match(styleText, /\.qq-user-preview/);
  assert.match(styleText, /\.log-path\.is-placeholder\s*\{[^}]*font-family:\s*inherit/s);
  assert.match(styleText, /\.task-startup-progress\s*\{[^}]*position:\s*fixed[^}]*right:/s);
  assert.match(styleText, /@keyframes startup-capsule-expand/);
  assert.match(styleText, /\.task-startup-track\s*\{[^}]*height:\s*2px/s);
  assert.match(styleText, /\.navigation-footer/);
  assert.match(styleText, /\.global-settings-dialog/);
  assert.match(styleText, /\.global-settings-dialog\[open\]\s*\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)/s);
  assert.match(styleText, /\.global-settings-dialog\s*>\s*\.dialog-heading,[\s\S]*?padding:\s*17px 19px/);
  assert.match(styleText, /\.global-settings-content\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/s);
  assert.match(styleText, /\.navigation-rail\s*\{[^}]*position:\s*sticky/s);
  assert.match(styleText, /\.sidebar\s*\{[^}]*position:\s*fixed/s);
  assert.match(styleText, /body\.task-panel-collapsed/);
  assert.match(styleText, /body\.inspector-collapsed/);
  assert.match(styleText, /grid-template-columns:\s*minmax\(520px,\s*1fr\) 310px/);
  assert.match(styleText, /grid-template-columns:\s*minmax\(520px,\s*1fr\) 54px/);
  assert.match(styleText, /transition:\s*grid-template-columns 260ms/);
  assert.match(styleText, /@media \(max-width:\s*1280px\)/);
  assert.match(styleText, /body\[data-platform="qq"\]/);
  const qqTheme = styleText.match(/body\[data-platform="qq"\]\s*\{([^}]+)\}/s)?.[1] ?? "";
  const qqToken = (name: string): string => {
    const value = qqTheme.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
    assert.ok(value, `missing QQ color token --${name}`);
    return value;
  };
  const luminance = (hex: string): number => {
    const components = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return components[0] * 0.2126 + components[1] * 0.7152 + components[2] * 0.0722;
  };
  const contrast = (foreground: string, background: string): number => {
    const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };
  assert.ok(contrast(qqToken("muted"), qqToken("surface")) >= 4.5);
  assert.ok(contrast(qqToken("muted"), qqToken("surface-subtle")) >= 4.5);
  assert.ok(contrast(qqToken("accent"), qqToken("accent-soft")) >= 4.5);
  assert.match(styleText, /\.platform-transition-canvas/);
  assert.match(styleText, /\.platform-portal/);
  assert.match(styleText, /\.main-pane\s*\{[^}]*position:\s*relative[^}]*isolation:\s*isolate/s);
  assert.match(styleText, /\.pointer-silk-trail-canvas\s*\{[^}]*position:\s*absolute[^}]*pointer-events:\s*none/s);
  assert.match(styleText, /body\.platform-switching \.pointer-silk-trail-canvas\s*\{[^}]*visibility:\s*hidden/s);
  assert.match(styleText, /\.source-selection-indicator\s*\{[^}]*transform:\s*translate3d\(var\(--source-active-x\), var\(--source-active-y\), 0\)[^}]*transition:/s);
  assert.match(styleText, /\.source-scope-region\.is-collapsed\s*\{[^}]*grid-template-rows:\s*minmax\(0, 0fr\)[^}]*visibility:\s*hidden/s);
  assert.match(appText, /function syncSourceSelection[\s\S]{0,360}recordScopeRegion\.classList\.toggle\("is-collapsed", collapsed\)/);
  assert.match(appText, /new ResizeObserver\(\(\) => syncSourceIndicator\(\{ animate: false \}\)\)/);
  assert.match(styleText, /\.settings-toggle-track/);
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
  assert.match(styleText, /body\.platform-switching dialog\[open\],[\s\S]*body\.platform-switching \.toast,[\s\S]*body\.platform-switching \.pool-build-notice\s*\{[\s\S]*animation:\s*none !important;/s);
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
  assert.match(styleText, /--radius-control:\s*10px/);
  assert.match(styleText, /--radius-surface:\s*14px/);
  assert.match(styleText, /--radius-popover:\s*18px/);
  assert.match(styleText, /button:active:not\(:disabled\)[\s\S]*transform:\s*scale\(\.987\)/s);
  assert.match(styleText, /\.button\.primary:hover:not\(:disabled\):not\(\[aria-disabled="true"\]\)/);
  assert.match(styleText, /\.icon-button:hover:not\(:disabled\):not\(\[aria-disabled="true"\]\)/);
  assert.match(styleText, /\.window-control:active:not\(:disabled\)\s*\{\s*transform:\s*none/);
  assert.match(styleText, /\.netease-workbench\s*\{[^}]*border-radius:\s*var\(--radius-surface\)/s);
  assert.match(styleText, /\.qq-workbench\s*\{[^}]*border-radius:\s*var\(--radius-surface\)/s);
  assert.match(styleText, /\.platform-silk-fold-canvas\s*\{\s*contain:\s*strict/);
  assert.match(styleText, /prefers-reduced-motion:[\s\S]*button:active:not\(:disabled\)[\s\S]*transform:\s*none !important/s);
  assert.match(styleText, /\.parameter-help-button/);
  assert.match(styleText, /\.classic-encrypt-uin-dialog/);
  assert.match(styleText, /max-height:\s*calc\(100dvh - 24px\)/);
  assert.match(styleText, /\.classic-encrypt-uin-content\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(styleText, /\[data-desktop-platform="win32"\] \.topbar/s);
  assert.match(styleText, /\.status-badge\s*\{[^}]*flex:\s*0 0 auto[^}]*white-space:\s*nowrap/s);
  assert.match(styleText, /\.floor-performance-warning\s*\{[^}]*color:\s*var\(--warning\)[^}]*background:\s*var\(--warning-soft\)/s);
  assert.match(styleText, /@media \(min-width:\s*1281px\)[\s\S]*body:not\(\.task-panel-collapsed\) \.main-pane\s*\{\s*padding-left:\s*367px;/s);
  assert.match(styleText, /@media \(min-width:\s*1238px\) and \(max-width:\s*1480px\)[\s\S]*\.topbar\s*\{[^}]*grid-template-columns:\s*minmax\(310px,\s*1fr\) minmax\(310px,\s*520px\) minmax\(310px,\s*1fr\)/s);
  assert.match(styleText, /@media \(min-width:\s*1238px\) and \(max-width:\s*1480px\)[\s\S]*\[data-desktop-platform="win32"\] \.topbar-end\s*\{\s*width:\s*340px;/s);
  assert.match(styleText, /@media \(min-width:\s*1238px\) and \(max-width:\s*1480px\)[\s\S]*\[data-desktop-platform="win32"\] \.top-actions \.button span\s*\{\s*display:\s*none;/s);
  assert.match(styleText, /@media \(min-width:\s*821px\) and \(max-width:\s*1237px\)\s*\{\s*\.topbar\s*\{[^}]*grid-template-columns:\s*minmax\(71px,\s*1fr\) minmax\(290px,\s*520px\) minmax\(71px,\s*1fr\)/s);
  assert.match(styleText, /@media \(min-width:\s*821px\) and \(max-width:\s*1237px\)[\s\S]*\[data-desktop-platform="win32"\] \.topbar-end\s*\{\s*width:\s*220px;/s);
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
    playlists: { status: "available", songs: 3, playlists: 1 },
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

test("retains managed-pool profile routing for explicit internal router callers", async () => {
  const entry = { name: "node-a", endpoint: "http://127.0.0.1:17891", egressIp: "1.1.1.1", latencyMs: 10, ncmLatencyMs: 20, ncmVerified: true };
  const calls: Array<string | undefined> = [];
  const router = new UserProbeRouter("/cookie", "/pool", {
    readPool: async () => ({
      version: 1,
      generatedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
      source: "external",
      active: true,
      entries: [entry],
    }),
    profile: async (uid, proxy) => {
      calls.push(proxy);
      return {
        profile: {
          userId: uid,
          nickname: "synthetic-user",
          avatarUrl: "https://p1.music.126.net/synthetic-avatar",
          level: 9,
          listenSongs: 123,
        },
        elapsedMs: 7,
      };
    },
  });

  assert.deepEqual(await router.profile("101"), {
    profile: {
      userId: "101",
      nickname: "synthetic-user",
      avatarUrl: "https://p1.music.126.net/synthetic-avatar",
      level: 9,
      listenSongs: 123,
    },
    elapsedMs: 7,
    route: "managed-pool",
    routeName: "node-a",
    routeAttempts: 1,
  });
  assert.deepEqual(calls, [entry.endpoint]);
});

test("NetEase ordinary user probes can bypass a running pool for a normal direct request", async () => {
  const proxies: Array<string | undefined> = [];
  let poolReads = 0;
  const router = new UserProbeRouter("/cookie", "/pool", {
    readPool: async () => {
      poolReads += 1;
      throw new Error("the direct path must not inspect the pool");
    },
    probe: async (uid, proxy) => {
      proxies.push(proxy);
      return {
        profile: { userId: uid, nickname: "direct-user" },
        record: { status: "available", songs: 1 },
        likes: { status: "available", songs: 2 },
        playlists: { status: "available", songs: 3, playlists: 1 },
        sessionPresent: false,
        elapsedMs: 3,
        route: "direct",
        routeAttempts: 1,
      };
    },
    profile: async (uid, proxy) => {
      proxies.push(proxy);
      return { profile: { userId: uid, nickname: "direct-user" }, elapsedMs: 2 };
    },
  });

  assert.equal((await router.run("101", "http://127.0.0.1:19999", true)).route, "direct");
  assert.equal((await router.profile("101", "http://127.0.0.1:19999", true)).route, "direct");
  assert.deepEqual(proxies, [undefined, undefined]);
  assert.equal(poolReads, 0);
});

test("starts NetEase profile, record, and liked-source probes concurrently", async () => {
  const mutable = upstream as unknown as {
    user_detail: () => Promise<unknown>;
    user_record: () => Promise<unknown>;
    user_playlist: () => Promise<unknown>;
    playlist_detail: () => Promise<unknown>;
  };
  const originals = {
    user_detail: mutable.user_detail,
    user_record: mutable.user_record,
    user_playlist: mutable.user_playlist,
    playlist_detail: mutable.playlist_detail,
  };
  const started = new Set<string>();
  const releases = new Map<string, () => void>();
  const wait = (name: string, body: unknown) => new Promise<unknown>((resolve) => {
    started.add(name);
    releases.set(name, () => resolve({ status: 200, body }));
  });
  mutable.user_detail = () => wait("profile", { code: 200, profile: { userId: 42, nickname: "user" } });
  mutable.user_record = () => wait("record", { code: 200, allData: [] });
  let playlistRequest = 0;
  mutable.user_playlist = () => wait(`playlist-list-${++playlistRequest}`, {
    code: 200,
    more: false,
    playlist: [{ id: 9, specialType: 5, trackCount: 0, creator: { userId: 42 } }],
  });
  mutable.playlist_detail = async () => ({
    status: 200,
    body: { code: 200, playlist: { trackCount: 0, creator: { userId: 42 }, trackIds: [] } },
  });

  try {
    const request = probeUser("42", undefined, join(tmpdir(), "missing-ncm-cookie"));
    const firstWave = await Promise.race([
      (async () => {
        while (started.size < 3) await new Promise((resolve) => setTimeout(resolve, 10));
        return true;
      })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 800)),
    ]);
    assert.equal(firstWave, true, "independent user reads should overlap instead of waiting serially");
    for (const release of releases.values()) release();
    const result = await request;
    assert.equal(result.profile.nickname, "user");
    assert.equal(result.record.status, "available");
    assert.equal(result.likes.status, "available");
    assert.equal(result.playlists.status, "available");
  } finally {
    mutable.user_detail = originals.user_detail;
    mutable.user_record = originals.user_record;
    mutable.user_playlist = originals.user_playlist;
    mutable.playlist_detail = originals.playlist_detail;
  }
});

test("reports liked songs available when explicit IDs are newer than declared counts", async () => {
  const mutable = upstream as unknown as {
    user_detail: () => Promise<unknown>;
    user_record: () => Promise<unknown>;
    user_playlist: () => Promise<unknown>;
    playlist_detail: () => Promise<unknown>;
  };
  const originals = {
    user_detail: mutable.user_detail,
    user_record: mutable.user_record,
    user_playlist: mutable.user_playlist,
    playlist_detail: mutable.playlist_detail,
  };
  mutable.user_detail = async () => ({
    status: 200,
    body: { code: 200, profile: { userId: 42, nickname: "user" } },
  });
  mutable.user_record = async () => ({ status: 200, body: { code: 200, allData: [] } });
  mutable.user_playlist = async () => ({
    status: 200,
    body: {
      code: 200,
      more: false,
      playlist: [{ id: 9, specialType: 5, trackCount: 1105, creator: { userId: 42 } }],
    },
  });
  mutable.playlist_detail = async () => ({
    status: 200,
    body: {
      code: 200,
      playlist: {
        creator: { userId: 42 },
        trackCount: 1105,
        trackIds: Array.from({ length: 1106 }, (_, index) => ({ id: index + 1 })),
      },
    },
  });

  try {
    const result = await probeUser("42", undefined, join(tmpdir(), "missing-stale-count-cookie"));
    assert.deepEqual(result.likes, { status: "available", songs: 1106 });
  } finally {
    mutable.user_detail = originals.user_detail;
    mutable.user_record = originals.user_record;
    mutable.user_playlist = originals.user_playlist;
    mutable.playlist_detail = originals.playlist_detail;
  }
});

test("reports a hidden NetEase liked playlist as privacy rather than cooldown", async () => {
  const mutable = upstream as unknown as {
    user_detail: () => Promise<unknown>;
    user_record: () => Promise<unknown>;
    user_playlist: () => Promise<unknown>;
  };
  const originals = {
    user_detail: mutable.user_detail,
    user_record: mutable.user_record,
    user_playlist: mutable.user_playlist,
  };
  mutable.user_detail = async () => ({
    status: 200,
    body: { code: 200, profile: { userId: 42, nickname: "private-user" } },
  });
  mutable.user_record = async () => ({ status: 200, body: { code: 200, allData: [] } });
  mutable.user_playlist = async () => ({ status: 200, body: { code: 200, more: false, playlist: [] } });

  try {
    const result = await probeUser("42", undefined, join(tmpdir(), "missing-private-ncm-cookie"));
    assert.equal(result.record.status, "available");
    assert.equal(result.likes.status, "private");
    assert.match(result.likes.error || "", /隐私/);
  } finally {
    mutable.user_detail = originals.user_detail;
    mutable.user_record = originals.user_record;
    mutable.user_playlist = originals.user_playlist;
  }
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
  assert.equal(restored.task.version, 4);
  assert.equal(restored.task.platform, "netease");
  assert.equal(restored.task.requestIntervalSemantics, "per-start-v1");
  assert.equal(restored.task.input.minDelayMs, 111);
  assert.equal(restored.task.input.jitterMs, 34);
  assert.equal(restored.task.input.songId, descriptor.input.songId);
  assert.equal(restored.task.input.includeCommentFloors, true);
  assert.deepEqual(restored.adjustments, ["netease-request-spacing-per-start-v1", "netease-comment-scope-root-and-floor-v1"]);
  const persisted = JSON.parse(await readFile(join(dataDirectory, "resume-task.json"), "utf8")) as {
    version: number;
    requestIntervalSemantics: string;
  };
  assert.equal(persisted.version, 4);
  assert.equal(persisted.requestIntervalSemantics, "per-start-v1");
  const second = await fetch(`http://127.0.0.1:${address.port}/api/resume`);
  assert.equal(second.status, 200);
  const secondValue = await second.json() as { task: { version: number }; adjustments?: string[] };
  assert.equal(secondValue.task.version, 4);
  assert.equal(secondValue.adjustments, undefined);
});

test("current scoped descriptors are never migrated twice", () => {
  const descriptor = {
    version: 4 as const,
    platform: "netease" as const,
    mode: "parallel" as const,
    requestIntervalSemantics: "per-start-v1" as const,
    updatedAt: "2026-08-08T00:00:00.000Z",
    input: { uid: "42", songId: "186016", includeCommentFloors: false, workersPerProxy: 3, minDelayMs: 111, jitterMs: 34 },
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
  assert.equal(restored.task.version, 4);
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
  assert.equal(value.task.version, 4);
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
  assert.equal(restored.task.version, 4);
  assert.equal(restored.task.platform, "netease");
  assert.equal(restored.task.input.uid, "42");
  assert.equal(restored.task.input.minDelayMs, 2_500);
  assert.equal(restored.task.input.jitterMs, 800);
  assert.equal(restored.task.input.includeCommentFloors, true);
  assert.deepEqual(restored.adjustments, ["netease-request-spacing-per-start-v1", "netease-comment-scope-root-and-floor-v1"]);
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
