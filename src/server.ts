import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import { EnhancedNcmClient, type NcmUserProfile } from "./api";
import { readAtomicJson, writeAtomicJson } from "./atomic-file";
import { CommentRateTracker } from "./comment-rate";
import { AuthenticationRequired, CooldownRequired, errorStatus } from "./errors";
import { estimateCommentScan } from "./estimate";
import { RequestGovernor } from "./governor";
import {
  JsonlSnapshotLimitError,
  readJsonlSnapshotDetails,
  type JsonlSnapshot,
} from "./jsonl-snapshot";
import { readJsonlTail } from "./jsonl-tail";
import { PagePerformanceTracker, type PagePerformanceSnapshot } from "./page-performance";
import {
  ClassicEncryptUinError,
} from "./qq-music";
import { qqMusicTransportProfile } from "./qq-music/transport-gate";
import {
  QQJobManager,
  QQJobManagerError,
  type QQJobGeneration,
  type QQJobManagerOptions,
} from "./qq-job-manager";
import { timeCoveragePercent } from "./progress";
import {
  DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT,
  DEFAULT_PROXY_TRANSPORT_START_DELAY_MS,
  DEFAULT_PROXY_TRANSPORT_START_JITTER_MS,
  executeProxyRequest,
  ProxyTransportGate,
} from "./proxy-transport-gate";
import { selectProxyLanes, type ProxyLaneSelection } from "./proxy-lane-selection";
import {
  defaultMihomoPoolOptions,
  discoverClashVerge,
  importExternalProxyPool,
  proxyPoolStatusRunning,
  recentlyVerifiedProxyPoolEntries,
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
import { renderResultReportHtml, type ResultReport } from "./result-report";
import { loadState, SOURCE_CATALOG_VERSION } from "./state";
import { taskElapsedMs, TaskCoordinator, type TaskAcquisitionBlock } from "./task-coordinator";
import { readTaskLog, TaskLogger } from "./task-log";
import type {
  FoundComment,
  ParallelSongScanReport,
  RunReport,
  ScanOptions,
  ScanRequestActivity,
  SongInfo,
  SongSearchResponse,
  SongSearchResult,
  SourceSelection,
} from "./types";
import { checkForUpdate, type UpdateSnapshot } from "./update";
import { workerCountForTopology } from "./worker-topology";

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
  qqClientFactory?: QQJobManagerOptions["clientFactory"];
  qqRunner?: QQJobManagerOptions["runner"];
  songSearchRouter?: NcmSongSearchRouterDependencies;
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
  uiPreferences: string;
}

type PlatformTransitionPattern = "diagonal" | "ripple";

interface UiPreferences {
  version: 1;
  platformTransitionPattern: PlatformTransitionPattern;
  updatedAt: string;
}

interface LegacyResumeTaskDescriptor {
  version: 1;
  mode: "source" | "parallel";
  updatedAt: string;
  input: Record<string, string | number | boolean>;
}

interface PlatformResumeTaskDescriptor {
  version: 2;
  platform: "netease" | "qq";
  mode: "source" | "parallel" | "song" | "likes";
  updatedAt: string;
  input: Record<string, string | number | boolean>;
}

interface CurrentResumeTaskDescriptor {
  version: 3;
  platform: "netease" | "qq";
  mode: "source" | "parallel" | "song" | "likes";
  requestIntervalSemantics: "per-start-v1";
  updatedAt: string;
  input: Record<string, string | number | boolean>;
}

type ResumeTaskDescriptor = LegacyResumeTaskDescriptor | PlatformResumeTaskDescriptor | CurrentResumeTaskDescriptor;

type JobStatus = "idle" | "running" | "stopping" | RunReport["status"] | "error";

interface ActiveSongSnapshot {
  id: string;
  name?: string;
  workers: number;
  workersPerLane?: number;
  hostConcurrency?: number;
  pageSize?: number;
  minDelayMs?: number;
  jitterMs?: number;
  pagesProcessed?: number;
  requestingPage?: number;
  requestStartedAt?: number;
  commentsProcessed?: number;
  totalComments?: number;
  progressPercent?: number;
  progressBasis?: "comments" | "time";
}

interface JobSnapshot extends PagePerformanceSnapshot {
  id?: string;
  status: JobStatus;
  uid?: string;
  source?: SourceSelection;
  recordScope?: "all" | "week";
  startedAt?: string;
  finishedAt?: string;
  songs: number;
  songsProcessed: number;
  catalogSongs: number;
  reusedSongs: number;
  historicalCompletedSongs: number;
  newPendingSongs: number;
  commentOffset: number;
  activeSongs: ActiveSongSnapshot[];
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
  commentsInspected: number;
  commentsPerSecond: number;
  elapsedMs: number;
  logPath?: string;
  lanes: number;
  laneSelection?: ProxyLaneSelection;
  workers: number;
  workersPerLane?: number;
  hostConcurrency?: number;
  configuredShardCount?: number;
  pageSize?: number;
  minDelayMs?: number;
  jitterMs?: number;
  proxyTransportMaxConcurrent?: number;
  proxyTransportEffectiveConcurrent?: number;
  proxyTransportStartDelayMs?: number;
  proxyTransportStartJitterMs?: number;
  coverageComplete: boolean;
  sourceErrors: string[];
  blockedUntil?: string;
  proxyEnabled: boolean;
  error?: string;
  note?: string;
}

interface ParallelJobSnapshot extends PagePerformanceSnapshot {
  id?: string;
  status: "idle" | "running" | "stopping" | ParallelSongScanReport["status"] | "error";
  uid?: string;
  songId?: string;
  songName?: string;
  activeSongs: ActiveSongSnapshot[];
  startedAt?: string;
  finishedAt?: string;
  lanes: number;
  laneSelection?: ProxyLaneSelection;
  workers: number;
  workersPerLane?: number;
  hostConcurrency?: number;
  configuredShardCount?: number;
  pageSize?: number;
  minDelayMs?: number;
  jitterMs?: number;
  proxyTransportMaxConcurrent?: number;
  proxyTransportEffectiveConcurrent?: number;
  proxyTransportStartDelayMs?: number;
  proxyTransportStartJitterMs?: number;
  shards: number;
  shardsComplete: number;
  coveragePercent: number;
  pagesProcessed: number;
  commentsInspected: number;
  totalComments?: number;
  matches: number;
  requestsTotal: number;
  commentsPerSecond: number;
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
  maxProxyLanes?: unknown;
  hostConcurrency?: unknown;
}

interface StartParallelInput {
  uid?: unknown;
  songId?: unknown;
  workersPerProxy?: unknown;
  maxProxyLanes?: unknown;
  hostConcurrency?: unknown;
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

export interface UserProbe {
  profile: NcmUserProfile;
  record: SourceProbe;
  likes: SourceProbe;
  sessionPresent: boolean;
  elapsedMs: number;
  route: "direct" | "explicit-proxy" | "managed-pool";
  routeName?: string;
  routeAttempts: number;
}

type UserProbeRequest = (uid: string, proxy: string | undefined, cookiePath: string) => Promise<UserProbe>;

export interface UserProbeRouterDependencies {
  readPool?: typeof readProxyPool;
  verifyPool?: typeof verifyProxyPool;
  probe?: UserProbeRequest;
}

/** Rotates profile lookups across the managed pool instead of reusing one direct exit for every UID. */
export class UserProbeRouter {
  private cursor = 0;

  constructor(
    private readonly cookiePath: string,
    private readonly poolPath: string,
    private readonly dependencies: UserProbeRouterDependencies = {},
  ) {}

  async run(uid: string, explicitProxy?: string): Promise<UserProbe> {
    const probe = this.dependencies.probe ?? probeUser;
    if (explicitProxy) {
      return this.runSingle(probe, uid, explicitProxy, "explicit-proxy", "手动代理");
    }

    const pool = await (this.dependencies.readPool ?? readProxyPool)(this.poolPath);
    if (!proxyPoolStatusRunning(pool)) {
      return this.runSingle(probe, uid, undefined, "direct", "本机直连");
    }

    let entries: ProxyPoolEntry[];
    try {
      entries = recentlyVerifiedProxyPoolEntries(pool!)
        ?? await (this.dependencies.verifyPool ?? verifyProxyPool)(pool!);
    } catch {
      throw new HttpError(409, "代理池正在运行，但节点复核失败；已阻止用户查询回退到本机直连，请先重新优选节点。");
    }
    if (entries.length === 0) {
      throw new HttpError(409, "代理池当前没有可用节点；已阻止用户查询回退到本机直连。");
    }

    const start = this.cursor % entries.length;
    this.cursor = (this.cursor + 1) % entries.length;
    const attempts = Math.min(3, entries.length);
    let lastError: unknown;
    for (let index = 0; index < attempts; index += 1) {
      const entry = entries[(start + index) % entries.length];
      try {
        const result = await probe(uid, entry.endpoint, this.cookiePath);
        return {
          ...result,
          route: "managed-pool",
          routeName: entry.name,
          routeAttempts: index + 1,
        };
      } catch (error) {
        if (error instanceof AuthenticationRequired) throw new HttpError(401, error.message);
        if (errorStatus(error) === 404) throw userProbeHttpError(error, index + 1, true);
        lastError = error;
      }
    }
    throw userProbeHttpError(lastError, attempts, true);
  }

  private async runSingle(
    probe: UserProbeRequest,
    uid: string,
    proxy: string | undefined,
    route: UserProbe["route"],
    routeName: string,
  ): Promise<UserProbe> {
    try {
      return {
        ...await probe(uid, proxy, this.cookiePath),
        route,
        routeName,
        routeAttempts: 1,
      };
    } catch (error) {
      if (error instanceof AuthenticationRequired) throw new HttpError(401, error.message);
      throw userProbeHttpError(error, 1, false);
    }
  }
}

type NcmSongSearchRequest = (
  query: string,
  limit: number,
  proxy: string | undefined,
) => Promise<SongSearchResult[]>;
type NcmSongLookupRequest = (songId: string, proxy: string | undefined) => Promise<SongInfo>;

export interface NcmSongSearchRouterDependencies {
  readPool?: typeof readProxyPool;
  verifyPool?: typeof verifyProxyPool;
  search?: NcmSongSearchRequest;
  lookup?: NcmSongLookupRequest;
}

/** Lookup-only song search with managed-pool rotation and fail-closed pool semantics. */
export class NcmSongSearchRouter {
  private cursor = 0;

