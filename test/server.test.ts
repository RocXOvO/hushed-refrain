import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDashboard, validateClashConfigSelection } from "../src/server";
import type { ProxyPoolFile } from "../src/mihomo-pool";

test("dashboard serves UI assets and estimate API", async (context) => {
  const server = await startDashboard({ host: "127.0.0.1", port: 0 });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const pageText = await page.text();
  assert.match(pageText, /云评检索台/);
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
  assert.match(pageText, /id="songProgressBar"/);
  assert.match(pageText, /主机保护/);
  assert.match(pageText, /允许本机直连/);
  assert.match(pageText, /id="logsPanel"/);
  assert.match(pageText, /IPv4 \/24.*IPv6 \/48/);
  assert.match(pageText, /id="poolSize"[^>]*max="32"[^>]*value="8"/);
  assert.match(pageText, /id="poolCandidates"[^>]*max="128"[^>]*value="48"/);
  assert.match(pageText, /name="pageSize"[^>]*max="2000"[^>]*value="1000"/);
  assert.doesNotMatch(pageText, /首条命中后/);

  const app = await fetch(`${base}/app.js`);
  assert.equal(app.status, 200);
  const appText = await app.text();
  assert.match(appText, /year:\s*"numeric"/);
  assert.match(appText, /current\.totalComments/);
  assert.match(appText, /clockDuration/);
  assert.match(appText, /renderRuntimeTimer/);
  assert.match(appText, /proxyTransportMaxConcurrent/);
  assert.match(appText, /observeTaskSettlement/);
  assert.match(appText, /\/api\/logs\?mode=/);
  assert.match(appText, /prepareTaskForUpdate/);
  assert.match(appText, /\/api\/resume/);
  assert.match(appText, /保存进度并重启/);
  assert.match(appText, /if \(refreshInFlight\) return refreshInFlight/);
  assert.match(appText, /scheduleResultsRender/);
  assert.match(appText, /Date\.now\(\) - lastLogsRefreshAt < 3_000/);
  assert.match(appText, /poolStatus === "starting"/);
  assert.match(appText, /syncTaskStartAvailability/);
  assert.doesNotMatch(appText, /setInterval\(\(\) => void refresh\(\), 1500\)/);

  const icon = await fetch(`${base}/icons/search.svg`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type") ?? "", /image\/svg\+xml/);

  const styles = await fetch(`${base}/styles.css`);
  assert.equal(styles.status, 200);
  const styleText = await styles.text();
  assert.match(styleText, /scrollbar-color:/);
  assert.match(styleText, /::-webkit-scrollbar-thumb/);

  const estimate = await fetch(`${base}/api/estimate?comments=500000`);
  assert.equal(estimate.status, 200);
  const value = await estimate.json() as { pages: number; expectedSeconds: number };
  assert.equal(value.pages, 500);
  assert.equal(value.expectedSeconds, 1_450);

  const pooledEstimate = await fetch(`${base}/api/estimate?comments=100000&pageSize=100&minDelayMs=2500&jitterMs=800&networkMs=400&lanes=4&workersPerLane=1`);
  assert.equal(pooledEstimate.status, 200);
  const pooledValue = await pooledEstimate.json() as { expectedSeconds: number; totalWorkers: number };
  assert.equal(pooledValue.expectedSeconds, 725);
  assert.equal(pooledValue.totalWorkers, 4);

  const parallelEstimate = await fetch(`${base}/api/estimate?comments=100000&pageSize=1000&minDelayMs=333&jitterMs=100&networkMs=400&lanes=4&workersPerLane=3`);
  assert.equal(parallelEstimate.status, 200);
  const parallelValue = await parallelEstimate.json() as { pages: number; expectedSeconds: number; totalWorkers: number };
  assert.equal(parallelValue.pages, 100);
  assert.equal(parallelValue.expectedSeconds, 4);
  assert.equal(parallelValue.totalWorkers, 12);

  const protectedEstimate = await fetch(`${base}/api/estimate?comments=100000&pageSize=1000&minDelayMs=333&jitterMs=100&networkMs=400&lanes=4&workersPerLane=3&proxyTransport=1`);
  const protectedValue = await protectedEstimate.json() as { expectedSeconds: number; effectiveWorkers: number; proxyTransportMaxConcurrent: number };
  assert.equal(protectedValue.expectedSeconds, 8);
  assert.equal(protectedValue.effectiveWorkers, 8);
  assert.equal(protectedValue.proxyTransportMaxConcurrent, 8);
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
    ["/profiles/a.yaml", "/profiles/b.yaml"],
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
  assert.deepEqual(await response.json(), { task: descriptor });
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
    releaseName: "云评检索台 v0.2.0",
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

  const protectedDirect = await fetch(`http://127.0.0.1:${address.port}/api/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: "42", source: "record", recordScope: "all", allowDirect: false }),
  });
  assert.equal(protectedDirect.status, 409);
  assert.match(await protectedDirect.text(), /允许本机直连/);
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
