import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { EnhancedNcmClient, type NcmUserProfile } from "./api";
import { CooldownRequired } from "./errors";
import { estimateCommentScan } from "./estimate";
import { RequestGovernor } from "./governor";
import { readJsonlTail } from "./jsonl-tail";
import { timeCoveragePercent } from "./progress";
import {
  DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT,
  DEFAULT_PROXY_TRANSPORT_START_DELAY_MS,
  executeProxyRequest,
  ProxyTransportGate,
} from "./proxy-transport-gate";
import {
  defaultMihomoPoolOptions,
  discoverClashVerge,
  importExternalProxyPool,
  proxyPoolRunning,
  proxyPoolStatusRunning,
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
import { taskElapsedMs, TaskCoordinator } from "./task-coordinator";
import { readTaskLog, TaskLogger } from "./task-log";
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
  poolDiscoveryIntervalMs?: number;
  poolDiscoverer?: typeof discoverClashVerge;
}

interface RuntimePaths {
  root: string;
  data: string;
  ncm: string;
  cookie: string;
  qr: string;
  pool: string;
  poolWork: string;
  resumeTask: string;
}

interface ResumeTaskDescriptor {
  version: 1;
  mode: "source" | "parallel";
  updatedAt: string;
  input: Record<string, string | number | boolean>;
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
  currentSong?: {
    id: string;
    name?: string;
    pageInSong?: number;
    commentsProcessed: number;
    totalComments?: number;
  };
  matches: number;
  requestsTotal: number;
  pagesProcessed: number;
  elapsedMs: number;
  logPath?: string;
  lanes: number;
  workers: number;
  proxyTransportMaxConcurrent?: number;
  proxyTransportStartDelayMs?: number;
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
  proxyTransportMaxConcurrent?: number;
  proxyTransportStartDelayMs?: number;
  shards: number;
  shardsComplete: number;
  coveragePercent: number;
  pagesProcessed: number;
  commentsInspected: number;
  totalComments?: number;
  matches: number;
  requestsTotal: number;
  elapsedMs: number;
  logPath?: string;
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
  allowDirect?: unknown;
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
  private transportGate?: ProxyTransportGate;
  private statePath?: string;
  private outputPath?: string;
  private terminalStateSyncedId?: string;
  private readonly matchSubscribers = new Set<MatchSubscriber>();

  constructor(
    private readonly paths: RuntimePaths,
    private readonly coordinator: TaskCoordinator,
  ) {}

