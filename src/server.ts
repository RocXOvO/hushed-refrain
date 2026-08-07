import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { EnhancedNcmClient, type NcmUserProfile } from "./api";
import { CooldownRequired } from "./errors";
import { estimateCommentScan } from "./estimate";
import { RequestGovernor } from "./governor";
import {
  defaultMihomoPoolOptions,
  discoverClashVerge,
  importExternalProxyPool,
  proxyPoolRunning,
  readProxyPool,
  refreshProxyPool,
  startMihomoPool,
  stopMihomoPool,
  verifyProxyPool,
  type ProxyPoolEntry,
  type ProxyPoolFile,
  type ProxyPoolSource,
} from "./mihomo-pool";
import {
  loadParallelState,
  runParallelSongScan,
  type ParallelCommentLane,
} from "./parallel-scanner";
import { runPooledCommentFinder, type SourceScanLane } from "./scanner";
import { loadState } from "./state";
import type {
  FoundComment,
  ParallelSongScanReport,
  RunReport,
  ScanOptions,
  SourceSelection,
} from "./types";
import { checkForUpdate, type UpdateSnapshot } from "./update";

export interface DashboardOptions {
  host: string;
  port: number;
  runtimeRoot?: string;
  currentVersion?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  updateChecker?: () => Promise<UpdateSnapshot>;
  poolRefreshIntervalMs?: number;
  poolRefresher?: typeof refreshProxyPool;
}

interface RuntimePaths {
  root: string;
  data: string;
  ncm: string;
  cookie: string;
  qr: string;
  pool: string;
  poolWork: string;
}

type JobStatus = "idle" | "running" | "stopping" | RunReport["status"] | "error";

interface JobSnapshot {
  id?: string;
  status: JobStatus;
  uid?: string;
  source?: SourceSelection;
  recordScope?: "all" | "week";
  startedAt?: string;
  finishedAt?: string;
  songs: number;
  songsProcessed: number;
  commentOffset: number;
  currentSong?: { id: string; name?: string };
  matches: number;
  requestsTotal: number;
  pagesProcessed: number;
  lanes: number;
  workers: number;
  coverageComplete: boolean;
  sourceErrors: string[];
  blockedUntil?: string;
  proxyEnabled: boolean;
  error?: string;
  note?: string;
}

interface ParallelJobSnapshot {
  id?: string;
  status: "idle" | "running" | "stopping" | ParallelSongScanReport["status"] | "error";
  uid?: string;
  songId?: string;
  songName?: string;
  startedAt?: string;
  finishedAt?: string;
  lanes: number;
  workers: number;
  shards: number;
  shardsComplete: number;
  pagesProcessed: number;
  commentsInspected: number;
  matches: number;
  requestsTotal: number;
  elapsedMs: number;
  note?: string;
  error?: string;
}

interface StartJobInput {
  uid?: unknown;
  source?: unknown;
  recordScope?: unknown;
  pageSize?: unknown;
  requestBudget?: unknown;
  minDelayMs?: unknown;
  jitterMs?: unknown;
  forbiddenCooldownMs?: unknown;
  maxCommentPagesPerSong?: unknown;
  maxSongs?: unknown;
  stopAfterFirst?: unknown;
  fresh?: unknown;
  dryRun?: unknown;
  proxy?: unknown;
  workersPerProxy?: unknown;
}

interface StartParallelInput {
  uid?: unknown;
  songId?: unknown;
  workersPerProxy?: unknown;
  shards?: unknown;
  pageSize?: unknown;
  requestBudget?: unknown;
  maxPages?: unknown;
  minDelayMs?: unknown;
  jitterMs?: unknown;
  forbiddenCooldownMs?: unknown;
  stopAfterFirst?: unknown;
  fresh?: unknown;
}

interface AuthSnapshot {
  status: "idle" | "creating" | "waiting" | "scanned" | "authorized" | "expired" | "error";
  cookiePresent: boolean;
  qrImageUrl?: string;
  error?: string;
}

interface SourceProbe {
  status: "available" | "restricted" | "cooldown";
  songs?: number;
  error?: string;
}

interface UserProbe {
  profile: NcmUserProfile;
  record: SourceProbe;
  likes: SourceProbe;
  sessionPresent: boolean;
  elapsedMs: number;
}

