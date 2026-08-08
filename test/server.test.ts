import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  isLoopbackAddress,
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
  assert.match(pageText, /云评检索台/);
  assert.match(pageText, /WORKSPACE UI/);
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
  assert.match(pageText, /主机并发会硬性限制总 Worker 数/);
  assert.match(pageText, /styles\.css\?v=41/);
  assert.match(pageText, /app\.js\?v=45/);
  assert.match(pageText, /id="platformSwitch"/);
  assert.match(pageText, /id="qqSongForm"/);
  assert.match(pageText, /id="qqLikesForm"/);
  assert.match(pageText, /name="pageSize"[^>]*max="25"[^>]*value="25"/);
  assert.match(pageText, /name="likedPageSize"[^>]*max="500"[^>]*value="500"/);
  assert.match(pageText, /QQ 音乐使用独立 Gate（最多 4 个在途、启动间隔至少 250ms）/);
  assert.match(pageText, /id="settlementFootnote"/);
  assert.match(pageText, /id="settlementCoverage"/);
  assert.match(pageText, /id="speedMetric"/);
  assert.match(pageText, /id="poolStateIndicator"[^>]*role="status"[^>]*aria-live="polite"/);
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
  assert.match(appText, /activateNavigation/);
  assert.match(appText, /syncToolbarContext/);
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
  assert.match(appText, /个有界 Worker · 最多/);
  assert.match(appText, /Math\.min\(lanes \* workers, hostConcurrency\)/);
  assert.match(appText, /baselineIds/);
  assert.match(appText, /tabSwitchVersion/);
  assert.match(appText, /renderActiveSongs/);
  assert.match(appText, /renderSongReadProgress/);
  assert.match(appText, /refreshActiveSongRequestAges/);
  assert.match(appText, /个分片请求中/);
  assert.match(appText, /inspectorOverlayQuery\.addEventListener\("change"/);
  assert.match(appText, /时间覆盖/);
  assert.match(appText, /topologyCapacityNote/);
  assert.match(appText, /Worker 活跃/);
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
  assert.doesNotMatch(appText, /当前生效配置（合并）/);
  assert.doesNotMatch(appText, /resultTimestamp/);
  assert.doesNotMatch(appText, /setInterval\(\(\) => void refresh\(\), 1500\)/);

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
  assert.match(styleText, /body\.inspector-collapsed \.inspector-heading > div\s*\{[^}]*position:\s*absolute/s);
  assert.match(styleText, /\.inspector-body\s*\{[^}]*transition:/s);
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

  const pooledEstimate = await fetch(`${base}/api/estimate?comments=100000&pageSize=100&minDelayMs=2500&jitterMs=800&networkMs=400&lanes=4&workersPerLane=1`);
  assert.equal(pooledEstimate.status, 200);
  const pooledValue = await pooledEstimate.json() as { expectedSeconds: number; totalWorkers: number };
  assert.equal(pooledValue.expectedSeconds, 725);
  assert.equal(pooledValue.totalWorkers, 4);

  const parallelEstimate = await fetch(`${base}/api/estimate?comments=100000&pageSize=1000&minDelayMs=333&jitterMs=100&networkMs=400&lanes=4&workersPerLane=3`);
  assert.equal(parallelEstimate.status, 200);
  const parallelValue = await parallelEstimate.json() as { pages: number; expectedSeconds: number; totalWorkers: number };
  assert.equal(parallelValue.pages, 100);
  assert.equal(parallelValue.expectedSeconds, 5);
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
  assert.equal(qqEstimateValue.effectiveWorkers, 4);
  assert.equal(qqEstimateValue.checkpointSlots, 4);
  assert.equal(qqEstimateValue.proxyTransportMaxConcurrent, 4);
  assert.equal(qqEstimateValue.proxyTransportStartDelayMs, 250);
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
  assert.deepEqual(await response.json(), { task: descriptor });
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
  const value = await response.json() as { task: typeof descriptor; adjustments: string[] };
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