  constructor(
    private readonly poolPath: string,
    private readonly dependencies: NcmSongSearchRouterDependencies = {},
  ) {}

  async run(query: string, limit: number, explicitProxy?: string): Promise<SongSearchResponse> {
    const search = this.dependencies.search ?? searchNcmSongs;
    const songs = await this.runWithPool(
      (proxy) => search(query, limit, proxy),
      explicitProxy,
      "歌曲搜索",
    );
    return { platform: "netease", query, songs };
  }

  async lookup(songId: string, explicitProxy?: string): Promise<SongInfo> {
    const lookup = this.dependencies.lookup ?? lookupNcmSong;
    return this.runWithPool(
      (proxy) => lookup(songId, proxy),
      explicitProxy,
      "歌曲信息查询",
    );
  }

  private async runWithPool<T>(
    request: (proxy: string | undefined) => Promise<T>,
    explicitProxy: string | undefined,
    label: string,
  ): Promise<T> {
    if (explicitProxy) {
      try {
        return await request(explicitProxy);
      } catch (error) {
        throw ncmLookupHttpError(error, 1, false, true, label);
      }
    }

    let pool: ProxyPoolFile | undefined;
    try {
      pool = await (this.dependencies.readPool ?? readProxyPool)(this.poolPath);
    } catch {
      throw new HttpError(409, `无法读取代理池状态；${label}不会回退到本机直连。`);
    }
    if (!proxyPoolStatusRunning(pool)) {
      try {
        return await request(undefined);
      } catch (error) {
        throw ncmLookupHttpError(error, 1, false, false, label);
      }
    }

    let entries: ProxyPoolEntry[];
    try {
      entries = recentlyVerifiedProxyPoolEntries(pool!)
        ?? await (this.dependencies.verifyPool ?? verifyProxyPool)(pool!);
    } catch {
      throw new HttpError(409, `代理池正在运行，但节点复核失败；${label}不会回退到本机直连，请先重新优选节点。`);
    }
    if (entries.length === 0) {
      throw new HttpError(409, `代理池当前没有可用节点；${label}不会回退到本机直连。`);
    }

    const start = this.cursor % entries.length;
    this.cursor = (this.cursor + 1) % entries.length;
    const attempts = Math.min(3, entries.length);
    let attempted = 0;
    let lastError: unknown;
    for (let index = 0; index < attempts; index += 1) {
      const entry = entries[(start + index) % entries.length];
      attempted = index + 1;
      try {
        return await request(entry.endpoint);
      } catch (error) {
        lastError = error;
        if (!isNcmLookupLaneFailure(error)) break;
      }
    }
    throw ncmLookupHttpError(lastError, attempted, true, false, label);
  }
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
  managementNotice?: string;
  sourceConfigPath?: string;
  sourceConfigPaths?: string[];
  entries: ProxyPoolEntry[];
  discovery: ReturnType<typeof discoverClashVerge>;
}

type MatchSubscriber = (comment: FoundComment) => void;

const projectRoot = resolve(__dirname, "..");
const webRoot = join(projectRoot, "web");
const iconRoot = join(projectRoot, "node_modules", "lucide-static", "icons");
const ACTIVE_SONG_PROGRESS_LIMIT = 64;
const MAX_RESULT_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_RESULT_REPORT_RECORDS = 20_000;

class UpdatePreparationGate {
  private block?: TaskAcquisitionBlock;

  constructor(private readonly coordinator: TaskCoordinator) {}

  begin(): void {
    this.block ??= this.coordinator.blockNewTasks();
  }

  cancel(): void {
    this.block?.release();
    this.block = undefined;
  }