interface PoolSnapshot {
  status: "running" | "not-running" | "starting";
  poolPath: string;
  source?: ProxyPoolSource;
  pid?: number;
  generatedAt?: string;
  lastCheckedAt?: string;
  refreshing: boolean;
  refreshError?: string;
  sourceConfigPath?: string;
  entries: ProxyPoolEntry[];
  discovery: ReturnType<typeof discoverClashVerge>;
}

type MatchSubscriber = (comment: FoundComment) => void;

const projectRoot = resolve(__dirname, "..");
const webRoot = join(projectRoot, "web");
const iconRoot = join(projectRoot, "node_modules", "lucide-static", "icons");

class JobManager {
  private snapshotValue: JobSnapshot = emptySnapshot();
  private lanes: SourceScanLane[] = [];
  private statePath?: string;
  private outputPath?: string;
  private readonly matchSubscribers = new Set<MatchSubscriber>();

  constructor(private readonly paths: RuntimePaths) {}

  async start(input: StartJobInput): Promise<JobSnapshot> {
    if (["running", "stopping"].includes(this.snapshotValue.status)) {
      throw new HttpError(409, "已有任务正在运行。");
    }
    const uid = numericId(input.uid, "UID");
    const source = selection(input.source, ["record", "likes", "both"] as const, "source");
    const recordScope = selection(input.recordScope ?? "all", ["all", "week"] as const, "recordScope");
    const requestBudget = integer(input.requestBudget ?? 0, "requestBudget", 0, 100_000);
    const minDelayMs = integer(input.minDelayMs ?? 2_500, "minDelayMs", 0, 600_000);
    const jitterMs = integer(input.jitterMs ?? 800, "jitterMs", 0, 600_000);
    const commentPageSize = integer(input.pageSize ?? 1_000, "pageSize", 1, 2_000);
    const forbiddenCooldownMs = integer(input.forbiddenCooldownMs ?? 900_000, "forbiddenCooldownMs", 1_000, 86_400_000);
    const maxCommentPagesPerSong = integer(input.maxCommentPagesPerSong ?? 0, "maxCommentPagesPerSong", 0, 1_000_000);
    const maxSongs = integer(input.maxSongs ?? 0, "maxSongs", 0, 100_000);
    const workersPerLane = integer(input.workersPerProxy ?? 1, "workersPerProxy", 1, 8);
    const proxy = proxyUrl(input.proxy);
    const jobKey = `${uid}-${source}`;
    this.statePath = join(this.paths.data, `web-state-${jobKey}.json`);
    this.outputPath = join(this.paths.data, `web-comments-${uid}.jsonl`);
    const activePool = await readProxyPool(this.paths.pool);
    const poolEntries = activePool && proxyPoolRunning(activePool) ? await verifyProxyPool(activePool) : [];
    const endpoints = poolEntries.length > 0 ? poolEntries.map((entry) => entry.endpoint) : [proxy];
    this.lanes = endpoints.map((endpoint, index) => ({
      name: poolEntries[index]?.name ?? (endpoint ? "static-proxy" : "direct"),
      client: new EnhancedNcmClient({ proxy: endpoint }),
      governor: new RequestGovernor({
        requestBudget: requestBudget === 0 ? 0 : Math.max(1_000, requestBudget * 2),
        concurrency: workersPerLane,
        minDelayMs,
        jitterMs,
        maxRetries: 3,
        forbiddenCooldownMs,
      }),
    }));
    const options: ScanOptions = {
      uid,
      strategy: "scan",
      source,
      recordScope,
      cookie: await readCookie(this.paths.cookie),
      statePath: this.statePath,
      outputPath: this.outputPath,
      commentPageSize,
      historyPageSize: 50,
      maxCommentPagesPerSong,
      maxSongs,
      stopAfterFirst: false,
      fresh: bool(input.fresh),
      dryRun: bool(input.dryRun),
      onMatch: (comment) => this.publishMatch(comment),
    };
    this.snapshotValue = {
      ...emptySnapshot(), id: randomUUID(), status: "running", uid, source, recordScope,
      startedAt: new Date().toISOString(), proxyEnabled: poolEntries.length > 0 || Boolean(proxy),
      lanes: this.lanes.length, workers: this.lanes.length * workersPerLane,
    };
    const activeId = this.snapshotValue.id;
    void runPooledCommentFinder(this.lanes, { ...options, workersPerLane, requestBudget })
      .then((report) => {
        if (this.snapshotValue.id !== activeId) return;
        this.snapshotValue = {
          ...this.snapshotValue, status: report.status, finishedAt: new Date().toISOString(),
          songs: report.songs, songsProcessed: report.songsProcessed, matches: report.matches,
          requestsTotal: report.requestsTotal, coverageComplete: report.coverageComplete,
          pagesProcessed: report.pagesProcessed ?? 0, lanes: report.lanes ?? this.snapshotValue.lanes,
          workers: report.workers ?? this.snapshotValue.workers,
          sourceErrors: report.sourceErrors, blockedUntil: report.resumeAfter, note: report.note,
        };
      })
      .catch((error) => this.fail(activeId, error))
      .finally(() => { if (this.snapshotValue.id === activeId) this.lanes = []; });
    return this.status();
  }