  async start(input: StartJobInput): Promise<JobSnapshot> {
    const lease = this.coordinator.acquire("source");
    if (!lease) throw new HttpError(409, busyTaskMessage(this.coordinator));
    const startedAt = new Date().toISOString();
    let launched = false;
    try {
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
    const allowDirect = bool(input.allowDirect);
    const jobKey = `${uid}-${source}`;
    this.statePath = join(this.paths.data, `web-state-${jobKey}.json`);
    this.outputPath = join(this.paths.data, `web-comments-${uid}.jsonl`);
    const activePool = await readProxyPool(this.paths.pool);
    const activePoolExpected = Boolean(activePool && proxyPoolRunning(activePool));
    const poolEntries = activePoolExpected ? await verifyProxyPool(activePool!) : [];
    if (activePoolExpected && poolEntries.length === 0) {
      throw new HttpError(409, "代理池复核后没有可用出口；已阻止回退到本机直连，请重新构建代理池。");
    }
    if (!activePoolExpected && !proxy && !allowDirect) {
      throw new HttpError(409, "未检测到可用代理。为防止静默暴露本机出口，任务未启动；请先运行代理池、填写单代理，或明确勾选允许本机直连。");
    }
    const endpoints = poolEntries.length > 0 ? poolEntries.map((entry) => entry.endpoint) : [proxy];
    this.transportGate = endpoints.some(Boolean) ? new ProxyTransportGate() : undefined;
    this.lanes = endpoints.map((endpoint, index) => ({
      name: poolEntries[index]?.name ?? (endpoint ? "static-proxy" : "direct"),
      client: new EnhancedNcmClient({ proxy: endpoint }),
      transportGate: this.transportGate,
      governor: new RequestGovernor({
        requestBudget: requestBudget === 0 ? 0 : Math.max(1_000, requestBudget * 2),
        concurrency: workersPerLane,
        minDelayMs,
        jitterMs,
        maxRetries: 3,
        forbiddenCooldownMs,
      }),
    }));
    const activeId = randomUUID();
    const logger = new TaskLogger(
      join(this.paths.data, "logs", `source-${activeId}.jsonl`),
      "source",
      activeId,
    );
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
      onRequestActivity: (activity) => logger.request(activity),
      onSongProgress: (activity) => {
        if (this.snapshotValue.id !== activeId || this.snapshotValue.status !== "running") return;
        this.snapshotValue = {
          ...this.snapshotValue,
          currentSong: {
            id: activity.songId,
            name: activity.songName,
            pageInSong: activity.pageInSong,
            commentsProcessed: activity.commentsProcessed,
            totalComments: activity.totalComments,
          },
        };
      },
    };
    this.snapshotValue = {
      ...emptySnapshot(), id: activeId, status: "running", uid, source, recordScope,
      startedAt, proxyEnabled: poolEntries.length > 0 || Boolean(proxy),
      lanes: this.lanes.length, workers: this.lanes.length * workersPerLane,
      proxyTransportMaxConcurrent: this.transportGate ? DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT : undefined,
      proxyTransportStartDelayMs: this.transportGate ? DEFAULT_PROXY_TRANSPORT_START_DELAY_MS : undefined,
      logPath: logger.path,
    };
    this.terminalStateSyncedId = undefined;
    await logger.write("info", "task_started", "用户来源扫描已启动。", {
      uid,
      source,
      recordScope,
      pageSize: commentPageSize,
      lanes: this.lanes.length,
      workers: this.lanes.length * workersPerLane,
      requestBudget,
      proxyTransportMaxConcurrent: this.transportGate ? DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT : undefined,
      proxyTransportStartDelayMs: this.transportGate ? DEFAULT_PROXY_TRANSPORT_START_DELAY_MS : undefined,
    });
    try {
      await saveResumeTask(this.paths.resumeTask, {
        version: 1,
        mode: "source",
        updatedAt: new Date().toISOString(),
        input: {
          uid,
          source,
          recordScope,
          pageSize: commentPageSize,
          requestBudget,
          minDelayMs,
          jitterMs,
          forbiddenCooldownMs,
          maxCommentPagesPerSong,
          maxSongs,
          workersPerProxy: workersPerLane,
          allowDirect,
        },
      });
    } catch (error) {
      await logger.write("warn", "resume_descriptor_failure", "未能保存任务参数；扫描检查点仍会正常写入。", {
        error: message(error),
      });
    }
    void runPooledCommentFinder(this.lanes, { ...options, workersPerLane, requestBudget })
      .then(async (report) => {
        if (this.snapshotValue.id !== activeId) return;
        await logger.write("info", "task_finished", `用户来源扫描结束：${report.status}。`, {
          status: report.status,
          matches: report.matches,
          requestsTotal: report.requestsTotal,
          pagesProcessed: report.pagesProcessed ?? 0,
          coverageComplete: report.coverageComplete,
          sourceErrors: report.sourceErrors,
          note: report.note,
        });
        this.snapshotValue = {
          ...this.snapshotValue, status: report.status, finishedAt: new Date().toISOString(),
          songs: report.songs, songsProcessed: report.songsProcessed, matches: report.matches,
          requestsTotal: report.requestsTotal, coverageComplete: report.coverageComplete,
          pagesProcessed: report.pagesProcessed ?? 0, lanes: report.lanes ?? this.snapshotValue.lanes,
          workers: report.workers ?? this.snapshotValue.workers,
          sourceErrors: report.sourceErrors, blockedUntil: report.resumeAfter, note: report.note,
          currentSong: undefined,
        };
        this.terminalStateSyncedId = activeId;
      })
      .catch(async (error) => {
        await logger.write("error", "task_error", `用户来源扫描异常结束：${message(error)}`, { error: message(error) });
        this.fail(activeId, error);
      })
      .finally(() => {
        if (this.snapshotValue.id === activeId) {
          this.lanes = [];
          this.transportGate = undefined;
        }
        lease.release();
      });
    launched = true;
    return this.status();
    } finally {
      if (!launched) {
        this.transportGate?.cancel();
        this.transportGate = undefined;
        this.lanes = [];
        lease.release();
      }
    }
  }

  async stop(): Promise<JobSnapshot> {
    if (this.snapshotValue.status !== "running") return this.status();
    this.snapshotValue.status = "stopping";
    this.transportGate?.cancel();
    for (const lane of this.lanes) lane.governor.cancel();
    return this.status();
  }

  async status(): Promise<JobSnapshot> {
    const active = ["running", "stopping"].includes(this.snapshotValue.status);
    const needsTerminalSync = Boolean(
      this.snapshotValue.id && this.terminalStateSyncedId !== this.snapshotValue.id,
    );
    if (this.statePath && (active || needsTerminalSync)) {
      const state = await loadState(this.statePath);
      if (state && state.uid === this.snapshotValue.uid) {
        const progress = state.songProgress ?? [];
        const currentIndex = progress.length > 0 ? progress.findIndex((item) => !item.done) : state.songIndex;
        const current = currentIndex < 0 ? undefined : state.songs[currentIndex];
        const inferredCurrent = current ? {
          id: current.id,
          name: current.name,
          pageInSong: (progress[currentIndex]?.pageInSong ?? state.pageInSong) + 1,
          commentsProcessed: progress[currentIndex]?.commentOffset ?? state.commentOffset,
          totalComments: progress[currentIndex]?.totalComments,
        } : undefined;
        const activeCurrent = ["running", "stopping"].includes(this.snapshotValue.status)
          ? this.snapshotValue.currentSong
          : undefined;
        this.snapshotValue = {
          ...this.snapshotValue, songs: state.songs.length,
          songsProcessed: progress.length > 0 ? progress.filter((item) => item.done).length : state.songIndex,
          commentOffset: currentIndex < 0 ? 0 : progress[currentIndex]?.commentOffset ?? state.commentOffset,
          currentSong: activeCurrent ?? inferredCurrent,
          matches: state.matchCount, requestsTotal: state.requestCount,
          pagesProcessed: state.pagesProcessed ?? 0,
          coverageComplete: state.coverageComplete, sourceErrors: state.sourceErrors,
          blockedUntil: state.blockedUntil,
        };
      }
      if (!active) this.terminalStateSyncedId = this.snapshotValue.id;
    }
    this.snapshotValue.elapsedMs = taskElapsedMs(
      this.snapshotValue.startedAt,
      this.snapshotValue.finishedAt,
    );
    return { ...this.snapshotValue, sourceErrors: [...this.snapshotValue.sourceErrors] };
  }

  results(limit: number): Promise<FoundComment[]> { return readJsonl(this.outputPath, limit); }
  async logs(limit: number): Promise<{ path?: string; entries: Awaited<ReturnType<typeof readTaskLog>> }> {
    return { path: this.snapshotValue.logPath, entries: await readTaskLog(this.snapshotValue.logPath, limit) };
  }

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
  private transportGate?: ProxyTransportGate;
  private statePath?: string;
  private outputPath?: string;
  private terminalStateSyncedId?: string;
  private readonly matchSubscribers = new Set<MatchSubscriber>();

  constructor(
    private readonly paths: RuntimePaths,
    private readonly coordinator: TaskCoordinator,
  ) {}

  async start(input: StartParallelInput): Promise<ParallelJobSnapshot> {
    const lease = this.coordinator.acquire("parallel");
    if (!lease) throw new HttpError(409, busyTaskMessage(this.coordinator));
    const startedAt = new Date().toISOString();
    let launched = false;
    try {
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
    if (entries.length === 0) {
      throw new HttpError(409, "代理池复核后没有可用出口；已阻止回退到本机直连，请重新构建代理池。");
    }
    this.transportGate = new ProxyTransportGate();
    this.lanes = entries.map((entry, index) => ({
      name: `proxy-${index + 1}`,
      client: new EnhancedNcmClient({ proxy: entry.endpoint }),
      transportGate: this.transportGate,
      governor: new RequestGovernor({
        requestBudget: requestBudget === 0 ? 0 : Math.max(1_000, requestBudget * 2), concurrency: workersPerLane, minDelayMs, jitterMs,
        maxRetries: 2, forbiddenCooldownMs,
      }),
    }));
    const song = await executeProxyRequest(this.lanes[0], `song_detail:${songId}`, () => this.lanes[0].client.getSongInfo(songId));
    const previousPath = join(this.paths.data, `parallel-state-${uid}-${songId}.json`);
    const previous = bool(input.fresh) ? undefined : await loadParallelState(previousPath);
    this.statePath = previousPath;
    this.outputPath = join(this.paths.data, `parallel-comments-${uid}-${songId}.jsonl`);
    const activeId = randomUUID();
    const logger = new TaskLogger(
      join(this.paths.data, "logs", `parallel-${activeId}.jsonl`),
      "parallel",
      activeId,
    );
    this.snapshotValue = {
      ...emptyParallelSnapshot(), id: activeId, status: "running", uid, songId,
      songName: song.name, startedAt, lanes: this.lanes.length,
      workers: this.lanes.length * workersPerLane, shards: shardCount,
      proxyTransportMaxConcurrent: DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT,
      proxyTransportStartDelayMs: DEFAULT_PROXY_TRANSPORT_START_DELAY_MS,
      logPath: logger.path,
    };
    this.terminalStateSyncedId = undefined;
    await logger.write("info", "task_started", "单曲并行扫描已启动。", {
      uid,
      songId,
      songName: song.name,
      pageSize,
      shards: shardCount,
      lanes: this.lanes.length,
      workers: this.lanes.length * workersPerLane,
      requestBudget,
      proxyTransportMaxConcurrent: DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT,
      proxyTransportStartDelayMs: DEFAULT_PROXY_TRANSPORT_START_DELAY_MS,
    });
    try {
      await saveResumeTask(this.paths.resumeTask, {
        version: 1,
        mode: "parallel",
        updatedAt: new Date().toISOString(),
        input: {
          uid,
          songId,
          workersPerProxy: workersPerLane,
          shards: shardCount,
          pageSize,
          requestBudget,
          maxPages,
          minDelayMs,
          jitterMs,
          forbiddenCooldownMs,
        },
      });
    } catch (error) {
      await logger.write("warn", "resume_descriptor_failure", "未能保存任务参数；扫描检查点仍会正常写入。", {
        error: message(error),
      });
    }
    void runParallelSongScan(this.lanes, {
      uid, songId, songName: song.name, startTime: previous?.startTime ?? song.publishTime ?? Date.UTC(2000, 0, 1),
      endTime: previous?.endTime ?? Date.now(), shardCount, pageSize, workersPerLane,
      requestBudget, maxPages, stopAfterFirst: false,
      fresh: bool(input.fresh), statePath: this.statePath, outputPath: this.outputPath,
      onMatch: (comment) => this.publishMatch(comment),
      onRequestActivity: (activity) => logger.request(activity),
      onSchedulerActivity: (activity) => logger.scheduler(activity),
    }).then(async (report) => {
      if (this.snapshotValue.id !== activeId) return;
      await logger.write("info", "task_finished", `单曲并行扫描结束：${report.status}。`, {
        status: report.status,
        matches: report.matches,
        requestsTotal: report.requestsTotal,
        pagesProcessed: report.pagesProcessed,
        commentsInspected: report.commentsInspected,
        shardsComplete: report.shardsComplete,
        note: report.note,
      });
      this.snapshotValue = {
        ...this.snapshotValue, ...report, status: report.status,
        finishedAt: new Date().toISOString(), note: report.note,
      };
      this.terminalStateSyncedId = activeId;
    }).catch(async (error) => {
      await logger.write("error", "task_error", `单曲并行扫描异常结束：${message(error)}`, { error: message(error) });
      if (this.snapshotValue.id !== activeId) return;
      this.snapshotValue = { ...this.snapshotValue, status: "error", finishedAt: new Date().toISOString(), error: message(error) };
    }).finally(() => {
      if (this.snapshotValue.id === activeId) {
        this.lanes = [];
        this.transportGate = undefined;
      }
      lease.release();
    });
    launched = true;
    return this.status();
    } finally {
      if (!launched) {
        this.transportGate?.cancel();
        this.transportGate = undefined;
        this.lanes = [];
        lease.release();
      }
    }
  }

  async stop(): Promise<ParallelJobSnapshot> {
    if (this.snapshotValue.status !== "running") return this.status();
    this.snapshotValue.status = "stopping";
    this.transportGate?.cancel();
    for (const lane of this.lanes) lane.governor.cancel();
    return this.status();
  }

  async status(): Promise<ParallelJobSnapshot> {
    const active = ["running", "stopping"].includes(this.snapshotValue.status);
    const needsTerminalSync = Boolean(
      this.snapshotValue.id && this.terminalStateSyncedId !== this.snapshotValue.id,
    );
    if (this.statePath && (active || needsTerminalSync)) {
      const state = await loadParallelState(this.statePath);
      if (state && state.uid === this.snapshotValue.uid && state.songId === this.snapshotValue.songId) {
        this.snapshotValue = {
          ...this.snapshotValue, shards: state.shards.length,
          shardsComplete: state.shards.filter((item) => item.done).length,
          coveragePercent: timeCoveragePercent(state.startTime, state.endTime, state.shards),
          pagesProcessed: state.pagesProcessed, commentsInspected: state.commentsInspected,
          totalComments: state.totalComments,
          matches: state.matchCount, requestsTotal: state.requestCount,
        };
      }
      if (!active) this.terminalStateSyncedId = this.snapshotValue.id;
    }
    this.snapshotValue.elapsedMs = taskElapsedMs(
      this.snapshotValue.startedAt,
      this.snapshotValue.finishedAt,
    );
    return { ...this.snapshotValue };
  }

  results(limit: number): Promise<FoundComment[]> { return readJsonl(this.outputPath, limit); }
  async logs(limit: number): Promise<{ path?: string; entries: Awaited<ReturnType<typeof readTaskLog>> }> {
    return { path: this.snapshotValue.logPath, entries: await readTaskLog(this.snapshotValue.logPath, limit) };
  }

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
  private discoveryCache?: {
    expiresAt: number;
    value: ReturnType<typeof discoverClashVerge>;
  };

  constructor(
    private readonly paths: RuntimePaths,
    private readonly refreshIntervalMs: number,
    private readonly refresher: typeof refreshProxyPool,
    private readonly coordinator: TaskCoordinator,
    private readonly discoveryIntervalMs: number,
    private readonly discoverer: typeof discoverClashVerge,
  ) {}

  async status(): Promise<PoolSnapshot> {
    const pool = await readProxyPool(this.paths.pool);
    const running = proxyPoolStatusRunning(pool);
    if (!this.starting && !this.coordinator.isBusy() && running && pool) this.scheduleRefresh(pool);
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
      discovery: this.discovery(),
    };
  }

  async start(input: Record<string, unknown>): Promise<PoolSnapshot> {
    const lease = this.coordinator.acquire("pool");
    if (!lease) throw new HttpError(409, "检索任务运行时不能更改代理池，请先停止任务。");
    if (this.starting) {
      lease.release();
      throw new HttpError(409, "代理池正在构建。");
    }
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
    } finally { this.starting = false; lease.release(); }
  }

  async import(input: Record<string, unknown>): Promise<PoolSnapshot> {
    const lease = this.coordinator.acquire("pool");
    if (!lease) throw new HttpError(409, "检索任务运行时不能更改代理池，请先停止任务。");
    if (this.starting) {
      lease.release();
      throw new HttpError(409, "代理池正在验证。");
    }
    this.starting = true;
    try {
      const endpoints = proxyEndpoints(input.proxies);
      const size = integer(input.size ?? 0, "size", 0, 64);
      await importExternalProxyPool(endpoints, this.paths.pool, size);
      this.nextRefreshAt = Date.now() + this.refreshIntervalMs;
      this.refreshError = undefined;
      return this.status();
    } finally { this.starting = false; lease.release(); }
  }

  async stop(): Promise<PoolSnapshot> {
    const lease = this.coordinator.acquire("pool");
    if (!lease) throw new HttpError(409, "检索任务运行时不能更改代理池，请先停止任务。");
    try {
      await stopMihomoPool(this.paths.pool);
      this.nextRefreshAt = 0;
      this.refreshError = undefined;
      return this.status();
    } finally { lease.release(); }
  }

  private scheduleRefresh(pool: ProxyPoolFile): void {
    if (this.refreshPromise) return;
    const lastCheckedAt = Date.parse(pool.lastCheckedAt ?? pool.generatedAt);
    const persistedDueAt = Number.isFinite(lastCheckedAt)
      ? lastCheckedAt + this.refreshIntervalMs
      : 0;
    const now = Date.now();
    if (now < Math.max(this.nextRefreshAt, persistedDueAt)) return;

    const lease = this.coordinator.acquire("pool");
    if (!lease) return;

    this.nextRefreshAt = now + this.refreshIntervalMs;
    this.refreshPromise = this.refresher(this.paths.pool)
      .then(() => { this.refreshError = undefined; })
      .catch(() => {
        this.refreshError = "代理池后台复测暂时失败，将在下个周期重试。";
      })
      .finally(() => {
        this.refreshPromise = undefined;
        lease.release();
      });
  }

  private discovery(): ReturnType<typeof discoverClashVerge> {
    const now = Date.now();
    if (!this.discoveryCache || this.discoveryCache.expiresAt <= now) {
      this.discoveryCache = {
        expiresAt: now + this.discoveryIntervalMs,
        value: this.discoverer(),
      };
    }
    return this.discoveryCache.value;
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
  const coordinator = new TaskCoordinator();
  const jobs = new JobManager(paths, coordinator);
  const parallel = new ParallelJobManager(paths, coordinator);
  const pool = new PoolManager(
    paths,
    options.poolRefreshIntervalMs ?? 60_000,
    options.poolRefresher ?? refreshProxyPool,
    coordinator,
    options.poolDiscoveryIntervalMs ?? 30_000,
    options.poolDiscoverer ?? discoverClashVerge,
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
  if (method === "GET" && url.pathname === "/api/resume") return json(response, 200, { task: await readResumeTask(paths.resumeTask) ?? null });
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
  if (method === "GET" && url.pathname === "/api/logs") {
    return json(response, 200, url.searchParams.get("mode") === "parallel"
      ? await parallel.logs(limit(url))
      : await jobs.logs(limit(url)));
  }
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
      proxyTransport: url.searchParams.get("proxyTransport") === "1",
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
  const data = join(normalized, "data");
  return {
    root: normalized,
    data,
    ncm,
    cookie: join(ncm, "cookie.txt"),
    qr: join(ncm, "login-qr.png"),
    pool: join(ncm, "proxy-pool.json"),
    poolWork: join(ncm, "mihomo-pool"),
    resumeTask: join(data, "resume-task.json"),
  };
}

async function saveResumeTask(path: string, descriptor: ResumeTaskDescriptor): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function readResumeTask(path: string): Promise<ResumeTaskDescriptor | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<ResumeTaskDescriptor>;
    if (
      value.version !== 1 ||
      (value.mode !== "source" && value.mode !== "parallel") ||
      typeof value.updatedAt !== "string" ||
      !value.input ||
      typeof value.input !== "object" ||
      Array.isArray(value.input) ||
      !Object.values(value.input).every((item) =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean"
      )
    ) return undefined;
    return value as ResumeTaskDescriptor;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
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
  return readJsonlTail<FoundComment>(path, max);
}

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function emptySnapshot(): JobSnapshot { return { status: "idle", songs: 0, songsProcessed: 0, commentOffset: 0, matches: 0, requestsTotal: 0, pagesProcessed: 0, elapsedMs: 0, lanes: 0, workers: 0, coverageComplete: false, sourceErrors: [], proxyEnabled: false }; }
function emptyParallelSnapshot(): ParallelJobSnapshot { return { status: "idle", lanes: 0, workers: 0, shards: 0, shardsComplete: 0, coveragePercent: 0, pagesProcessed: 0, commentsInspected: 0, matches: 0, requestsTotal: 0, elapsedMs: 0 }; }
function busyTaskMessage(coordinator: TaskCoordinator): string {
  if (coordinator.activeMode() === "pool") return "代理池正在构建或验证，请稍后再启动检索。";
  return coordinator.activeMode() === "parallel"
    ? "已有单曲并行任务正在运行，请先停止该任务。"
    : "已有用户来源任务正在运行，请先停止该任务。";
}
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