  isActive(): boolean {
    return this.block !== undefined;
  }
}

class JobManager {
  private snapshotValue: JobSnapshot = emptySnapshot();
  private lanes: SourceScanLane[] = [];
  private transportGate?: ProxyTransportGate;
  private statePath?: string;
  private outputPath?: string;
  private terminalStateSyncedId?: string;
  private abortController?: AbortController;
  private readonly activeSongByWorker = new Map<string, { id: string; name?: string; requestingPage?: number; requestStartedAt?: number; active: boolean }>();
  private readonly activeSongProgress = new Map<string, Omit<ActiveSongSnapshot, "id" | "workers" | "requestingPage" | "requestStartedAt">>();
  private readonly songNameById = new Map<string, string>();
  private readonly matchSubscribers = new Set<MatchSubscriber>();
  private readonly commentRate = new CommentRateTracker();
  private readonly pagePerformance = new PagePerformanceTracker();

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
    const cookie = await readCookie(this.paths.cookie);
    if ((source === "likes" || source === "both") && !cookie) {
      throw new HttpError(401, "喜欢歌曲需要网易云登录，请先点击“二维码登录”完成登录。");
    }
    const recordScope = selection(input.recordScope ?? "all", ["all", "week"] as const, "recordScope");
    const requestBudget = integer(input.requestBudget ?? 0, "requestBudget", 0, 100_000);
    const minDelayMs = integer(input.minDelayMs ?? 2_500, "minDelayMs", 0, 600_000);
    const jitterMs = integer(input.jitterMs ?? 800, "jitterMs", 0, 600_000);
    const commentPageSize = integer(input.pageSize ?? 1_000, "pageSize", 1, 2_000);
    const forbiddenCooldownMs = integer(input.forbiddenCooldownMs ?? 900_000, "forbiddenCooldownMs", 1_000, 86_400_000);
    const maxCommentPagesPerSong = integer(input.maxCommentPagesPerSong ?? 0, "maxCommentPagesPerSong", 0, 1_000_000);
    const maxSongs = integer(input.maxSongs ?? 0, "maxSongs", 0, 100_000);
    const workersPerLane = integer(input.workersPerProxy ?? 1, "workersPerProxy", 1, 8);
    const maxProxyLanes = integer(input.maxProxyLanes ?? 0, "maxProxyLanes", 0, 32);
    const hostConcurrency = integer(
      input.hostConcurrency ?? DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT,
      "hostConcurrency",
      1,
      32,
    );
    const proxy = proxyUrl(input.proxy);
    const allowDirect = bool(input.allowDirect);
    const taskPaths = sourceTaskPaths(this.paths.data, uid, source);
    const nextStatePath = taskPaths.statePath;
    const nextOutputPath = taskPaths.outputPath;
    const nextCoveragePath = taskPaths.coveragePath;
    const activePool = await readProxyPool(this.paths.pool);
    const activePoolExpected = proxyPoolStatusRunning(activePool);
    const poolEntries = activePoolExpected
      ? recentlyVerifiedProxyPoolEntries(activePool!) ?? await verifyProxyPool(activePool!)
      : [];
    if (activePoolExpected && poolEntries.length === 0) {
      throw new HttpError(409, "代理池复核后没有可用出口；已阻止回退到本机直连，请重新构建代理池。");
    }
    if (!activePoolExpected && !proxy && !allowDirect) {
      throw new HttpError(409, "未检测到可用代理。为防止静默暴露本机出口，任务未启动；请先运行代理池、填写单代理，或明确勾选允许本机直连。");
    }
    const selectedPool = selectProxyLanes(
      poolEntries,
      maxProxyLanes,
      workersPerLane,
      hostConcurrency,
    );
    const selectedPoolEntries = selectedPool.entries;
    const endpoints = selectedPoolEntries.length > 0
      ? selectedPoolEntries.map((entry) => entry.endpoint)
      : [proxy];
    this.transportGate = endpoints.some(Boolean)
      ? new ProxyTransportGate({ maxConcurrent: hostConcurrency })
      : undefined;
    this.lanes = endpoints.map((endpoint, index) => ({
      name: selectedPoolEntries[index]?.name ?? (endpoint ? "static-proxy" : "direct"),
      client: new EnhancedNcmClient({ proxy: endpoint }),
      transportGate: this.transportGate,
      governor: new RequestGovernor({
        requestBudget: requestBudget === 0 ? 0 : Math.max(1_000, requestBudget * 2),
        minDelayMs,
        jitterMs,
        maxRetries: 3,
        forbiddenCooldownMs,
      }),
    }));
    const activeId = randomUUID();
    this.abortController = new AbortController();
    this.activeSongByWorker.clear();
    this.activeSongProgress.clear();
    this.songNameById.clear();
    this.commentRate.reset();
    this.pagePerformance.reset();
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
      cookie,
      statePath: nextStatePath,
      outputPath: nextOutputPath,
      coveragePath: nextCoveragePath,
      commentPageSize,
      historyPageSize: 50,
      maxCommentPagesPerSong,
      maxSongs,
      stopAfterFirst: false,
      fresh: bool(input.fresh),
      dryRun: bool(input.dryRun),
      signal: this.abortController.signal,
      onMatch: (comment) => this.publishMatch(comment),
      onCheckpoint: (activity) => {
        if (this.snapshotValue.id !== activeId) return;
        this.snapshotValue = {
          ...this.snapshotValue,
          ...activity,
          sourceErrors: [...activity.sourceErrors],
        };
      },
      onSongCatalog: (songs) => {
        if (this.snapshotValue.id !== activeId) return;
        this.songNameById.clear();
        for (const song of songs) {
          if (song.name) this.songNameById.set(song.id, song.name);
        }
      },
      onRequestActivity: (activity) => {
        this.pagePerformance.record(activity);
        if (activity.phase === "success") this.commentRate.record(activity.comments ?? 0);
        logger.request(activity);
        this.trackActiveSong(activeId, activity);
      },
      onSchedulerActivity: (activity) => logger.scheduler(activity),
      onSongProgress: (activity) => {
        if (this.snapshotValue.id !== activeId || this.snapshotValue.status !== "running") return;
        const progressPercent = activity.totalComments && activity.totalComments > 0
          ? Math.min(100, activity.commentsProcessed / activity.totalComments * 100)
          : undefined;
        this.activeSongProgress.delete(activity.songId);
        this.activeSongProgress.set(activity.songId, {
          name: activity.songName ?? this.songNameById.get(activity.songId),
          pagesProcessed: activity.pageInSong,
          commentsProcessed: activity.commentsProcessed,
          totalComments: activity.totalComments,
          progressPercent,
          progressBasis: "comments",
        });
        this.trimActiveSongProgress();
        if (activity.done) this.removeScheduledSong(activity.songId);
        this.publishActiveSongs(activeId);
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
    // Publish the result descriptor and job id together, after every awaited
    // startup preflight has succeeded. Failed starts keep the previous job's
    // paths intact, and concurrent result reads can capture a consistent pair.
    this.statePath = nextStatePath;
    this.outputPath = nextOutputPath;
    this.snapshotValue = {
      ...emptySnapshot(), id: activeId, status: "running", uid, source, recordScope,
      startedAt, proxyEnabled: selectedPoolEntries.length > 0 || Boolean(proxy),
      lanes: this.lanes.length, workers: workerCountForTopology(this.lanes.length, workersPerLane, hostConcurrency),
      workersPerLane, hostConcurrency, pageSize: commentPageSize, minDelayMs, jitterMs,
      laneSelection: selectedPoolEntries.length > 0 ? selectedPool.selection : undefined,
      proxyTransportMaxConcurrent: this.transportGate ? hostConcurrency : undefined,
      proxyTransportEffectiveConcurrent: this.transportGate?.currentMaxConcurrent,
      proxyTransportStartDelayMs: this.transportGate ? DEFAULT_PROXY_TRANSPORT_START_DELAY_MS : undefined,
      proxyTransportStartJitterMs: this.transportGate ? DEFAULT_PROXY_TRANSPORT_START_JITTER_MS : undefined,
      logPath: logger.path,
    };
    this.terminalStateSyncedId = undefined;
    await logger.write("info", "task_started", "用户来源扫描已启动。", {
      uid,
      source,
      recordScope,
      pageSize: commentPageSize,
      lanes: this.lanes.length,
      workers: workerCountForTopology(this.lanes.length, workersPerLane, hostConcurrency),
      requestBudget,
      minDelayMs,
      jitterMs,
      requestIntervalSemantics: "per-start-v1",
      laneSelection: selectedPoolEntries.length > 0 ? selectedPool.selection : undefined,
      proxyTransportMaxConcurrent: this.transportGate ? hostConcurrency : undefined,
      proxyTransportStartDelayMs: this.transportGate ? DEFAULT_PROXY_TRANSPORT_START_DELAY_MS : undefined,
      proxyTransportStartJitterMs: this.transportGate ? DEFAULT_PROXY_TRANSPORT_START_JITTER_MS : undefined,
    });
    try {
      await saveResumeTask(this.paths.resumeTask, {
        version: 3,
        platform: "netease",
        mode: "source",
        requestIntervalSemantics: "per-start-v1",
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
          maxProxyLanes,
          hostConcurrency,
          allowDirect,
        },
      });
    } catch (error) {
      await logger.write("warn", "resume_descriptor_failure", "未能保存任务参数；扫描检查点仍会正常写入。", {
        error: message(error),
      });
    }
    void runPooledCommentFinder(this.lanes, { ...options, workersPerLane, maxWorkers: hostConcurrency, requestBudget })
      .then((report) => {
        if (this.snapshotValue.id !== activeId) return;
        this.snapshotValue = {
          ...this.snapshotValue, status: report.status, finishedAt: new Date().toISOString(),
          songs: report.songs, songsProcessed: report.songsProcessed, matches: report.matches,
          catalogSongs: report.catalogSongs, reusedSongs: report.reusedSongs,
          historicalCompletedSongs: report.historicalCompletedSongs, newPendingSongs: report.newPendingSongs,
          requestsTotal: report.requestsTotal, coverageComplete: report.coverageComplete,
          pagesProcessed: report.pagesProcessed ?? 0, lanes: report.lanes ?? this.snapshotValue.lanes,
          commentsInspected: report.commentsInspected,
          workers: report.workers ?? this.snapshotValue.workers,
          commentsPerSecond: 0,
          proxyTransportEffectiveConcurrent: this.transportGate?.currentMaxConcurrent,
          sourceErrors: report.sourceErrors, blockedUntil: report.resumeAfter, note: report.note,
          currentSong: undefined, activeSongs: [],
        };
        this.activeSongByWorker.clear();
        this.activeSongProgress.clear();
        this.terminalStateSyncedId = activeId;
        void logger.write("info", "task_finished", `用户来源扫描结束：${report.status}。`, {
          status: report.status,
          matches: report.matches,
          requestsTotal: report.requestsTotal,
          pagesProcessed: report.pagesProcessed ?? 0,
          catalogSongs: report.catalogSongs,
          historicalCompletedSongs: report.historicalCompletedSongs,
          reusedSongs: report.reusedSongs,
          newPendingSongs: report.newPendingSongs,
          coverageComplete: report.coverageComplete,
          sourceErrors: report.sourceErrors,
          note: report.note,
        });
      })
      .catch((error) => {
        this.fail(activeId, error);
        void logger.write("error", "task_error", `用户来源扫描异常结束：${message(error)}`, { error: message(error) });
      })
      .finally(() => {
        if (this.snapshotValue.id === activeId) {
          this.activeSongByWorker.clear();
          this.activeSongProgress.clear();
          this.abortController = undefined;
          this.lanes = [];
          this.transportGate = undefined;
        }
        lease.release();
      });
    launched = true;
    return this.status();
    } finally {
      if (!launched) {
        this.abortController?.abort();
        this.abortController = undefined;
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
    this.abortController?.abort();
    this.transportGate?.cancel();
    for (const lane of this.lanes) lane.governor.cancel();
    return this.status();
  }

  async status(): Promise<JobSnapshot> {
    const active = ["running", "stopping"].includes(this.snapshotValue.status);
    const needsTerminalSync = Boolean(
      this.snapshotValue.id && this.terminalStateSyncedId !== this.snapshotValue.id,
    );
    if (this.statePath && !active && needsTerminalSync) {
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
          catalogSongs: state.sourceSongCount,
          reusedSongs: state.reusedSongs ?? 0,
          historicalCompletedSongs: state.historicalCompletedSongs ?? 0,
          newPendingSongs: state.newPendingSongs ?? 0,
          commentOffset: currentIndex < 0 ? 0 : progress[currentIndex]?.commentOffset ?? state.commentOffset,
          currentSong: activeCurrent ?? inferredCurrent,
          matches: state.matchCount, requestsTotal: state.requestCount,
          pagesProcessed: state.pagesProcessed ?? 0,
          commentsInspected: state.strategy === "history"
            ? state.commentOffset
            : state.songProgress?.reduce((total, progress) => total + progress.commentOffset, 0) ?? state.commentOffset,
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
    this.snapshotValue.commentsPerSecond = active ? this.commentRate.rate() : 0;
    Object.assign(this.snapshotValue, this.pagePerformance.snapshot());
    this.snapshotValue.proxyTransportEffectiveConcurrent = this.transportGate?.currentMaxConcurrent ?? this.snapshotValue.proxyTransportEffectiveConcurrent;
    return {
      ...this.snapshotValue,
      activeSongs: this.snapshotValue.activeSongs.map((song) => ({ ...song })),
      sourceErrors: [...this.snapshotValue.sourceErrors],
    };
  }

  async results(limit: number): Promise<{ jobId?: string; results: FoundComment[] }> {
    const jobId = this.snapshotValue.id;
    const outputPath = this.outputPath;
    const songNameById = new Map(this.songNameById);
    const results = await readJsonl(outputPath, limit);
    return {
      jobId,
      results: results.map((comment) => comment.songName || !comment.songId
        ? comment
        : { ...comment, songName: songNameById.get(comment.songId) }),
    };
  }
  async report(expectedJobId: string, expectedUid: string): Promise<ResultReport> {
    if (this.snapshotValue.id !== expectedJobId || this.snapshotValue.uid !== expectedUid) {
      throw new HttpError(409, "当前用户来源任务已经切换，请重新点击导出。");
    }
    const outputPath = this.outputPath;
    const songNameById = new Map(this.songNameById);
    const [fileSnapshot, snapshot] = await Promise.all([
      readResultReportSnapshot(outputPath),
      this.status(),
    ]);
    if (this.snapshotValue.id !== expectedJobId || this.snapshotValue.uid !== expectedUid
      || this.outputPath !== outputPath || snapshot.id !== expectedJobId || snapshot.uid !== expectedUid) {
      throw new HttpError(409, "当前用户来源任务已经切换，请重新点击导出。");
    }
    const comments = fileSnapshot.records.map((comment) => comment.songName || !comment.songId
      ? comment
      : { ...comment, songName: songNameById.get(comment.songId) });
    return {
      mode: "source",
      jobId: snapshot.id,
      uid: snapshot.uid!,
      status: snapshot.status,
      source: snapshot.source,
      startedAt: snapshot.startedAt,
      finishedAt: snapshot.finishedAt,
      elapsedMs: snapshot.elapsedMs,
      matches: snapshot.matches,
      requestsTotal: snapshot.requestsTotal,
      pagesProcessed: snapshot.pagesProcessed,
      commentsInspected: snapshot.commentsInspected,
      coverageLabel: snapshot.songs > 0
        ? `${snapshot.songsProcessed.toLocaleString("zh-CN")} / ${snapshot.songs.toLocaleString("zh-CN")} 首歌曲；`
          + `目录 ${snapshot.catalogSongs.toLocaleString("zh-CN")}，历史完成 ${snapshot.historicalCompletedSongs.toLocaleString("zh-CN")}，`
          + `复用 ${snapshot.reusedSongs.toLocaleString("zh-CN")}，新增待扫 ${snapshot.newPendingSongs.toLocaleString("zh-CN")}`
        : "等待歌曲目录",
      exportedAt: new Date().toISOString(),
      comments: comments.reverse(),
    };
  }
  async logs(limit: number): Promise<{ path?: string; entries: Awaited<ReturnType<typeof readTaskLog>> }> {
    return { path: this.snapshotValue.logPath, entries: await readTaskLog(this.snapshotValue.logPath, limit) };
  }

  subscribeMatches(subscriber: MatchSubscriber): () => void {
    this.matchSubscribers.add(subscriber);
    return () => this.matchSubscribers.delete(subscriber);
  }

  private publishMatch(comment: FoundComment): void {
    const enriched = comment.songName || !comment.songId
      ? comment
      : { ...comment, songName: this.songNameById.get(comment.songId) };
    for (const subscriber of this.matchSubscribers) {
      try { subscriber(enriched); } catch { /* One disconnected UI must not block other subscribers. */ }
    }
  }

  private trackActiveSong(activeId: string, activity: ScanRequestActivity): void {
    if (this.snapshotValue.id !== activeId || !activity.workerId) return;
    if (activity.phase === "start") {
      this.activeSongByWorker.set(activity.workerId, {
        id: activity.songId,
        name: activity.songName,
        requestingPage: activity.page,
        requestStartedAt: requestStartedAt(activity.startedAt),
        active: true,
      });
    } else {
      const scheduled = this.activeSongByWorker.get(activity.workerId);
      if (scheduled?.id === activity.songId) {
        scheduled.active = false;
        scheduled.requestingPage = undefined;
        scheduled.requestStartedAt = undefined;
      }
    }
    this.publishActiveSongs(activeId);
  }

  private publishActiveSongs(activeId: string): void {
    if (this.snapshotValue.id !== activeId) return;
    const songs = new Map<string, ActiveSongSnapshot>();
    for (const active of this.activeSongByWorker.values()) {
      const existing = songs.get(active.id);
      if (existing) {
        existing.workers += active.active ? 1 : 0;
        existing.name ??= active.name;
        if (active.requestingPage !== undefined) {
          existing.requestingPage = Math.min(existing.requestingPage ?? active.requestingPage, active.requestingPage);
        }
        if (active.requestStartedAt !== undefined) {
          existing.requestStartedAt = Math.min(existing.requestStartedAt ?? active.requestStartedAt, active.requestStartedAt);
        }
      } else {
        songs.set(active.id, {
          id: active.id,
          name: active.name ?? this.songNameById.get(active.id),
          workers: active.active ? 1 : 0,
          ...this.activeSongProgress.get(active.id),
          requestingPage: active.requestingPage,
          requestStartedAt: active.requestStartedAt,
        });
      }
    }
    for (const [id, progress] of this.activeSongProgress) {
      if (songs.has(id)) continue;
      songs.set(id, { id, workers: 0, ...progress });
    }
    this.snapshotValue = { ...this.snapshotValue, activeSongs: [...songs.values()] };
  }

  private removeScheduledSong(songId: string): void {
    for (const [workerId, scheduled] of this.activeSongByWorker) {
      if (scheduled.id === songId) this.activeSongByWorker.delete(workerId);
    }
    this.activeSongProgress.delete(songId);
  }

  private trimActiveSongProgress(): void {
    if (this.activeSongProgress.size <= ACTIVE_SONG_PROGRESS_LIMIT) return;
    const activeIds = new Set([...this.activeSongByWorker.values()].map((song) => song.id));
    for (const songId of this.activeSongProgress.keys()) {
      if (activeIds.has(songId)) continue;
      this.activeSongProgress.delete(songId);
      if (this.activeSongProgress.size <= ACTIVE_SONG_PROGRESS_LIMIT) return;
    }
  }

  private fail(activeId: string | undefined, error: unknown): void {
    if (this.snapshotValue.id !== activeId) return;
    this.activeSongByWorker.clear();
    this.activeSongProgress.clear();
    this.snapshotValue = { ...this.snapshotValue, activeSongs: [], status: "error", finishedAt: new Date().toISOString(), commentsPerSecond: 0, error: message(error) };
  }
}

class ParallelJobManager {
  private snapshotValue: ParallelJobSnapshot = emptyParallelSnapshot();
  private lanes: ParallelCommentLane[] = [];
  private transportGate?: ProxyTransportGate;
  private statePath?: string;
  private outputPath?: string;
  private terminalStateSyncedId?: string;
  private abortController?: AbortController;
  private readonly activeWorkers = new Map<string, number>();
  private readonly matchSubscribers = new Set<MatchSubscriber>();
  private readonly commentRate = new CommentRateTracker();
  private readonly pagePerformance = new PagePerformanceTracker();

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
    const maxProxyLanes = integer(input.maxProxyLanes ?? 0, "maxProxyLanes", 0, 32);
    const hostConcurrency = integer(
      input.hostConcurrency ?? DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT,
      "hostConcurrency",
      1,
      32,
    );
    const shardCount = integer(input.shards ?? 96, "shards", 1, 512);
    const pageSize = integer(input.pageSize ?? 1_000, "pageSize", 1, 2_000);
    const requestBudget = integer(input.requestBudget ?? 0, "requestBudget", 0, 100_000);
    const maxPages = integer(input.maxPages ?? 0, "maxPages", 0, 1_000_000);
    const minDelayMs = integer(input.minDelayMs ?? 111, "minDelayMs", 0, 600_000);
    const jitterMs = integer(input.jitterMs ?? 34, "jitterMs", 0, 600_000);
    const forbiddenCooldownMs = integer(input.forbiddenCooldownMs ?? 900_000, "forbiddenCooldownMs", 1_000, 86_400_000);
    const pool = await readProxyPool(this.paths.pool);
    if (!pool || !proxyPoolStatusRunning(pool)) throw new HttpError(409, "代理池尚未运行。");
    const entries = recentlyVerifiedProxyPoolEntries(pool) ?? await verifyProxyPool(pool);
    if (entries.length === 0) {
      throw new HttpError(409, "代理池复核后没有可用出口；已阻止回退到本机直连，请重新构建代理池。");
    }
    const selectedPool = selectProxyLanes(
      entries,
      maxProxyLanes,
      workersPerLane,
      hostConcurrency,
    );
    this.transportGate = new ProxyTransportGate({ maxConcurrent: hostConcurrency });
    this.lanes = selectedPool.entries.map((entry, index) => ({
      name: `proxy-${index + 1}`,
      client: new EnhancedNcmClient({ proxy: entry.endpoint }),
      transportGate: this.transportGate,
      governor: new RequestGovernor({
        requestBudget: requestBudget === 0 ? 0 : Math.max(1_000, requestBudget * 2), minDelayMs, jitterMs,
        maxRetries: 2, forbiddenCooldownMs,
      }),
    }));
    const song = await executeProxyRequest(this.lanes[0], `song_detail:${songId}`, () => this.lanes[0].client.getSongInfo(songId));
    const previousPath = join(this.paths.data, `parallel-state-${uid}-${songId}.json`);
    const previous = bool(input.fresh) ? undefined : await loadParallelState(previousPath);
    this.statePath = previousPath;
    this.outputPath = join(this.paths.data, `parallel-comments-${uid}-${songId}.jsonl`);
    const activeId = randomUUID();
    this.abortController = new AbortController();
    this.activeWorkers.clear();
    this.commentRate.reset();
    this.pagePerformance.reset();
    const logger = new TaskLogger(
      join(this.paths.data, "logs", `parallel-${activeId}.jsonl`),
      "parallel",
      activeId,
    );
    this.snapshotValue = {
      ...emptyParallelSnapshot(), id: activeId, status: "running", uid, songId,
      songName: song.name, activeSongs: [{ id: songId, name: song.name, workers: 0 }], startedAt, lanes: this.lanes.length,
      laneSelection: selectedPool.selection,
      workers: workerCountForTopology(this.lanes.length, workersPerLane, hostConcurrency), shards: shardCount,
      workersPerLane, hostConcurrency, configuredShardCount: shardCount, pageSize, minDelayMs, jitterMs,
      proxyTransportMaxConcurrent: hostConcurrency,
      proxyTransportEffectiveConcurrent: this.transportGate.currentMaxConcurrent,
      proxyTransportStartDelayMs: DEFAULT_PROXY_TRANSPORT_START_DELAY_MS,
      proxyTransportStartJitterMs: DEFAULT_PROXY_TRANSPORT_START_JITTER_MS,
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
      workers: workerCountForTopology(this.lanes.length, workersPerLane, hostConcurrency),
      requestBudget,
      minDelayMs,
      jitterMs,
      requestIntervalSemantics: "per-start-v1",
      laneSelection: selectedPool.selection,
      proxyTransportMaxConcurrent: hostConcurrency,
      proxyTransportStartDelayMs: DEFAULT_PROXY_TRANSPORT_START_DELAY_MS,
      proxyTransportStartJitterMs: DEFAULT_PROXY_TRANSPORT_START_JITTER_MS,
    });
    try {
      await saveResumeTask(this.paths.resumeTask, {
        version: 3,
        platform: "netease",
        mode: "parallel",
        requestIntervalSemantics: "per-start-v1",
        updatedAt: new Date().toISOString(),
        input: {
          uid,
          songId,
          workersPerProxy: workersPerLane,
          maxProxyLanes,
          hostConcurrency,
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
      maxWorkers: hostConcurrency,
      requestBudget, maxPages, stopAfterFirst: false,
      fresh: bool(input.fresh), statePath: this.statePath, outputPath: this.outputPath,
      signal: this.abortController.signal,
      onMatch: (comment) => this.publishMatch(comment),
      onCheckpoint: (activity) => {
        if (this.snapshotValue.id !== activeId) return;
        this.snapshotValue = { ...this.snapshotValue, ...activity };
      },
      onRequestActivity: (activity) => {
        this.pagePerformance.record(activity);
        if (activity.phase === "success") this.commentRate.record(activity.comments ?? 0);
        logger.request(activity);
        this.trackActiveSong(activeId, activity);
      },
      onSchedulerActivity: (activity) => logger.scheduler(activity),
    }).then((report) => {
      if (this.snapshotValue.id !== activeId) return;
      this.snapshotValue = {
        ...this.snapshotValue, ...report, status: report.status,
        activeSongs: [], finishedAt: new Date().toISOString(), commentsPerSecond: 0,
        proxyTransportEffectiveConcurrent: this.transportGate?.currentMaxConcurrent,
        note: report.note,
      };
      this.activeWorkers.clear();
      this.terminalStateSyncedId = activeId;
      void logger.write("info", "task_finished", `单曲并行扫描结束：${report.status}。`, {
        status: report.status,
        matches: report.matches,
        requestsTotal: report.requestsTotal,
        pagesProcessed: report.pagesProcessed,
        commentsInspected: report.commentsInspected,
        shardsComplete: report.shardsComplete,
        note: report.note,
      });
    }).catch((error) => {
      if (this.snapshotValue.id !== activeId) return;
      this.activeWorkers.clear();
      this.snapshotValue = { ...this.snapshotValue, activeSongs: [], status: "error", finishedAt: new Date().toISOString(), commentsPerSecond: 0, error: message(error) };
      void logger.write("error", "task_error", `单曲并行扫描异常结束：${message(error)}`, { error: message(error) });
    }).finally(() => {
      if (this.snapshotValue.id === activeId) {
        this.activeWorkers.clear();
        this.abortController = undefined;
        this.lanes = [];
        this.transportGate = undefined;
      }
      lease.release();
    });
    launched = true;
    return this.status();
    } finally {
      if (!launched) {
        this.abortController?.abort();
        this.abortController = undefined;
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
    this.abortController?.abort();
    this.transportGate?.cancel();
    for (const lane of this.lanes) lane.governor.cancel();
    return this.status();
  }

  async status(): Promise<ParallelJobSnapshot> {
    const active = ["running", "stopping"].includes(this.snapshotValue.status);
    const needsTerminalSync = Boolean(
      this.snapshotValue.id && this.terminalStateSyncedId !== this.snapshotValue.id,
    );
    if (this.statePath && !active && needsTerminalSync) {
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
    this.snapshotValue.commentsPerSecond = active ? this.commentRate.rate() : 0;
    Object.assign(this.snapshotValue, this.pagePerformance.snapshot());
    this.snapshotValue.proxyTransportEffectiveConcurrent = this.transportGate?.currentMaxConcurrent ?? this.snapshotValue.proxyTransportEffectiveConcurrent;
    return {
      ...this.snapshotValue,
      activeSongs: this.snapshotValue.activeSongs.map((song) => ({
        ...song,
        pagesProcessed: this.snapshotValue.pagesProcessed,
        commentsProcessed: this.snapshotValue.commentsInspected,
        totalComments: this.snapshotValue.totalComments,
        progressPercent: this.snapshotValue.coveragePercent,
        progressBasis: "time",
      })),
    };
  }

  async results(limit: number): Promise<{ jobId?: string; results: FoundComment[] }> {
    const jobId = this.snapshotValue.id;
    const outputPath = this.outputPath;
    return { jobId, results: await readJsonl(outputPath, limit) };
  }
  async report(expectedJobId: string, expectedUid: string): Promise<ResultReport> {
    if (this.snapshotValue.id !== expectedJobId || this.snapshotValue.uid !== expectedUid) {
      throw new HttpError(409, "当前单曲任务已经切换，请重新点击导出。");
    }
    const outputPath = this.outputPath;
    const [fileSnapshot, snapshot] = await Promise.all([
      readResultReportSnapshot(outputPath),
      this.status(),
    ]);
    if (this.snapshotValue.id !== expectedJobId || this.snapshotValue.uid !== expectedUid
      || this.outputPath !== outputPath || snapshot.id !== expectedJobId || snapshot.uid !== expectedUid) {
      throw new HttpError(409, "当前单曲任务已经切换，请重新点击导出。");
    }
    const comments = fileSnapshot.records;
    return {
      mode: "parallel",
      jobId: snapshot.id,
      uid: snapshot.uid!,
      status: snapshot.status,
      songId: snapshot.songId,
      songName: snapshot.songName,
      startedAt: snapshot.startedAt,
      finishedAt: snapshot.finishedAt,
      elapsedMs: snapshot.elapsedMs,
      matches: snapshot.matches,
      requestsTotal: snapshot.requestsTotal,
      pagesProcessed: snapshot.pagesProcessed,
      commentsInspected: snapshot.commentsInspected,
      coverageLabel: `${Math.max(0, Math.min(100, snapshot.coveragePercent)).toFixed(1)}% 时间范围`,
      exportedAt: new Date().toISOString(),
      comments: comments.reverse(),
    };
  }
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

  private trackActiveSong(activeId: string, activity: ScanRequestActivity): void {
    if (this.snapshotValue.id !== activeId || !activity.workerId) return;
    if (activity.phase === "start") {
      this.activeWorkers.set(
        activity.workerId,
        requestStartedAt(activity.startedAt),
      );
    } else {
      this.activeWorkers.delete(activity.workerId);
    }
    this.snapshotValue = {
      ...this.snapshotValue,
      activeSongs: [{
        id: activity.songId,
        name: activity.songName ?? this.snapshotValue.songName,
        workers: this.activeWorkers.size,
        requestStartedAt: this.activeWorkers.size > 0
          ? Math.min(...this.activeWorkers.values())
          : undefined,
      }],
    };
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
      managementNotice: pool?.managementNotice,
      sourceConfigPath: pool?.sourceConfigPath,
      sourceConfigPaths: pool?.sourceConfigPaths,
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
        sourceConfigPaths: validateClashConfigSelection(
          input.sourceConfigPaths ?? input.sourceConfigPath,
          this.discovery(),
        ) ?? defaults.sourceConfigPaths,
        mihomoPath: optionalPath(input.mihomoPath) ?? defaults.mihomoPath,
        workDirectory: this.paths.poolWork,
        poolPath: this.paths.pool,
        size: integer(input.size ?? defaults.size, "size", 1, 32),
        candidateCount: integer(input.candidates ?? defaults.candidateCount, "candidates", 1, 128),
      });
      this.nextRefreshAt = Date.now() + this.refreshIntervalMs;
      this.refreshError = undefined;
    } finally { this.starting = false; lease.release(); }
    return this.status();
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
    } finally { this.starting = false; lease.release(); }
    return this.status();
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
  const qq = new QQJobManager({
    paths: { data: paths.data, pool: paths.pool, resumeTask: paths.resumeTask },
    coordinator,
    resumeWriter: saveResumeTask,
    ...(options.qqClientFactory ? { clientFactory: options.qqClientFactory } : {}),
    ...(options.qqRunner ? { runner: options.qqRunner } : {}),
  });
  const pool = new PoolManager(
    paths,
    options.poolRefreshIntervalMs ?? 60_000,
    options.poolRefresher ?? refreshProxyPool,
    coordinator,
    options.poolDiscoveryIntervalMs ?? 30_000,
    options.poolDiscoverer ?? discoverClashVerge,
  );
  const auth = new AuthManager(paths);
  const userProbes = new UserProbeRouter(paths.cookie, paths.pool);
  const songSearch = new NcmSongSearchRouter(paths.pool, options.songSearchRouter);
  const currentVersion = options.currentVersion ?? await applicationVersion();
  const updateChecker = cachedUpdateChecker(options.updateChecker ?? (() => checkForUpdate({
    currentVersion,
    platform: options.platform,
    arch: options.arch,
  })));
  const updatePreparation = new UpdatePreparationGate(coordinator);
  const server = createServer(async (request, response) => {
    try { await route(request, response, paths, coordinator, jobs, parallel, qq, pool, auth, userProbes, songSearch, updateChecker, updatePreparation); }
    catch (error) {
      if (response.destroyed) return;
      const classicError = error instanceof ClassicEncryptUinError;
      const status = error instanceof HttpError || error instanceof QQJobManagerError
        ? error.status
        : classicError ? 400 : 500;
      if (!response.headersSent) json(response, status, {
        error: message(error),
        ...(classicError ? { code: error.code } : {}),
      });
      else if (!response.destroyed) response.end();
    }
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => { server.off("error", reject); done(); });
  });
  return server;
}