  async stop(): Promise<JobSnapshot> {
    if (this.snapshotValue.status !== "running") return this.status();
    this.snapshotValue.status = "stopping";
    for (const lane of this.lanes) lane.governor.cancel();
    return this.status();
  }

  async status(): Promise<JobSnapshot> {
    if (this.statePath && this.snapshotValue.status !== "idle") {
      const state = await loadState(this.statePath);
      if (state && state.uid === this.snapshotValue.uid) {
        const progress = state.songProgress ?? [];
        const currentIndex = progress.length > 0 ? progress.findIndex((item) => !item.done) : state.songIndex;
        const current = currentIndex < 0 ? undefined : state.songs[currentIndex];
        this.snapshotValue = {
          ...this.snapshotValue, songs: state.songs.length,
          songsProcessed: progress.length > 0 ? progress.filter((item) => item.done).length : state.songIndex,
          commentOffset: currentIndex < 0 ? 0 : progress[currentIndex]?.commentOffset ?? state.commentOffset,
          currentSong: current ? { id: current.id, name: current.name } : undefined,
          matches: state.matchCount, requestsTotal: state.requestCount,
          pagesProcessed: state.pagesProcessed ?? 0,
          coverageComplete: state.coverageComplete, sourceErrors: state.sourceErrors,
          blockedUntil: state.blockedUntil,
        };
      }
    }
    return { ...this.snapshotValue, sourceErrors: [...this.snapshotValue.sourceErrors] };
  }

  results(limit: number): Promise<FoundComment[]> { return readJsonl(this.outputPath, limit); }

  subscribeMatches(subscriber: MatchSubscriber): () => void {
    this.matchSubscribers.add(subscriber);
    return () => this.matchSubscribers.delete(subscriber);
  }

  private publishMatch(comment: FoundComment): void {
    for (const subscriber of this.matchSubscribers) {
      try { subscriber(comment); } catch { /* One disconnected UI must not block other subscribers. */ }
    }
  }

  private fail(activeId: string | undefined, error: unknown): void {
    if (this.snapshotValue.id !== activeId) return;
    this.snapshotValue = { ...this.snapshotValue, status: "error", finishedAt: new Date().toISOString(), error: message(error) };
  }
}

class ParallelJobManager {
  private snapshotValue: ParallelJobSnapshot = emptyParallelSnapshot();
  private lanes: ParallelCommentLane[] = [];
  private statePath?: string;
  private outputPath?: string;
  private readonly matchSubscribers = new Set<MatchSubscriber>();

  constructor(private readonly paths: RuntimePaths) {}