async function route(
  request: IncomingMessage, response: ServerResponse, paths: RuntimePaths,
  coordinator: TaskCoordinator,
  jobs: JobManager, parallel: ParallelJobManager, qq: QQJobManager,
  pool: PoolManager, auth: AuthManager,
  userProbes: UserProbeRouter,
  songSearch: NcmSongSearchRouter,
  updateChecker: () => Promise<UpdateSnapshot>,
  updatePreparation: UpdatePreparationGate,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");
  if (method === "GET" && url.pathname === "/api/health") return json(response, 200, { ok: true, time: new Date().toISOString() });
  if (method === "GET" && url.pathname === "/api/update") return json(response, 200, await updateChecker());
  if (method === "GET" && url.pathname === "/api/preferences") {
    return json(response, 200, await readUiPreferences(paths.uiPreferences));
  }
  if (method === "POST" && url.pathname === "/api/preferences") {
    const input = jsonObject(await body(request));
    const platformTransitionPattern = input.platformTransitionPattern;
    if (platformTransitionPattern !== "diagonal" && platformTransitionPattern !== "ripple") {
      throw new HttpError(400, "平台切换动效只支持 diagonal 或 ripple。");
    }
    return json(response, 200, await saveUiPreferences(paths.uiPreferences, platformTransitionPattern));
  }
  if (method === "GET" && url.pathname === "/api/tasks/active") {
    return json(response, 200, {
      active: coordinator.isBusy(),
      mode: coordinator.activeMode(),
    });
  }
  if (method === "POST" && url.pathname === "/api/tasks/stop") {
    await stopActiveTask(coordinator, jobs, parallel, qq);
    return json(response, 200, {
      active: coordinator.isBusy(),
      mode: coordinator.activeMode(),
    });
  }
  if (method === "POST" && url.pathname === "/api/tasks/prepare-update") {
    updatePreparation.begin();
    try {
      if (coordinator.activeMode() !== "pool") {
        await stopActiveTask(coordinator, jobs, parallel, qq);
      }
    } catch (error) {
      updatePreparation.cancel();
      throw error;
    }
    return json(response, 200, {
      active: coordinator.isBusy(),
      mode: coordinator.activeMode(),
      preparingUpdate: true,
    });
  }
  if (method === "POST" && url.pathname === "/api/tasks/cancel-update") {
    updatePreparation.cancel();
    return json(response, 200, {
      active: coordinator.isBusy(),
      mode: coordinator.activeMode(),
      preparingUpdate: false,
    });
  }
  if (method === "GET" && url.pathname === "/api/resume") {
    return json(response, 200, await migrateResumeTaskForClient(paths.resumeTask));
  }
  if (method === "GET" && url.pathname === "/api/job") return json(response, 200, await jobs.status());
  if (method === "POST" && url.pathname === "/api/job") return json(response, 202, await jobs.start(await body(request)));
  if (method === "POST" && url.pathname === "/api/job/stop") return json(response, 200, await jobs.stop());
  if (method === "GET" && url.pathname === "/api/results/stream") return streamMatches(request, response, (subscriber) => jobs.subscribeMatches(subscriber));
  if (method === "GET" && url.pathname === "/api/results") return json(response, 200, await jobs.results(limit(url)));
  if (method === "GET" && url.pathname === "/api/parallel/job") return json(response, 200, await parallel.status());
  if (method === "POST" && url.pathname === "/api/parallel/job") return json(response, 202, await parallel.start(await body(request)));
  if (method === "POST" && url.pathname === "/api/parallel/job/stop") return json(response, 200, await parallel.stop());
  if (method === "GET" && url.pathname === "/api/parallel/results/stream") return streamMatches(request, response, (subscriber) => parallel.subscribeMatches(subscriber));
  if (method === "GET" && url.pathname === "/api/parallel/results") return json(response, 200, await parallel.results(limit(url)));
  if (method === "GET" && url.pathname === "/api/qq/job") return json(response, 200, await qq.status());
  if (method === "POST" && url.pathname === "/api/qq/job") return json(response, 202, await qq.start(await body(request)));
  if (method === "POST" && url.pathname === "/api/qq/job/stop") return json(response, 200, await qq.stop());
  if (method === "GET" && url.pathname === "/api/qq/results/stream") {
    const jobId = reportJobId(url.searchParams.get("jobId"));
    return streamMatches(request, response, (subscriber) => qq.subscribeMatches(jobId, subscriber));
  }
  if (method === "GET" && url.pathname === "/api/qq/results") {
    return json(response, 200, await qq.results(reportJobId(url.searchParams.get("jobId")), limit(url)));
  }
  if (method === "GET" && url.pathname === "/report/results") {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      throw new HttpError(403, "结果报告仅允许从本机访问。");
    }
    const legacyUid = url.searchParams.get("uid");
    const platform = selection(url.searchParams.get("platform") ?? (legacyUid ? "netease" : null), ["netease", "qq"] as const, "platform");
    const jobId = reportJobId(url.searchParams.get("jobId"));
    const targetKind = selection(url.searchParams.get("targetKind") ?? (legacyUid ? "uid" : null), ["uid", "encryptUin"] as const, "targetKind");
    const target = reportTarget(url.searchParams.get("target") ?? legacyUid);
    let report: ResultReport;
    if (platform === "qq") {
      const mode = selection(url.searchParams.get("mode"), ["song", "likes"] as const, "mode");
      if (targetKind !== "encryptUin") throw new HttpError(400, "QQ 音乐报告目标类型必须是 encryptUin。");
      const generation: QQJobGeneration = { platform: "qq", mode, jobId, target: { kind: "encryptUin", value: target } };
      report = await qq.report(generation);
    } else {
      const mode = selection(url.searchParams.get("mode"), ["source", "parallel"] as const, "mode");
      if (targetKind !== "uid") throw new HttpError(400, "网易云报告目标类型必须是 uid。");
      const uid = numericId(target, "UID");
      report = mode === "parallel" ? await parallel.report(jobId, uid) : await jobs.report(jobId, uid);
    }
    return html(response, renderResultReportHtml(report));
  }
  if (method === "GET" && url.pathname === "/api/logs") {
    const logMode = selection(url.searchParams.get("mode") ?? "source", ["source", "parallel", "qq"] as const, "mode");
    return json(response, 200, logMode === "parallel"
      ? await parallel.logs(limit(url))
      : logMode === "qq"
      ? await qq.logs(reportJobId(url.searchParams.get("jobId")), limit(url))
      : await jobs.logs(limit(url)));
  }
  if (method === "GET" && url.pathname === "/api/pool") return json(response, 200, await pool.status());
  if (method === "POST" && url.pathname === "/api/pool/start") return json(response, 202, await pool.start(await body(request)));
  if (method === "POST" && url.pathname === "/api/pool/import") return json(response, 202, await pool.import(await body(request)));
  if (method === "POST" && url.pathname === "/api/pool/stop") return json(response, 200, await pool.stop());
  if (method === "POST" && url.pathname === "/api/qq/encrypt-uin/decode") {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      throw new HttpError(403, "EncryptUin 解析实验仅允许从本机访问。");
    }
    const input = jsonObject(await body(request));
    if (Object.hasOwn(input, "input") && Object.hasOwn(input, "encryptUin")) {
      throw new HttpError(400, "请求体不能同时包含 input 和 encryptUin。");
    }
    const resolved = await withRequestAbortSignal(request, response, (signal) =>
      qq.resolveClassicEncryptUinInput(
        input.input ?? input.encryptUin,
        input.proxy,
        input.allowDirect,
        signal,
      )
    );
    return json(response, 200, resolved);
  }
  if (method === "POST" && url.pathname === "/api/qq/encrypt-uin/verify") {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      throw new HttpError(403, "EncryptUin 在线验证仅允许从本机访问。");
    }
    const input = jsonObject(await body(request));
    const verification = await withRequestAbortSignal(request, response, (signal) =>
      qq.verifyClassicEncryptUin(
        input.encryptUin,
        input.proxy,
        input.allowDirect,
        signal,
      )
    );
    return json(response, 200, verification);
  }
  if (method === "GET" && url.pathname === "/api/song") {
    const song = await songSearch.lookup(
      numericId(url.searchParams.get("id"), "歌曲 ID"),
      proxyUrl(url.searchParams.get("proxy")),
    );
    return json(response, 200, song);
  }
  if (method === "GET" && url.pathname === "/api/song/search") {
    const query = searchQuery(url.searchParams.get("q"));
    return json(response, 200, await songSearch.run(
      query,
      integer(url.searchParams.get("limit") ?? 10, "limit", 1, 10),
      proxyUrl(url.searchParams.get("proxy")),
    ));
  }
  if (method === "GET" && url.pathname === "/api/qq/song") {
    const song = await withRequestAbortSignal(request, response, (signal) => qq.lookupSong(
      numericId(url.searchParams.get("id"), "QQ 音乐歌曲 ID"),
      url.searchParams.get("proxy"),
      url.searchParams.get("allowDirect") === "1",
      signal,
    ));
    return json(response, 200, song);
  }
  if (method === "GET" && url.pathname === "/api/qq/song/search") {
    const query = searchQuery(url.searchParams.get("q"));
    const songs = await withRequestAbortSignal(request, response, (signal) => qq.searchSongs(
      query,
      integer(url.searchParams.get("limit") ?? 10, "limit", 1, 10),
      url.searchParams.get("proxy"),
      url.searchParams.get("allowDirect") === "1",
      signal,
    ));
    return json(response, 200, {
      platform: "qq",
      query,
      songs,
    } satisfies SongSearchResponse);
  }
  if (method === "GET" && url.pathname === "/api/estimate") {
    const estimatePlatform = selection(url.searchParams.get("platform") ?? "netease", ["netease", "qq"] as const, "platform");
    const estimateMode = estimatePlatform === "qq"
      ? selection(url.searchParams.get("mode"), ["song", "likes"] as const, "mode")
      : selection(url.searchParams.get("mode") ?? "source", ["source", "parallel"] as const, "mode");
    const serialRequestChain = estimatePlatform === "qq" && estimateMode === "song";
    const hostConcurrency = integer(
      url.searchParams.get("hostConcurrency") ?? DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT,
      "hostConcurrency",
      1,
      32,
    );
    const estimateLanes = integer(url.searchParams.get("lanes") ?? 1, "lanes", 1, 256);
    const estimateWorkersPerLane = integer(
      url.searchParams.get("workersPerLane") ?? 1,
      "workersPerLane",
      1,
      estimatePlatform === "qq" ? 32 : 16,
    );
    const qqTransport = estimatePlatform === "qq"
      ? qqMusicTransportProfile(
        estimateMode as "song" | "likes",
        estimateLanes,
        serialRequestChain ? 1 : Math.min(estimateLanes * estimateWorkersPerLane, hostConcurrency),
      )
      : undefined;
    const defaultEstimateSpacing = estimatePlatform === "qq"
      ? { minDelayMs: 300, jitterMs: 100 }
      : estimateMode === "parallel"
        ? { minDelayMs: 111, jitterMs: 34 }
        : { minDelayMs: 2_500, jitterMs: 800 };
    return json(response, 200, estimateCommentScan({
      platform: estimatePlatform,
      comments: integer(url.searchParams.get("comments") ?? 100_000, "comments", 0, 100_000_000),
      pageSize: integer(
        url.searchParams.get("pageSize") ?? (estimatePlatform === "qq" ? 25 : 1_000),
        estimatePlatform === "qq" ? "QQ 音乐评论 pageSize" : "pageSize",
        1,
        estimatePlatform === "qq" ? 25 : 2_000,
      ),
      partitions: url.searchParams.has("partitions")
        ? integer(url.searchParams.get("partitions"), "partitions", 1, 100_000)
        : undefined,
      observedCommentsPerPage: optionalNumber(url.searchParams.get("observedCommentsPerPage"), "observedCommentsPerPage", 0.01, 2_000),
      requestSuccessRatio: optionalNumber(url.searchParams.get("requestSuccessRatio"), "requestSuccessRatio", 0.0001, 1),
      minDelayMs: integer(url.searchParams.get("minDelayMs") ?? defaultEstimateSpacing.minDelayMs, "minDelayMs", 0, 600_000),
      jitterMs: integer(url.searchParams.get("jitterMs") ?? defaultEstimateSpacing.jitterMs, "jitterMs", 0, 600_000),
      networkMs: integer(url.searchParams.get("networkMs") ?? 400, "networkMs", 0, 600_000),
      lanes: estimateLanes,
      workersPerLane: estimateWorkersPerLane,
      maxWorkers: serialRequestChain ? 1 : hostConcurrency,
      proxyTransport: url.searchParams.get("proxyTransport") === "1",
      proxyTransportMaxConcurrent: integer(
        estimatePlatform === "qq" ? qqTransport!.maxConcurrent : url.searchParams.get("hostConcurrency") ?? DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT,
        estimatePlatform === "qq" ? "QQ 音乐传输并发" : "hostConcurrency",
        1,
        32,
      ),
      proxyTransportEffectiveConcurrent: integer(
        estimatePlatform === "qq"
          ? url.searchParams.get("proxyTransportEffectiveConcurrent") ?? qqTransport!.maxConcurrent
          : url.searchParams.get("proxyTransportEffectiveConcurrent")
          ?? url.searchParams.get("hostConcurrency")
          ?? DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT,
        "proxyTransportEffectiveConcurrent",
        1,
        32,
      ),
      proxyTransportStartDelayMs: estimatePlatform === "qq" ? qqTransport!.minStartDelayMs : undefined,
      proxyTransportStartJitterMs: estimatePlatform === "qq" ? 0 : undefined,
      checkpointSlots: qqTransport?.checkpointSlots,
      serialRequestChain,
    }));
  }
  if (method === "GET" && url.pathname === "/api/user") {
    return json(response, 200, await userProbes.run(
      numericId(url.searchParams.get("uid"), "UID"),
      proxyUrl(url.searchParams.get("proxy")),
    ));
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

async function stopActiveTask(
  coordinator: TaskCoordinator,
  jobs: JobManager,
  parallel: ParallelJobManager,
  qq: QQJobManager,
): Promise<void> {
  const activeMode = coordinator.activeMode();
  if (activeMode === "source") await jobs.stop();
  else if (activeMode === "parallel") await parallel.stop();
  else if (activeMode === "qq") await qq.stop();
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
    uiPreferences: join(data, "ui-preferences.json"),
  };
}

function defaultUiPreferences(): UiPreferences {
  return {
    version: 1,
    platformTransitionPattern: "diagonal",
    updatedAt: new Date(0).toISOString(),
  };
}

async function readUiPreferences(path: string): Promise<UiPreferences> {
  return withUiPreferencesLock(path, async () => {
    try {
      return await readAtomicJson(path, decodeUiPreferences) ?? defaultUiPreferences();
    } catch (error) {
      if (error instanceof SyntaxError) return defaultUiPreferences();
      throw error;
    }
  });
}

async function saveUiPreferences(
  path: string,
  platformTransitionPattern: PlatformTransitionPattern,
): Promise<UiPreferences> {
  return withUiPreferencesLock(path, async () => {
    const preferences: UiPreferences = {
      version: 1,
      platformTransitionPattern,
      updatedAt: new Date().toISOString(),
    };
    await writeAtomicJson(path, preferences);
    return preferences;
  });
}

function decodeUiPreferences(value: unknown): UiPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("Invalid UI preferences.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1
    || (candidate.platformTransitionPattern !== "diagonal" && candidate.platformTransitionPattern !== "ripple")
    || typeof candidate.updatedAt !== "string"
    || !Number.isFinite(Date.parse(candidate.updatedAt))
    || new Date(candidate.updatedAt).toISOString() !== candidate.updatedAt
  ) {
    throw new SyntaxError("Invalid UI preferences.");
  }
  return candidate as unknown as UiPreferences;
}