  async start(input: StartParallelInput): Promise<ParallelJobSnapshot> {
    if (["running", "stopping"].includes(this.snapshotValue.status)) {
      throw new HttpError(409, "已有单曲并行任务正在运行。");
    }
    const uid = numericId(input.uid, "UID");
    const songId = numericId(input.songId, "歌曲 ID");
    const workersPerLane = integer(input.workersPerProxy ?? 3, "workersPerProxy", 1, 16);
    const shardCount = integer(input.shards ?? 96, "shards", 1, 512);
    const pageSize = integer(input.pageSize ?? 1_000, "pageSize", 1, 2_000);
    const requestBudget = integer(input.requestBudget ?? 0, "requestBudget", 0, 100_000);
    const maxPages = integer(input.maxPages ?? 0, "maxPages", 0, 1_000_000);
    const minDelayMs = integer(input.minDelayMs ?? 333, "minDelayMs", 0, 600_000);
    const jitterMs = integer(input.jitterMs ?? 100, "jitterMs", 0, 600_000);
    const forbiddenCooldownMs = integer(input.forbiddenCooldownMs ?? 900_000, "forbiddenCooldownMs", 1_000, 86_400_000);
    const pool = await readProxyPool(this.paths.pool);
    if (!pool || !proxyPoolRunning(pool)) throw new HttpError(409, "代理池尚未运行。");
    const entries = await verifyProxyPool(pool);
    this.lanes = entries.map((entry, index) => ({
      name: `proxy-${index + 1}`,
      client: new EnhancedNcmClient({ proxy: entry.endpoint }),
      governor: new RequestGovernor({
        requestBudget: requestBudget === 0 ? 0 : Math.max(1_000, requestBudget * 2), concurrency: workersPerLane, minDelayMs, jitterMs,
        maxRetries: 2, forbiddenCooldownMs,
      }),
    }));
    const song = await this.lanes[0].governor.execute(`song_detail:${songId}`, () => this.lanes[0].client.getSongInfo(songId));
    const previousPath = join(this.paths.data, `parallel-state-${uid}-${songId}.json`);
    const previous = bool(input.fresh) ? undefined : await loadParallelState(previousPath);
    this.statePath = previousPath;
    this.outputPath = join(this.paths.data, `parallel-comments-${uid}-${songId}.jsonl`);
    this.snapshotValue = {
      ...emptyParallelSnapshot(), id: randomUUID(), status: "running", uid, songId,
      songName: song.name, startedAt: new Date().toISOString(), lanes: this.lanes.length,
      workers: this.lanes.length * workersPerLane, shards: shardCount,
    };
    const activeId = this.snapshotValue.id;
    void runParallelSongScan(this.lanes, {
      uid, songId, songName: song.name, startTime: previous?.startTime ?? song.publishTime ?? Date.UTC(2000, 0, 1),
      endTime: previous?.endTime ?? Date.now(), shardCount, pageSize, workersPerLane,
      requestBudget, maxPages, stopAfterFirst: false,
      fresh: bool(input.fresh), statePath: this.statePath, outputPath: this.outputPath,
      onMatch: (comment) => this.publishMatch(comment),
    }).then((report) => {
      if (this.snapshotValue.id !== activeId) return;
      this.snapshotValue = {
        ...this.snapshotValue, ...report, status: report.status,
        finishedAt: new Date().toISOString(), note: report.note,
      };
    }).catch((error) => {
      if (this.snapshotValue.id !== activeId) return;
      this.snapshotValue = { ...this.snapshotValue, status: "error", finishedAt: new Date().toISOString(), error: message(error) };
    }).finally(() => { if (this.snapshotValue.id === activeId) this.lanes = []; });
    return this.status();
  }

  async stop(): Promise<ParallelJobSnapshot> {
    if (this.snapshotValue.status !== "running") return this.status();
    this.snapshotValue.status = "stopping";
    for (const lane of this.lanes) lane.governor.cancel();
    return this.status();
  }

  async status(): Promise<ParallelJobSnapshot> {
    if (this.statePath && this.snapshotValue.status !== "idle") {
      const state = await loadParallelState(this.statePath);
      if (state && state.uid === this.snapshotValue.uid && state.songId === this.snapshotValue.songId) {
        this.snapshotValue = {
          ...this.snapshotValue, shards: state.shards.length,
          shardsComplete: state.shards.filter((item) => item.done).length,
          pagesProcessed: state.pagesProcessed, commentsInspected: state.commentsInspected,
          matches: state.matchCount, requestsTotal: state.requestCount,
          elapsedMs: this.snapshotValue.startedAt ? Date.now() - Date.parse(this.snapshotValue.startedAt) : 0,
        };
      }
    }
    return { ...this.snapshotValue };
  }

  results(limit: number): Promise<FoundComment[]> { return readJsonl(this.outputPath, limit); }

  subscribeMatches(subscriber: MatchSubscriber): () => void {
    this.matchSubscribers.add(subscriber);
    return () => this.matchSubscribers.delete(subscriber);
  }

  private publishMatch(comment: FoundComment): void {
    for (const subscriber of this.matchSubscribers) {
      try { subscriber(comment); } catch { /* One disconnected UI must not block other subscribers. */ }
    }
  }
}

class PoolManager {
  private starting = false;
  private refreshPromise?: Promise<void>;
  private nextRefreshAt = 0;
  private refreshError?: string;

  constructor(
    private readonly paths: RuntimePaths,
    private readonly refreshIntervalMs: number,
    private readonly refresher: typeof refreshProxyPool,
  ) {}