async function withUiPreferencesLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: 30_000,
    retries: { retries: 20, factor: 1.2, minTimeout: 5, maxTimeout: 100, randomize: true },
  });
  try {
    return await operation();
  } finally {
    await release().catch(() => {});
  }
}

async function saveResumeTask(path: string, descriptor: unknown): Promise<void> {
  await withResumeTaskLock(path, () => writeAtomicJson(path, descriptor));
}

async function migrateResumeTaskForClient(
  path: string,
): Promise<{ task: ResumeTaskDescriptor; adjustments?: string[] } | { task: null }> {
  return withResumeTaskLock(path, async () => {
    const descriptor = await readResumeTask(path);
    if (!descriptor) return { task: null };
    const normalized = normalizeResumeTaskForClient(descriptor);
    if (descriptor.version !== 3) await writeAtomicJson(path, normalized.task);
    return normalized;
  });
}

async function withResumeTaskLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: 120_000,
    update: 20_000,
    retries: { retries: 40, factor: 1.2, minTimeout: 5, maxTimeout: 100, randomize: true },
  });
  try {
    return await operation();
  } finally {
    await release().catch(() => {});
  }
}

export function normalizeResumeTaskForClient(
  descriptor: ResumeTaskDescriptor,
): { task: ResumeTaskDescriptor; adjustments?: string[] } {
  const platform = descriptor.version === 1 ? "netease" : descriptor.platform;
  let input = { ...descriptor.input };
  const adjustments: string[] = [];
  if (platform === "netease" && descriptor.version !== 3) {
    const workersFallback = descriptor.mode === "parallel" ? 3 : 1;
    const oldMinFallback = descriptor.mode === "parallel" ? 333 : 2_500;
    const oldJitterFallback = descriptor.mode === "parallel" ? 100 : 800;
    const workers = positiveResumeInteger(input.workersPerProxy, workersFallback);
    const oldMin = nonNegativeResumeInteger(input.minDelayMs, oldMinFallback);
    const oldJitter = nonNegativeResumeInteger(input.jitterMs, oldJitterFallback);
    const minDelayMs = Math.ceil(oldMin / workers);
    const jitterMs = oldJitter === 0
      ? 0
      : Math.max(0, Math.ceil((oldMin + oldJitter - 1) / workers) - minDelayMs + 1);
    input = { ...input, minDelayMs, jitterMs };
    adjustments.push("netease-request-spacing-per-start-v1");
  }
  if (platform === "qq") {
    const savedPageSize = Number(input.pageSize);
    if (Number.isInteger(savedPageSize) && savedPageSize > 25) {
      input.pageSize = 25;
      adjustments.push("qq-comment-page-size-25");
    }
  }
  const task: CurrentResumeTaskDescriptor = {
    version: 3,
    platform,
    mode: descriptor.mode,
    requestIntervalSemantics: "per-start-v1",
    updatedAt: descriptor.updatedAt,
    input,
  };
  return adjustments.length > 0 ? { task, adjustments } : { task };
}

function positiveResumeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeResumeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

async function readResumeTask(path: string): Promise<ResumeTaskDescriptor | undefined> {
  try {
    return await readAtomicJson(path, (parsed) => {
      const value = parsed as Partial<ResumeTaskDescriptor>;
      const validLegacy = value.version === 1
        && (value.mode === "source" || value.mode === "parallel");
      const validPlatform = value.version === 2
        && (value.platform === "netease" || value.platform === "qq")
        && (value.platform === "netease"
          ? value.mode === "source" || value.mode === "parallel"
          : value.mode === "song" || value.mode === "likes");
      const validCurrent = value.version === 3
        && value.requestIntervalSemantics === "per-start-v1"
        && (value.platform === "netease" || value.platform === "qq")
        && (value.platform === "netease"
          ? value.mode === "source" || value.mode === "parallel"
          : value.mode === "song" || value.mode === "likes");
      if (
        (!validLegacy && !validPlatform && !validCurrent) ||
        typeof value.updatedAt !== "string" ||
        !value.input ||
        typeof value.input !== "object" ||
        Array.isArray(value.input) ||
        !Object.values(value.input).every((item) =>
          typeof item === "string" || typeof item === "number" || typeof item === "boolean"
        )
      ) throw new SyntaxError("Invalid resume task descriptor.");
      return value as ResumeTaskDescriptor;
    });
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
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

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "请求体必须是 JSON 对象。");
  }
  return value as Record<string, unknown>;
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

function html(response: ServerResponse, value: string): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'none'; img-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(value);
}

function streamMatches<T>(
  request: IncomingMessage,
  response: ServerResponse,
  subscribe: (subscriber: (value: T) => void) => () => void,
): void {
  const unsubscribe = subscribe((value) => {
    if (!response.destroyed) response.write(`event: match\ndata: ${JSON.stringify(value)}\n\n`);
  });
  let heartbeat: NodeJS.Timeout | undefined;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    if (!response.destroyed && response.headersSent) response.end();
  };
  request.once("aborted", close);
  response.once("close", close);
  try {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    response.write(": connected\n\n");
  } catch (error) {
    close();
    throw error;
  }
  if (closed) return;
  heartbeat = setInterval(() => {
    if (!response.destroyed) response.write(": keep-alive\n\n");
  }, 15_000);
  heartbeat.unref();
}