  async status(): Promise<PoolSnapshot> {
    const pool = await readProxyPool(this.paths.pool);
    const running = proxyPoolRunning(pool);
    if (!this.starting && running && pool) this.scheduleRefresh(pool);
    return {
      status: this.starting ? "starting" : running ? "running" : "not-running",
      poolPath: this.paths.pool,
      source: pool?.source,
      pid: pool?.pid,
      generatedAt: pool?.generatedAt,
      lastCheckedAt: pool?.lastCheckedAt ?? pool?.generatedAt,
      refreshing: Boolean(this.refreshPromise),
      refreshError: this.refreshError,
      sourceConfigPath: pool?.sourceConfigPath,
      entries: publicPoolEntries(pool?.entries ?? []),
      discovery: discoverClashVerge(),
    };
  }

  async start(input: Record<string, unknown>): Promise<PoolSnapshot> {
    if (this.starting) throw new HttpError(409, "代理池正在构建。");
    this.starting = true;
    try {
      const defaults = defaultMihomoPoolOptions(this.paths.root);
      await startMihomoPool({
        ...defaults,
        sourceConfigPath: selectedClashConfigPath(input.sourceConfigPath) ?? defaults.sourceConfigPath,
        mihomoPath: optionalPath(input.mihomoPath) ?? defaults.mihomoPath,
        workDirectory: this.paths.poolWork,
        poolPath: this.paths.pool,
        size: integer(input.size ?? defaults.size, "size", 1, 32),
        candidateCount: integer(input.candidates ?? defaults.candidateCount, "candidates", 1, 128),
      });
      this.nextRefreshAt = Date.now() + this.refreshIntervalMs;
      this.refreshError = undefined;
      return this.status();
    } finally { this.starting = false; }
  }

  async import(input: Record<string, unknown>): Promise<PoolSnapshot> {
    if (this.starting) throw new HttpError(409, "代理池正在验证。");
    this.starting = true;
    try {
      const endpoints = proxyEndpoints(input.proxies);
      const size = integer(input.size ?? 0, "size", 0, 64);
      await importExternalProxyPool(endpoints, this.paths.pool, size);
      this.nextRefreshAt = Date.now() + this.refreshIntervalMs;
      this.refreshError = undefined;
      return this.status();
    } finally { this.starting = false; }
  }

  async stop(): Promise<PoolSnapshot> {
    await stopMihomoPool(this.paths.pool);
    this.nextRefreshAt = 0;
    this.refreshError = undefined;
    return this.status();
  }

  private scheduleRefresh(pool: ProxyPoolFile): void {
    if (this.refreshPromise) return;
    const lastCheckedAt = Date.parse(pool.lastCheckedAt ?? pool.generatedAt);
    const persistedDueAt = Number.isFinite(lastCheckedAt)
      ? lastCheckedAt + this.refreshIntervalMs
      : 0;
    const now = Date.now();
    if (now < Math.max(this.nextRefreshAt, persistedDueAt)) return;

    this.nextRefreshAt = now + this.refreshIntervalMs;
    this.refreshPromise = this.refresher(this.paths.pool)
      .then(() => { this.refreshError = undefined; })
      .catch(() => {
        this.refreshError = "代理池后台复测暂时失败，将在下个周期重试。";
      })
      .finally(() => { this.refreshPromise = undefined; });
  }
}

class AuthManager {
  private snapshotValue: AuthSnapshot = { status: "idle", cookiePresent: false };
  private active = false;
  constructor(private readonly paths: RuntimePaths) {}

  async status(): Promise<AuthSnapshot> {
    this.snapshotValue.cookiePresent = await exists(this.paths.cookie);
    return { ...this.snapshotValue };
  }
  async start(): Promise<AuthSnapshot> {
    if (this.active) return this.status();
    this.active = true;
    this.snapshotValue = { status: "creating", cookiePresent: await exists(this.paths.cookie) };
    const { qrLogin } = await import("./auth");
    void qrLogin({
      cookiePath: this.paths.cookie, qrPath: this.paths.qr, timeoutSeconds: 300,
      onReady: () => { this.snapshotValue = { ...this.snapshotValue, status: "waiting", qrImageUrl: `/api/auth/qr.png?t=${Date.now()}` }; },
      onStatus: (code) => {
        if (code === 802) this.snapshotValue.status = "scanned";
        if (code === 803) this.snapshotValue.status = "authorized";
        if (code === 800) this.snapshotValue.status = "expired";
      },
    }).then(() => { this.snapshotValue = { ...this.snapshotValue, status: "authorized", cookiePresent: true }; })
      .catch((error) => { this.snapshotValue = { ...this.snapshotValue, status: this.snapshotValue.status === "expired" ? "expired" : "error", error: message(error) }; })
      .finally(() => { this.active = false; });
    return this.status();
  }
}