async function withRequestAbortSignal<T>(
  request: IncomingMessage,
  response: ServerResponse,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.once("aborted", abort);
  response.once("close", abort);
  try {
    return await operation(controller.signal);
  } finally {
    request.off("aborted", abort);
    response.off("close", abort);
  }
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
  const governor = new RequestGovernor({ requestBudget: 4, minDelayMs: 800, jitterMs: 200, maxRetries: 1, forbiddenCooldownMs: 900_000 });
  // Public profile lookup does not need the operator's cookie. Keeping it out
  // prevents an expired login session from breaking a public UID switch.
  const profile = await governor.execute("user_detail", () => client.getUserProfile(uid));
  const inspect = async (source: "record" | "likes"): Promise<SourceProbe> => {
    try {
      const songs = source === "record"
        ? await governor.execute("user_record", () => client.getUserRecord(uid, "all", cookie))
        : await (async () => {
          const target = await governor.execute("target_likes_playlist", () => client.getTargetLikedPlaylist!(uid, cookie));
          return governor.execute("target_likes_tracks", () => client.getTargetLikedPlaylistSongs!(uid, target, cookie));
        })();
      return { status: "available", songs: songs.length };
    } catch (error) { return { status: error instanceof CooldownRequired ? "cooldown" : "restricted", error: message(error) }; }
  };
  const record = await inspect("record");
  const likes = record.status === "cooldown" ? { status: "cooldown" as const, error: "record probe entered cooldown" } : await inspect("likes");
  return {
    profile,
    record,
    likes,
    sessionPresent: Boolean(cookie),
    elapsedMs: Date.now() - started,
    route: proxy ? "explicit-proxy" : "direct",
    routeAttempts: 1,
  };
}

async function searchNcmSongs(
  query: string,
  limit: number,
  proxy: string | undefined,
): Promise<SongSearchResult[]> {
  return new EnhancedNcmClient({ proxy }).searchSongs(query, limit);
}

async function lookupNcmSong(songId: string, proxy: string | undefined): Promise<SongInfo> {
  return new EnhancedNcmClient({ proxy }).getSongInfo(songId);
}

function isNcmLookupLaneFailure(error: unknown, visited = new Set<object>()): boolean {
  if (!error || typeof error !== "object" || visited.has(error)) return false;
  visited.add(error);
  const status = errorStatus(error);
  if (status === 403 || status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }
  if (error instanceof TypeError) return true;
  const candidate = error as Record<string, unknown>;
  if (typeof candidate.code === "string" && /^(?:EAI_AGAIN|ECONN|EHOST|ENET|ETIMEDOUT)/.test(candidate.code)) return true;
  return isNcmLookupLaneFailure(candidate.cause, visited);
}

function ncmLookupHttpError(
  error: unknown,
  attempts: number,
  usedPool: boolean,
  explicitProxy: boolean,
  label: string,
): HttpError {
  if (errorStatus(error) === 429 || error instanceof CooldownRequired) {
    return new HttpError(429, usedPool
      ? `${label}已轮换 ${attempts} 个代理出口，但都被网易云暂时限流；不会回退到本机直连，请稍后再试。`
      : explicitProxy
      ? `${label}使用手动代理时被网易云暂时限流，请检查代理或稍后再试。`
      : `${label}被网易云暂时限流；请稍后再试，或先开启代理池。`
    );
  }
  return new HttpError(502, usedPool
    ? `${label}已自动轮换 ${attempts} 个代理出口，仍未收到有效响应；不会回退到本机直连。`
    : explicitProxy
    ? `${label}未从手动代理收到有效上游响应，请检查代理设置。`
    : `${label}未收到有效上游响应；当前未运行代理池，因此本次使用本机直连。`
  );
}

function userProbeHttpError(error: unknown, attempts: number, usedPool: boolean): HttpError {
  if (errorStatus(error) === 404) {
    return new HttpError(404, "没有找到这个 UID 对应的用户资料；请确认输入的是用户主页中的纯数字 UID，且该账号资料仍可访问。");
  }
  if (error instanceof CooldownRequired) {
    return new HttpError(429, usedPool
      ? `用户资料查询已轮换 ${attempts} 个代理出口，但都被网易云暂时拒绝或限流；请稍后再试。`
      : "用户资料查询被网易云暂时拒绝或限流；请稍后再试，或先开启代理池。"
    );
  }
  return new HttpError(502, usedPool
    ? `用户资料查询已自动轮换 ${attempts} 个代理出口，仍未收到有效响应；请检查节点状态或稍后再试。`
    : "用户资料查询未收到有效上游响应；请先开启代理池后重试，避免连续 UID 查询始终使用同一本机出口。"
  );
}

async function readJsonl(path: string | undefined, max: number): Promise<FoundComment[]> {
  if (!path) return [];
  return readJsonlTail<FoundComment>(path, max);
}

async function readResultReportSnapshot(path: string | undefined): Promise<JsonlSnapshot<FoundComment>> {
  try {
    return await readJsonlSnapshotDetails<FoundComment>(path, {
      maxBytes: MAX_RESULT_REPORT_BYTES,
      maxRecords: MAX_RESULT_REPORT_RECORDS,
    });
  } catch (error) {
    if (error instanceof JsonlSnapshotLimitError) throw new HttpError(413, error.message);
    throw error;
  }
}

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function requestStartedAt(value: string | undefined): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}
function emptySnapshot(): JobSnapshot { return { status: "idle", songs: 0, songsProcessed: 0, catalogSongs: 0, reusedSongs: 0, historicalCompletedSongs: 0, newPendingSongs: 0, commentOffset: 0, activeSongs: [], matches: 0, requestsTotal: 0, pagesProcessed: 0, commentsInspected: 0, commentsPerSecond: 0, elapsedMs: 0, lanes: 0, workers: 0, coverageComplete: false, sourceErrors: [], proxyEnabled: false, pageRequestSamples: 0, pageRequestAttempts: 0, successfulPageRequests: 0, failedPageRequests: 0 }; }
function emptyParallelSnapshot(): ParallelJobSnapshot { return { status: "idle", activeSongs: [], lanes: 0, workers: 0, shards: 0, shardsComplete: 0, coveragePercent: 0, pagesProcessed: 0, commentsInspected: 0, matches: 0, requestsTotal: 0, commentsPerSecond: 0, elapsedMs: 0, pageRequestSamples: 0, pageRequestAttempts: 0, successfulPageRequests: 0, failedPageRequests: 0 }; }
function busyTaskMessage(coordinator: TaskCoordinator): string {
  if (coordinator.activeMode() === "pool") return "代理池正在构建或验证，请稍后再启动检索。";
  return coordinator.activeMode() === "parallel"
    ? "已有单曲并行任务正在运行，请先停止该任务。"
    : coordinator.activeMode() === "qq"
    ? "已有 QQ 音乐任务正在运行，请先停止该任务。"
    : "已有用户来源任务正在运行，请先停止该任务。";
}
function numericId(value: unknown, name: string): string { const id = String(value ?? "").trim(); if (!/^\d+$/.test(id)) throw new HttpError(400, `${name} 应为纯数字。`); return id; }
function searchQuery(value: unknown): string { const query = String(value ?? "").trim(); if (query.length < 2 || query.length > 80) throw new HttpError(400, "q 长度应为 2 到 80 个字符。"); return query; }
function reportJobId(value: unknown): string { const id = String(value ?? "").trim(); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new HttpError(400, "任务 ID 格式错误。"); return id; }
function reportTarget(value: unknown): string { const target = String(value ?? "").trim(); if (!target || target.length > 512) throw new HttpError(400, "报告目标格式错误。"); return target; }
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address === "127.0.0.1" || address.startsWith("127.")
    || address === "::ffff:127.0.0.1" || address.startsWith("::ffff:127.");
}
function selection<const T extends readonly string[]>(value: unknown, choices: T, name: string): T[number] { if (typeof value === "string" && choices.includes(value)) return value as T[number]; throw new HttpError(400, `${name} 参数错误。`); }
function integer(value: unknown, name: string, minimum: number, maximum: number): number { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new HttpError(400, `${name} 应为 ${minimum} 到 ${maximum} 之间的整数。`); return parsed; }
function optionalNumber(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, `${name} 应为 ${minimum} 到 ${maximum} 之间的数字。`);
  }
  return parsed;
}
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
export function validateClashConfigSelection(
  value: unknown,
  discovery: ReturnType<typeof discoverClashVerge>,
): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.length > 32) throw new HttpError(400, "请选择 1 至 32 套 Clash Verge 代理配置。");
  const paths = values.map((item) => optionalPath(item));
  if (paths.some((path) => !path)) throw new HttpError(400, "路径格式错误。");
  const allowed = new Set([
    ...discovery.configCandidates,
    ...discovery.profiles.map((profile) => profile.path),
  ].map((candidate) => resolve(candidate)));
  const selected = [...new Set(paths as string[])];
  if (selected.some((path) => !allowed.has(path))) {
    throw new HttpError(400, "请选择 Clash Verge 已发现的代理配置。");
  }
  return selected;
}

export function sourceTaskPaths(
  dataRoot: string,
  uid: string,
  source: SourceSelection,
): { statePath: string; outputPath: string; coveragePath: string } {
  const suffix = `target-v${SOURCE_CATALOG_VERSION}`;
  return {
    statePath: join(dataRoot, `web-state-${uid}-${source}-${suffix}.json`),
    outputPath: join(dataRoot, `web-comments-${uid}-${suffix}.jsonl`),
    coveragePath: join(dataRoot, `web-song-coverage-${uid}-${suffix}.json`),
  };
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