export async function startDashboard(options: DashboardOptions): Promise<Server> {
  const paths = runtimePaths(options.runtimeRoot ?? projectRoot);
  const jobs = new JobManager(paths);
  const parallel = new ParallelJobManager(paths);
  const pool = new PoolManager(
    paths,
    options.poolRefreshIntervalMs ?? 60_000,
    options.poolRefresher ?? refreshProxyPool,
  );
  const auth = new AuthManager(paths);
  const currentVersion = options.currentVersion ?? await applicationVersion();
  const updateChecker = cachedUpdateChecker(options.updateChecker ?? (() => checkForUpdate({
    currentVersion,
    platform: options.platform,
    arch: options.arch,
  })));
  const server = createServer(async (request, response) => {
    try { await route(request, response, paths, jobs, parallel, pool, auth, updateChecker); }
    catch (error) { json(response, error instanceof HttpError ? error.status : 500, { error: message(error) }); }
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => { server.off("error", reject); done(); });
  });
  return server;
}

async function route(
  request: IncomingMessage, response: ServerResponse, paths: RuntimePaths,
  jobs: JobManager, parallel: ParallelJobManager, pool: PoolManager, auth: AuthManager,
  updateChecker: () => Promise<UpdateSnapshot>,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");
  if (method === "GET" && url.pathname === "/api/health") return json(response, 200, { ok: true, time: new Date().toISOString() });
  if (method === "GET" && url.pathname === "/api/update") return json(response, 200, await updateChecker());
  if (method === "GET" && url.pathname === "/api/job") return json(response, 200, await jobs.status());
  if (method === "POST" && url.pathname === "/api/job") return json(response, 202, await jobs.start(await body(request)));
  if (method === "POST" && url.pathname === "/api/job/stop") return json(response, 200, await jobs.stop());
  if (method === "GET" && url.pathname === "/api/results/stream") return streamMatches(request, response, (subscriber) => jobs.subscribeMatches(subscriber));
  if (method === "GET" && url.pathname === "/api/results") return json(response, 200, { results: await jobs.results(limit(url)) });
  if (method === "GET" && url.pathname === "/api/parallel/job") return json(response, 200, await parallel.status());
  if (method === "POST" && url.pathname === "/api/parallel/job") return json(response, 202, await parallel.start(await body(request)));
  if (method === "POST" && url.pathname === "/api/parallel/job/stop") return json(response, 200, await parallel.stop());
  if (method === "GET" && url.pathname === "/api/parallel/results/stream") return streamMatches(request, response, (subscriber) => parallel.subscribeMatches(subscriber));
  if (method === "GET" && url.pathname === "/api/parallel/results") return json(response, 200, { results: await parallel.results(limit(url)) });
  if (method === "GET" && url.pathname === "/api/pool") return json(response, 200, await pool.status());
  if (method === "POST" && url.pathname === "/api/pool/start") return json(response, 202, await pool.start(await body(request)));
  if (method === "POST" && url.pathname === "/api/pool/import") return json(response, 202, await pool.import(await body(request)));
  if (method === "POST" && url.pathname === "/api/pool/stop") return json(response, 200, await pool.stop());
  if (method === "GET" && url.pathname === "/api/song") {
    const song = await new EnhancedNcmClient({ proxy: proxyUrl(url.searchParams.get("proxy")) }).getSongInfo(numericId(url.searchParams.get("id"), "歌曲 ID"));
    return json(response, 200, song);
  }
  if (method === "GET" && url.pathname === "/api/estimate") {
    return json(response, 200, estimateCommentScan({
      comments: integer(url.searchParams.get("comments") ?? 100_000, "comments", 0, 100_000_000),
      pageSize: integer(url.searchParams.get("pageSize") ?? 1_000, "pageSize", 1, 2_000),
      minDelayMs: integer(url.searchParams.get("minDelayMs") ?? 2_500, "minDelayMs", 0, 600_000),
      jitterMs: integer(url.searchParams.get("jitterMs") ?? 800, "jitterMs", 0, 600_000),
      networkMs: integer(url.searchParams.get("networkMs") ?? 400, "networkMs", 0, 600_000),
      lanes: integer(url.searchParams.get("lanes") ?? 1, "lanes", 1, 256),
      workersPerLane: integer(url.searchParams.get("workersPerLane") ?? 1, "workersPerLane", 1, 16),
    }));
  }
  if (method === "GET" && url.pathname === "/api/user") {
    return json(response, 200, await probeUser(numericId(url.searchParams.get("uid"), "UID"), proxyUrl(url.searchParams.get("proxy")), paths.cookie));
  }
  if (method === "GET" && url.pathname === "/api/auth") return json(response, 200, await auth.status());
  if (method === "POST" && url.pathname === "/api/auth/qr") return json(response, 202, await auth.start());
  if (method === "GET" && url.pathname === "/api/auth/qr.png") return file(response, paths.qr, "image/png", false);
  if (method === "GET" && url.pathname.startsWith("/icons/")) {
    const name = url.pathname.slice(7);
    if (!/^[a-z0-9-]+\.svg$/.test(name)) throw new HttpError(404, "Not found");
    return file(response, join(iconRoot, name), "image/svg+xml", true);
  }
  if (method === "GET") {
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const path = resolve(webRoot, `.${pathname}`);
    if (path !== webRoot && !path.startsWith(`${webRoot}${sep}`)) throw new HttpError(404, "Not found");
    return file(response, path, mimeType(path), true);
  }
  throw new HttpError(404, "Not found");
}

function runtimePaths(root: string): RuntimePaths {
  const normalized = resolve(root);
  const ncm = join(normalized, ".ncm");
  return { root: normalized, data: join(normalized, "data"), ncm, cookie: join(ncm, "cookie.txt"), qr: join(ncm, "login-qr.png"), pool: join(ncm, "proxy-pool.json"), poolWork: join(ncm, "mihomo-pool") };
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk); size += buffer.length;
    if (size > 64 * 1024) throw new HttpError(413, "请求体过大。");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
  catch { throw new HttpError(400, "JSON 格式错误。"); }
}

async function file(response: ServerResponse, path: string, contentType: string, cache: boolean): Promise<void> {
  if (!(await exists(path))) throw new HttpError(404, "Not found");
  response.writeHead(200, {
    "Content-Type": contentType, "Cache-Control": cache ? "public, max-age=300" : "no-store",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
    "X-Content-Type-Options": "nosniff",
  });
  await new Promise<void>((done, reject) => {
    const stream = createReadStream(path); stream.on("error", reject); stream.on("end", done); stream.pipe(response);
  });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(`${JSON.stringify(value)}\n`);
}

function streamMatches(
  request: IncomingMessage,
  response: ServerResponse,
  subscribe: (subscriber: MatchSubscriber) => () => void,
): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  response.write(": connected\n\n");
  const unsubscribe = subscribe((comment) => {
    if (!response.destroyed) response.write(`event: match\ndata: ${JSON.stringify(comment)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    if (!response.destroyed) response.write(": keep-alive\n\n");
  }, 15_000);
  heartbeat.unref();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    if (!response.destroyed) response.end();
  };
  request.once("aborted", close);
  response.once("close", close);
}

async function readCookie(path: string): Promise<string | undefined> {
  if (process.env.NCM_COOKIE?.trim()) return process.env.NCM_COOKIE.trim();
  try { return (await readFile(path, "utf8")).trim() || undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function applicationVersion(): Promise<string> {
  const value = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof value.version !== "string" || !value.version.trim()) throw new Error("应用版本号配置缺失。");
  return value.version.trim();
}

function cachedUpdateChecker(checker: () => Promise<UpdateSnapshot>): () => Promise<UpdateSnapshot> {
  let cached: { value: UpdateSnapshot; expiresAt: number } | undefined;
  let pending: Promise<UpdateSnapshot> | undefined;
  return async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (!pending) {
      pending = checker()
        .then((value) => {
          cached = { value, expiresAt: Date.now() + 5 * 60_000 };
          return value;
        })
        .finally(() => { pending = undefined; });
    }
    return pending;
  };
}

async function probeUser(uid: string, proxy: string | undefined, cookiePath: string): Promise<UserProbe> {
  const started = Date.now();
  const cookie = await readCookie(cookiePath);
  const client = new EnhancedNcmClient({ proxy });
  const governor = new RequestGovernor({ requestBudget: 3, minDelayMs: 800, jitterMs: 200, maxRetries: 1, forbiddenCooldownMs: 900_000 });
  const profile = await governor.execute("user_detail", () => client.getUserProfile(uid, cookie));
  const inspect = async (source: "record" | "likes"): Promise<SourceProbe> => {
    try {
      const songs = source === "record"
        ? await governor.execute("user_record", () => client.getUserRecord(uid, "all", cookie))
        : await governor.execute("likelist", () => client.getLikedSongs(uid, cookie));
      return { status: "available", songs: songs.length };
    } catch (error) { return { status: error instanceof CooldownRequired ? "cooldown" : "restricted", error: message(error) }; }
  };
  const record = await inspect("record");
  const likes = record.status === "cooldown" ? { status: "cooldown" as const, error: "record probe entered cooldown" } : await inspect("likes");
  return { profile, record, likes, sessionPresent: Boolean(cookie), elapsedMs: Date.now() - started };
}

async function readJsonl(path: string | undefined, max: number): Promise<FoundComment[]> {
  if (!path) return [];
  try {
    return (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).slice(-max).flatMap((line) => {
      try { return [JSON.parse(line) as FoundComment]; } catch { return []; }
    }).reverse();
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function emptySnapshot(): JobSnapshot { return { status: "idle", songs: 0, songsProcessed: 0, commentOffset: 0, matches: 0, requestsTotal: 0, pagesProcessed: 0, lanes: 0, workers: 0, coverageComplete: false, sourceErrors: [], proxyEnabled: false }; }
function emptyParallelSnapshot(): ParallelJobSnapshot { return { status: "idle", lanes: 0, workers: 0, shards: 0, shardsComplete: 0, pagesProcessed: 0, commentsInspected: 0, matches: 0, requestsTotal: 0, elapsedMs: 0 }; }
function numericId(value: unknown, name: string): string { const id = String(value ?? "").trim(); if (!/^\d+$/.test(id)) throw new HttpError(400, `${name} 应为纯数字。`); return id; }
function selection<const T extends readonly string[]>(value: unknown, choices: T, name: string): T[number] { if (typeof value === "string" && choices.includes(value)) return value as T[number]; throw new HttpError(400, `${name} 参数错误。`); }
function integer(value: unknown, name: string, minimum: number, maximum: number): number { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new HttpError(400, `${name} 应为 ${minimum} 到 ${maximum} 之间的整数。`); return parsed; }
function bool(value: unknown): boolean { return value === true; }
function proxyUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, "代理地址格式错误。");
  try { const parsed = new URL(value); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(); return parsed.toString(); }
  catch { throw new HttpError(400, "代理地址需使用 http:// 或 https://。"); }
}
function proxyEndpoints(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
    ? value.split(/[\r\n,]+/)
    : [];
  const endpoints = values.map((item) => String(item).trim()).filter(Boolean);
  if (endpoints.length === 0) throw new HttpError(400, "请至少输入一个代理地址。");
  return endpoints.map((endpoint) => proxyUrl(endpoint)!);
}
function optionalPath(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, "路径格式错误。");
  return resolve(value.trim());
}
function selectedClashConfigPath(value: unknown): string | undefined {
  const path = optionalPath(value);
  if (!path) return undefined;
  const discovery = discoverClashVerge();
  const allowed = new Set([
    ...discovery.configCandidates,
    ...discovery.profiles.map((profile) => profile.path),
  ].map((candidate) => resolve(candidate)));
  if (!allowed.has(path)) throw new HttpError(400, "请选择 Clash Verge 已发现的代理配置。");
  return path;
}
function publicPoolEntries(entries: ProxyPoolEntry[]): ProxyPoolEntry[] {
  return entries.map((entry) => ({ ...entry, endpoint: maskProxyCredentials(entry.endpoint) }));
}
function maskProxyCredentials(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return endpoint;
  }
}
function limit(url: URL): number { return integer(url.searchParams.get("limit") ?? 20, "limit", 1, 200); }
function mimeType(path: string): string { return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" } as Record<string, string>)[extname(path).toLowerCase()] ?? "application/octet-stream"; }

class HttpError extends Error { constructor(public readonly status: number, message: string) { super(message); this.name = "HttpError"; } }
