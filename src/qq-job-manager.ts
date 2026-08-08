import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeAtomicJson } from "./atomic-file";
import { CommentRateTracker } from "./comment-rate";
import { CooldownRequired, RunCancelled } from "./errors";
import { RequestGovernor } from "./governor";
import { JsonlSnapshotLimitError, readJsonlSnapshot } from "./jsonl-snapshot";
import { readJsonlTail } from "./jsonl-tail";
import {
  proxyPoolStatusRunning,
  recentlyVerifiedProxyPoolEntries,
  readProxyPool,
  verifyProxyPool,
  type ProxyPoolEntry,
  type ProxyPoolFile,
} from "./mihomo-pool";
import { PagePerformanceTracker, type PagePerformanceSnapshot } from "./page-performance";
import { selectProxyLanes, type ProxyLaneSelection } from "./proxy-lane-selection";
import {
  QQMusicClient,
  QQMusicApiError,
  QQMusicProxyError,
  createQQMusicProxyFetch,
  runQQMusicScan,
  cancelQQMusicLanes,
  QQMusicTransportGate,
  ClassicEncryptUinError,
  decodeClassicEncryptUin,
  normalizeUserInput,
  parseClassicEncryptUinExperimentInput,
  type ClassicEncryptUinFormat,
  type ClassicEncryptUinIdentityKind,
  type ClassicEncryptUinInputKind,
  type ClassicEncryptUinResolution,
} from "./qq-music";
import {
  DEFAULT_QQ_TRANSPORT_MAX_CONCURRENT,
  DEFAULT_QQ_TRANSPORT_START_DELAY_MS,
  qqMusicTransportProfile,
} from "./qq-music/transport-gate";
import { stableQQMusicTaskKey } from "./qq-music/state";
import type {
  QQCommentLane,
  QQMusicFoundComment,
  QQMusicPlatformClient,
  QQMusicRequestActivity,
  QQMusicScanOptions,
  QQMusicScanReport,
  QQMusicSongActivity,
} from "./qq-music/types";
import type { SongSearchResult } from "./types";
import { taskElapsedMs, type TaskCoordinator, type TaskLease } from "./task-coordinator";
import { readTaskLog, TaskLogger, type TaskLogEntry } from "./task-log";

const ACTIVE_SONG_LIMIT = 64;
const MAX_RESULT_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_RESULT_REPORT_RECORDS = 20_000;

export interface QQJobManagerPaths {
  data: string;
  pool: string;
  resumeTask: string;
}

export interface QQStartRequest {
  mode?: unknown;
  target?: unknown;
  songId?: unknown;
  pageSize?: unknown;
  likedPageSize?: unknown;
  requestBudget?: unknown;
  minDelayMs?: unknown;
  jitterMs?: unknown;
  forbiddenCooldownMs?: unknown;
  maxCommentPagesPerSong?: unknown;
  maxSongs?: unknown;
  stopAfterFirst?: unknown;
  fresh?: unknown;
  proxy?: unknown;
  allowDirect?: unknown;
  workersPerProxy?: unknown;
  maxProxyLanes?: unknown;
  hostConcurrency?: unknown;
}

export interface QQJobGeneration {
  platform: "qq";
  mode: "song" | "likes";
  jobId: string;
  target: { kind: "encryptUin"; value: string };
}

interface InternalGeneration extends QQJobGeneration {
  outputPath: string;
  statePath: string;
}

export interface QQActiveSongSnapshot {
  id: string;
  name?: string;
  workers: number;
  pageSize?: number;
  pagesProcessed?: number;
  requestingPage?: number;
  requestStartedAt?: number;
  commentsProcessed?: number;
  totalComments?: number;
  progressPercent?: number;
  truncated?: boolean;
}

export interface QQJobSnapshot extends PagePerformanceSnapshot {
  id?: string;
  platform: "qq";
  status: "idle" | "running" | "stopping" | QQMusicScanReport["status"] | "error";
  mode?: "song" | "likes";
  generation?: QQJobGeneration;
  targetLabel?: string;
  songId?: string;
  songName?: string;
  startedAt?: string;
  finishedAt?: string;
  songs: number;
  songsProcessed: number;
  activeSongs: QQActiveSongSnapshot[];
  pagesProcessed: number;
  commentsInspected: number;
  matches: number;
  requestsTotal: number;
  commentsPerSecond: number;
  elapsedMs: number;
  configuredLanes: number;
  configuredWorkers: number;
  participatedLanes: number;
  participatedWorkers: number;
  peakInFlight: number;
  laneSelection?: ProxyLaneSelection;
  workersPerLane?: number;
  hostConcurrency?: number;
  pageSize?: number;
  likedPageSize?: number;
  minDelayMs?: number;
  jitterMs?: number;
  proxyTransportMaxConcurrent?: number;
  proxyTransportStartDelayMs?: number;
  proxyEnabled: boolean;
  coverageComplete: boolean;
  logPath?: string;
  error?: string;
  note?: string;
}

export interface QQResultSnapshot {
  generation: QQJobGeneration;
  results: QQMusicFoundComment[];
}

export interface QQMatchEvent {
  generation: QQJobGeneration;
  comment: QQMusicFoundComment;
}

export interface QQReportDescriptor {
  platform: "qq";
  mode: "song" | "likes";
  jobId: string;
  target: { kind: "encryptUin"; value: string };
  targetLabel: string;
  status: string;
  songId?: string;
  songName?: string;
  startedAt?: string;
  finishedAt?: string;
  elapsedMs: number;
  matches: number;
  requestsTotal: number;
  pagesProcessed: number;
  commentsInspected: number;
  coverageLabel: string;
  exportedAt: string;
  comments: QQMusicFoundComment[];
}

export interface QQJobManagerOptions {
  paths: QQJobManagerPaths;
  coordinator: TaskCoordinator;
  clientFactory?: (proxy?: string) => QQMusicPlatformClient;
  runner?: (lanes: QQCommentLane[], options: QQMusicScanOptions) => Promise<QQMusicScanReport>;
  idFactory?: () => string;
  now?: () => Date;
  poolReader?: typeof readProxyPool;
  poolVerifier?: (pool: ProxyPoolFile, signal: AbortSignal) => Promise<ProxyPoolEntry[]>;
  reportSnapshotReader?: (path: string | undefined) => Promise<QQMusicFoundComment[]>;
  resumeWriter?: (path: string, descriptor: Record<string, unknown>) => Promise<void>;
}

export class QQJobManagerError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "QQJobManagerError";
  }
}

export interface QQClassicEncryptUinVerification {
  format: ClassicEncryptUinFormat;
  identityKind: ClassicEncryptUinIdentityKind;
  status: "match" | "mismatch";
  maskedIdentifier: string;
  checks: {
    encryptUin: boolean;
    nickname: boolean;
    avatar: boolean;
  };
}

export interface QQClassicEncryptUinResolution {
  inputKind: ClassicEncryptUinInputKind;
  resolution: ClassicEncryptUinResolution;
  format: ClassicEncryptUinFormat;
  identityKind: ClassicEncryptUinIdentityKind;
  encryptUin: string;
  identifier: string;
  maskedIdentifier: string;
}

type MatchSubscriber = (event: QQMatchEvent) => void;

export class QQJobManager {
  private readonly paths: QQJobManagerPaths;
  private readonly coordinator: TaskCoordinator;
  private readonly clientFactory: (proxy?: string) => QQMusicPlatformClient;
  private readonly runner: (lanes: QQCommentLane[], options: QQMusicScanOptions) => Promise<QQMusicScanReport>;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly poolReader: typeof readProxyPool;
  private readonly poolVerifier: (pool: ProxyPoolFile, signal: AbortSignal) => Promise<ProxyPoolEntry[]>;
  private readonly reportSnapshotReader: (path: string | undefined) => Promise<QQMusicFoundComment[]>;
  private readonly resumeWriter: (path: string, descriptor: Record<string, unknown>) => Promise<void>;
  private snapshotValue = emptySnapshot();
  private generation?: InternalGeneration;
  private lease?: TaskLease;
  private abortController?: AbortController;
  private transportGate?: QQMusicTransportGate;
  private lanes: QQCommentLane[] = [];
  private lookupAbortController?: AbortController;
  private lookupLanes: QQCommentLane[] = [];
  private lookupVersion = 0;
  private lookupCompletion: Promise<void> = Promise.resolve();
  private readonly subscribers = new Map<MatchSubscriber, string>();
  private readonly activeByWorker = new Map<string, { id: string; name?: string; page: number; startedAt?: string }>();
  private readonly progressBySong = new Map<string, QQMusicSongActivity>();
  private readonly seenWorkers = new Set<string>();
  private readonly seenLanes = new Set<string>();
  private readonly commentRate = new CommentRateTracker();
  private readonly pagePerformance = new PagePerformanceTracker();
  private inFlight = 0;

  constructor(options: QQJobManagerOptions) {
    this.paths = options.paths;
    this.coordinator = options.coordinator;
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
    this.runner = options.runner ?? runQQMusicScan;
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.poolReader = options.poolReader ?? readProxyPool;
    this.poolVerifier = options.poolVerifier ?? ((pool, signal) => verifyProxyPool(pool, undefined, signal));
    this.reportSnapshotReader = options.reportSnapshotReader ?? ((path) => readJsonlSnapshot<QQMusicFoundComment>(path, {
      maxBytes: MAX_RESULT_REPORT_BYTES,
      maxRecords: MAX_RESULT_REPORT_RECORDS,
    }));
    this.resumeWriter = options.resumeWriter ?? writeAtomicJson;
  }

  async start(input: QQStartRequest): Promise<QQJobSnapshot> {
    const config = parseStartRequest(input);
    const lease = this.coordinator.acquire("qq");
    if (!lease) throw new QQJobManagerError(409, "已有其他任务运行，请先停止当前任务。");
    const previousSnapshot = cloneSnapshot(this.snapshotValue);
    const previousGeneration = this.generation ? cloneInternalGeneration(this.generation) : undefined;
    let generationCommitted = false;
    this.lease = lease;
    const activeId = this.idFactory();
    const startedAt = this.now().toISOString();
    this.abortController = new AbortController();
    this.resetActivity();
    const logger = new TaskLogger(join(this.paths.data, "logs", `qq-${activeId}.jsonl`), "qq", activeId);
    this.snapshotValue = {
      ...emptySnapshot(),
      id: activeId,
      status: "running",
      mode: config.mode,
      targetLabel: maskTarget(config.target),
      songId: config.songId,
      startedAt,
      hostConcurrency: config.hostConcurrency,
      pageSize: config.pageSize,
      likedPageSize: config.likedPageSize,
      minDelayMs: config.minDelayMs,
      jitterMs: config.jitterMs,
      logPath: logger.path,
      proxyTransportMaxConcurrent: DEFAULT_QQ_TRANSPORT_MAX_CONCURRENT,
      proxyTransportStartDelayMs: DEFAULT_QQ_TRANSPORT_START_DELAY_MS,
    };

    try {
      const prepared = await this.prepareLanes(config, this.abortController.signal);
      this.throwIfStopped();
      this.lanes = prepared.lanes;
      this.transportGate = prepared.gate;
      this.snapshotValue = {
        ...this.snapshotValue,
        configuredLanes: this.lanes.length,
        configuredWorkers: prepared.configuredWorkers,
        workersPerLane: prepared.workersPerLane,
        laneSelection: prepared.laneSelection,
        proxyEnabled: prepared.proxyEnabled,
        proxyTransportMaxConcurrent: prepared.profile.maxConcurrent,
        proxyTransportStartDelayMs: prepared.profile.minStartDelayMs,
      };
      const target = await this.resolveCanonicalTarget(config.target);
      this.throwIfStopped();
      const taskPaths = qqTaskPaths(this.paths.data, config.mode, target.encryptUin, config.songId);
      const generation: InternalGeneration = {
        platform: "qq",
        mode: config.mode,
        jobId: activeId,
        target: { kind: "encryptUin", value: target.encryptUin },
        ...taskPaths,
      };
      this.generation = generation;
      this.snapshotValue = {
        ...this.snapshotValue,
        generation: publicGeneration(generation),
        targetLabel: maskTarget(target.encryptUin),
      };
      generationCommitted = true;
      await logger.write("info", "task_started", "QQ 音乐评论扫描已启动。", {
        mode: config.mode,
        songId: config.songId,
        pageSize: config.pageSize,
        likedPageSize: config.likedPageSize,
        configuredLanes: this.snapshotValue.configuredLanes,
        configuredWorkers: this.snapshotValue.configuredWorkers,
        hostConcurrency: config.hostConcurrency,
        requestBudget: config.requestBudget,
      });
      try {
        await this.resumeWriter(this.paths.resumeTask, {
          version: 2,
          platform: "qq",
          mode: config.mode,
          updatedAt: this.now().toISOString(),
          input: {
            target: target.encryptUin,
            ...(config.songId ? { songId: config.songId } : {}),
            pageSize: config.pageSize,
            likedPageSize: config.likedPageSize,
            requestBudget: config.requestBudget,
            minDelayMs: config.minDelayMs,
            jitterMs: config.jitterMs,
            forbiddenCooldownMs: config.forbiddenCooldownMs,
            maxCommentPagesPerSong: config.maxCommentPagesPerSong,
            maxSongs: config.maxSongs,
            maxProxyLanes: config.maxProxyLanes,
            hostConcurrency: config.hostConcurrency,
            allowDirect: config.allowDirect,
          },
        });
      } catch (error) {
        await logger.write("warn", "resume_descriptor_failure", "未能保存 QQ 音乐任务参数；扫描检查点仍会正常写入。", {
          error: message(error),
        });
      }
      this.throwIfStopped();
      const scanOptions: QQMusicScanOptions = {
        mode: config.mode,
        target: target.encryptUin,
        songId: config.songId,
        pageSize: config.pageSize,
        likedPageSize: config.likedPageSize,
        maxSongs: config.maxSongs,
        maxCommentPagesPerSong: config.maxCommentPagesPerSong,
        workersPerLane: prepared.workersPerLane,
        maxWorkers: config.hostConcurrency,
        requestBudget: config.requestBudget,
        stopAfterFirst: config.stopAfterFirst,
        fresh: config.fresh,
        statePath: generation.statePath,
        outputPath: generation.outputPath,
        signal: this.abortController?.signal,
        onMatch: (comment) => this.publishMatch(activeId, comment),
        onCheckpoint: (activity) => {
          if (!this.isCurrent(activeId)) return;
          this.snapshotValue = {
            ...this.snapshotValue,
            songs: activity.songs,
            songsProcessed: activity.songsComplete,
            pagesProcessed: activity.pagesProcessed,
            commentsInspected: activity.commentsInspected,
            matches: activity.matches,
            requestsTotal: activity.requestsTotal,
            coverageComplete: activity.coverageComplete,
          };
        },
        onRequestActivity: (activity) => {
          if (!this.isCurrent(activeId)) return;
          logger.request(activity);
          this.trackRequest(activeId, activity);
        },
        onSongProgress: (activity) => this.trackSong(activeId, activity),
      };
      const running = this.runner(this.lanes, scanOptions);
      void running.then(async (report) => {
        if (!this.isCurrent(activeId)) return;
        this.snapshotValue = {
          ...this.snapshotValue,
          status: report.status,
          finishedAt: this.now().toISOString(),
          songs: report.songs,
          songsProcessed: report.songsComplete,
          pagesProcessed: report.pagesProcessed,
          commentsInspected: report.commentsInspected,
          matches: report.matches,
          requestsTotal: report.requestsTotal,
          coverageComplete: report.coverageComplete,
          activeSongs: [],
          commentsPerSecond: 0,
          note: report.note,
        };
        await logger.write("info", "task_finished", `QQ 音乐扫描结束：${report.status}。`, {
          status: report.status,
          matches: report.matches,
          requestsTotal: report.requestsTotal,
          pagesProcessed: report.pagesProcessed,
          coverageComplete: report.coverageComplete,
        });
      }).catch(async (error) => {
        if (!this.isCurrent(activeId)) return;
        if (error instanceof RunCancelled || error instanceof CooldownRequired) {
          const status = error instanceof RunCancelled ? "stopped" : "cooldown";
          this.snapshotValue = {
            ...this.snapshotValue,
            status,
            finishedAt: this.now().toISOString(),
            activeSongs: [],
            commentsPerSecond: 0,
            note: error instanceof RunCancelled ? "任务已停止。" : message(error),
            error: undefined,
          };
          await logger.write(status === "stopped" ? "info" : "warn", "task_finished", `QQ 音乐扫描结束：${status}。`);
          return;
        }
        this.fail(activeId, error);
        await logger.write("error", "task_error", `QQ 音乐扫描异常结束：${message(error)}`, { error: message(error) });
      }).finally(() => this.releaseRun(activeId));
      return this.status();
    } catch (error) {
      if (error instanceof RunCancelled || this.abortController?.signal.aborted) {
        this.snapshotValue = {
          ...this.snapshotValue,
          status: "stopped",
          finishedAt: this.now().toISOString(),
          activeSongs: [],
          note: "任务已停止。",
        };
        const stopped = await this.status();
        this.releaseRun(activeId);
        if (!generationCommitted) this.generation = undefined;
        return stopped;
      }
      if (error instanceof CooldownRequired) {
        this.snapshotValue = {
          ...this.snapshotValue,
          status: "cooldown",
          finishedAt: this.now().toISOString(),
          activeSongs: [],
          note: message(error),
        };
        const cooldown = await this.status();
        this.releaseRun(activeId);
        if (!generationCommitted) this.generation = undefined;
        return cooldown;
      }
      this.fail(activeId, error);
      this.releaseRun(activeId);
      if (!generationCommitted && previousGeneration) {
        this.snapshotValue = previousSnapshot;
        this.generation = previousGeneration;
      }
      throw error;
    }
  }

  async stop(): Promise<QQJobSnapshot> {
    this.lookupVersion += 1;
    this.lookupAbortController?.abort();
    cancelQQMusicLanes(this.lookupLanes);
    if (this.snapshotValue.status !== "running" && this.snapshotValue.status !== "stopping") return this.status();
    this.snapshotValue = { ...this.snapshotValue, status: "stopping" };
    this.abortController?.abort();
    this.transportGate?.cancel();
    cancelQQMusicLanes(this.lanes);
    return this.status();
  }

  async status(): Promise<QQJobSnapshot> {
    const active = this.snapshotValue.status === "running" || this.snapshotValue.status === "stopping";
    const snapshot = {
      ...this.snapshotValue,
      elapsedMs: taskElapsedMs(this.snapshotValue.startedAt, this.snapshotValue.finishedAt),
      commentsPerSecond: active ? this.commentRate.rate() : 0,
      ...this.pagePerformance.snapshot(),
      activeSongs: this.snapshotValue.activeSongs.map((song) => ({ ...song })),
    };
    this.snapshotValue = cloneSnapshot(snapshot);
    return cloneSnapshot(snapshot);
  }

  async results(expectedJobId: string, limit: number): Promise<QQResultSnapshot> {
    const generation = this.requireGeneration(expectedJobId);
    const results = await readJsonlTail<QQMusicFoundComment>(generation.outputPath, limit);
    this.assertGeneration(generation);
    return { generation: publicGeneration(generation), results };
  }

  async logs(expectedJobId: string, limit: number): Promise<{ generation: QQJobGeneration; path?: string; entries: TaskLogEntry[] }> {
    const generation = this.requireGeneration(expectedJobId);
    const path = this.snapshotValue.logPath;
    const entries = await readTaskLog(path, limit);
    this.assertGeneration(generation);
    return { generation: publicGeneration(generation), path, entries };
  }

  subscribeMatches(expectedJobId: string, subscriber: MatchSubscriber): () => void {
    this.requireGeneration(expectedJobId);
    this.subscribers.set(subscriber, expectedJobId);
    return () => this.subscribers.delete(subscriber);
  }

  async report(expected: QQJobGeneration): Promise<QQReportDescriptor> {
    const generation = this.requireExactGeneration(expected);
    const snapshotBefore = await this.status();
    let comments: QQMusicFoundComment[];
    try {
      comments = await this.reportSnapshotReader(generation.outputPath);
    } catch (error) {
      if (error instanceof JsonlSnapshotLimitError) {
        throw new QQJobManagerError(413, error.message);
      }
      throw error;
    }
    this.assertGeneration(generation);
    const snapshotAfter = await this.status();
    this.assertGeneration(generation);
    if (snapshotBefore.id !== generation.jobId || snapshotAfter.id !== generation.jobId) {
      throw staleGenerationError();
    }
    return {
      platform: "qq",
      mode: generation.mode,
      jobId: generation.jobId,
      target: { ...generation.target },
      targetLabel: snapshotAfter.targetLabel ?? maskTarget(generation.target.value),
      status: snapshotAfter.status,
      songId: snapshotAfter.songId,
      songName: snapshotAfter.songName,
      startedAt: snapshotAfter.startedAt,
      finishedAt: snapshotAfter.finishedAt,
      elapsedMs: snapshotAfter.elapsedMs,
      matches: snapshotAfter.matches,
      requestsTotal: snapshotAfter.requestsTotal,
      pagesProcessed: snapshotAfter.pagesProcessed,
      commentsInspected: snapshotAfter.commentsInspected,
      coverageLabel: snapshotAfter.songs > 0
        ? `${snapshotAfter.songsProcessed.toLocaleString("zh-CN")} / ${snapshotAfter.songs.toLocaleString("zh-CN")} 首歌曲`
        : "等待歌曲来源",
      exportedAt: this.now().toISOString(),
      comments: comments.reverse(),
    };
  }

  async lookupSong(
    songIdInput: unknown,
    proxyInput?: unknown,
    allowDirectInput?: unknown,
    signal?: AbortSignal,
  ) {
    const songId = decimalId(songIdInput, "QQ 音乐歌曲 ID");
    return this.withLookupLanes(
      proxyInput,
      allowDirectInput,
      (lanes) => executeControlAcrossLanes(lanes, "qq_song_lookup", (lane) =>
        lane.client.getSongInfo(songId, lane.transportGate.signal)
      ),
      signal,
    );
  }

  async searchSongs(
    queryInput: unknown,
    limitInput: unknown,
    proxyInput?: unknown,
    allowDirectInput?: unknown,
    signal?: AbortSignal,
  ): Promise<SongSearchResult[]> {
    const query = text(queryInput, "q", 2, 80);
    const limit = integer(limitInput ?? 10, "limit", 1, 10);
    return this.withLookupLanes(
      proxyInput,
      allowDirectInput,
      (lanes) => executeControlAcrossLanes(lanes, "qq_song_search", (lane) => {
        if (!lane.client.searchSongs) {
          throw new QQJobManagerError(501, "当前 QQ 音乐客户端不支持歌曲搜索。");
        }
        return lane.client.searchSongs(query, limit, lane.transportGate.signal);
      }),
      signal,
    );
  }

  async verifyClassicEncryptUin(
    encryptUinInput: unknown,
    proxyInput?: unknown,
    allowDirectInput?: unknown,
    signal?: AbortSignal,
  ): Promise<QQClassicEncryptUinVerification> {
    const decoded = decodeClassicEncryptUin(String(encryptUinInput ?? ""));
    try {
      const profiles = await this.withLookupLanes(
        proxyInput,
        allowDirectInput,
        async (lanes) => {
          const readProfile = (input: string, label: string) => executeControlAcrossLanes(
            lanes,
            label,
            (lane) => {
              if (!lane.client.getPublicUserProfile) {
                throw new QQJobManagerError(501, "当前 QQ 音乐客户端不支持公开身份验证实验。");
              }
              return lane.client.getPublicUserProfile(input, lane.transportGate.signal);
            },
          );
          const original = await readProfile(decoded.encryptUin, "qq_encrypt_uin_verify_original");
          const decodedIdentifier = await readProfile(decoded.identifier, "qq_encrypt_uin_verify_decoded");
          return { original, decodedIdentifier };
        },
        signal,
      );
      const originalEncryptUin = canonicalEncryptUin(profiles.original.encryptUin);
      const decodedEncryptUin = canonicalEncryptUin(profiles.decodedIdentifier.encryptUin);
      const originalNickname = verificationProfileField(profiles.original.nickname, "昵称");
      const decodedNickname = verificationProfileField(profiles.decodedIdentifier.nickname, "昵称");
      const originalAvatar = verificationProfileField(profiles.original.avatarUrl, "头像");
      const decodedAvatar = verificationProfileField(profiles.decodedIdentifier.avatarUrl, "头像");
      const checks = {
        encryptUin: originalEncryptUin === decoded.encryptUin && decodedEncryptUin === decoded.encryptUin,
        nickname: originalNickname === decodedNickname,
        avatar: originalAvatar === decodedAvatar,
      };
      return {
        format: decoded.format,
        identityKind: decoded.identityKind,
        status: Object.values(checks).every(Boolean) ? "match" : "mismatch",
        maskedIdentifier: decoded.maskedIdentifier,
        checks,
      };
    } catch (error) {
      if (error instanceof ClassicEncryptUinError
        || error instanceof QQJobManagerError
        || error instanceof RunCancelled) throw error;
      if (error instanceof CooldownRequired) {
        throw new QQJobManagerError(429, "在线验证被 QQ 音乐暂时限流；请稍后重试。");
      }
      throw new QQJobManagerError(502, "在线验证请求失败；未从 QQ 音乐收到可比较的官方身份响应。");
    }
  }

  async resolveClassicEncryptUinInput(
    input: unknown,
    proxyInput?: unknown,
    allowDirectInput?: unknown,
    signal?: AbortSignal,
  ): Promise<QQClassicEncryptUinResolution> {
    const parsed = parseClassicEncryptUinExperimentInput(String(input ?? ""));
    if (parsed.resolution === "local") {
      return {
        inputKind: parsed.inputKind,
        resolution: parsed.resolution,
        ...decodeClassicEncryptUin(parsed.encryptUin),
      };
    }

    let profile;
    try {
      profile = await this.withLookupLanes(
        proxyInput,
        allowDirectInput,
        (lanes) => executeControlAcrossLanes(
          lanes,
          "qq_encrypt_uin_resolve_numeric",
          (lane) => {
            if (!lane.client.getPublicUserProfile) {
              throw new QQJobManagerError(501, "当前 QQ 音乐客户端不支持公开身份解析实验。");
            }
            return lane.client.getPublicUserProfile(parsed.identifier, lane.transportGate.signal);
          },
        ),
        signal,
      );
    } catch (error) {
      if (error instanceof QQJobManagerError || error instanceof RunCancelled) throw error;
      if (error instanceof CooldownRequired) {
        throw new QQJobManagerError(429, "联网解析被 QQ 音乐暂时限流；请稍后重试。");
      }
      throw new QQJobManagerError(502, "联网解析失败；未从 QQ 音乐收到可用的官方公开身份响应。");
    }

    let decoded;
    try {
      decoded = decodeClassicEncryptUin(canonicalEncryptUin(profile.encryptUin));
    } catch {
      throw new QQJobManagerError(502, "QQ 音乐返回的 canonical EncryptUin 不属于当前实验支持的格式。");
    }
    if (decoded.identifier !== parsed.identifier || decoded.identityKind !== parsed.identityKind) {
      throw new QQJobManagerError(502, "QQ 音乐公开身份响应与输入候选标识不一致。");
    }
    return {
      inputKind: parsed.inputKind,
      resolution: parsed.resolution,
      ...decoded,
    };
  }

  private async withLookupLanes<T>(
    proxyInput: unknown,
    allowDirectInput: unknown,
    operation: (lanes: QQCommentLane[]) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const lookupVersion = ++this.lookupVersion;
    const previousLookup = this.lookupCompletion;
    this.lookupAbortController?.abort();
    cancelQQMusicLanes(this.lookupLanes);
    if (externalSignal) await abortRace(previousLookup, externalSignal);
    else await previousLookup;
    if (lookupVersion !== this.lookupVersion || externalSignal?.aborted) throw new RunCancelled();

    const lease = this.coordinator.acquire("qq");
    if (!lease) throw new QQJobManagerError(409, "已有其他任务运行，请先停止当前任务。");
    const controller = new AbortController();
    let settleLookup = (): void => {};
    const lookupCompletion = new Promise<void>((resolve) => { settleLookup = resolve; });
    this.lookupCompletion = lookupCompletion;
    this.lookupAbortController = controller;
    const abortFromCaller = (): void => {
      controller.abort();
      cancelQQMusicLanes(this.lookupLanes);
    };
    externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
    try {
      const config: LanePreparationConfig = {
        mode: "song",
        proxy: proxyUrl(proxyInput),
        allowDirect: boolean(allowDirectInput),
        maxProxyLanes: 0,
        hostConcurrency: 1,
        minDelayMs: 3_000,
        jitterMs: 1_000,
        forbiddenCooldownMs: 900_000,
      };
      const prepared = await this.prepareLanes(config, controller.signal);
      this.lookupLanes = prepared.lanes;
      throwIfAborted(controller.signal);
      return await operation(prepared.lanes);
    } finally {
      controller.abort();
      cancelQQMusicLanes(this.lookupLanes);
      this.lookupLanes = [];
      if (this.lookupAbortController === controller) this.lookupAbortController = undefined;
      externalSignal?.removeEventListener("abort", abortFromCaller);
      lease.release();
      settleLookup();
    }
  }

  private async prepareLanes(config: LanePreparationConfig, signal: AbortSignal): Promise<{
    lanes: QQCommentLane[];
    gate: QQMusicTransportGate;
    profile: ReturnType<typeof qqMusicTransportProfile>;
    configuredWorkers: number;
    workersPerLane: number;
    laneSelection?: ProxyLaneSelection;
    proxyEnabled: boolean;
  }> {
    const pool = await abortRace(this.poolReader(this.paths.pool), signal);
    throwIfAborted(signal);
    const poolExpected = proxyPoolStatusRunning(pool);
    const available = poolExpected && pool
      ? recentlyVerifiedProxyPoolEntries(pool) ?? await abortRace(this.poolVerifier(pool, signal), signal)
      : [];
    throwIfAborted(signal);
    if (poolExpected && available.length === 0) {
      throw new QQJobManagerError(409, "代理池复核后没有可用出口；QQ 音乐任务不会回退到本机直连。");
    }
    if (!poolExpected && !config.proxy && !config.allowDirect) {
      throw new QQJobManagerError(409, "未检测到可用代理。请先运行代理池、填写单代理，或明确允许本机直连。");
    }
    const selected = selectProxyLanes(
      available,
      config.maxProxyLanes,
      1,
      config.hostConcurrency,
    );
    const entries = selected.entries;
    const endpoints = entries.length > 0 ? entries.map((entry) => entry.endpoint) : [config.proxy];
    // QQ liked-song scans use the shared host limit as their one authoritative
    // task Worker capacity. Per-lane permits are derived after lane selection so
    // one direct/static proxy no longer silently collapses an 8-Worker host cap
    // to a single Worker. Song mode remains one cursor-dependent SeqNo chain.
    const configuredWorkers = config.mode === "song" ? 1 : config.hostConcurrency;
    const workersPerLane = config.mode === "song"
      ? 1
      : Math.max(1, Math.ceil(configuredWorkers / endpoints.length));
    const profile = qqMusicTransportProfile(
      config.mode,
      endpoints.length,
      configuredWorkers,
    );
    const gate = new QQMusicTransportGate({
      maxConcurrent: profile.maxConcurrent,
      minStartDelayMs: profile.minStartDelayMs,
    });
    const lanes = endpoints.map((endpoint, index) => ({
      name: entries[index]?.name ?? (endpoint ? "static-proxy" : "direct"),
      client: this.clientFactory(endpoint),
      transportGate: gate,
      governor: new RequestGovernor({
        requestBudget: 0,
        concurrency: 1,
        minDelayMs: config.minDelayMs,
        jitterMs: config.jitterMs,
        maxRetries: 2,
        forbiddenCooldownMs: config.forbiddenCooldownMs,
        platformPolicy: "qq",
      }),
    }));
    return {
      lanes,
      gate,
      profile,
      configuredWorkers,
      workersPerLane,
      laneSelection: entries.length > 0 ? selected.selection : undefined,
      proxyEnabled: entries.length > 0 || Boolean(config.proxy),
    };
  }

  private async resolveCanonicalTarget(input: string) {
    const resolved = await executeControlAcrossLanes(this.lanes, "qq_resolve_user", (lane) =>
      lane.client.resolveUser(input, lane.transportGate.signal)
    );
    return { ...resolved, encryptUin: canonicalEncryptUin(resolved.encryptUin) };
  }

  private trackRequest(activeId: string, activity: QQMusicRequestActivity): void {
    if (!this.isCurrent(activeId) || activity.operation !== "comment-page") return;
    if (activity.phase === "start") {
      if (!this.progressBySong.has(activity.songId)) {
        this.progressBySong.set(activity.songId, {
          songId: activity.songId,
          songName: activity.songName,
          pages: 0,
          comments: 0,
          total: activity.totalComments,
          done: false,
          truncated: false,
        });
        this.trimSongProgress();
      }
      this.activeByWorker.set(activity.workerId, {
        id: activity.songId,
        name: activity.songName,
        page: activity.page,
        startedAt: activity.startedAt,
      });
      this.seenWorkers.add(activity.workerId);
      this.seenLanes.add(activity.lane);
      this.inFlight += 1;
      this.snapshotValue.peakInFlight = Math.max(this.snapshotValue.peakInFlight, this.inFlight);
    } else {
      this.activeByWorker.delete(activity.workerId);
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.pagePerformance.record(activity);
      if (activity.phase === "success") this.commentRate.record(activity.comments ?? 0);
    }
    this.snapshotValue = {
      ...this.snapshotValue,
      participatedWorkers: this.seenWorkers.size,
      participatedLanes: this.seenLanes.size,
      activeSongs: this.activeSongRows(),
    };
  }

  private trackSong(activeId: string, activity: QQMusicSongActivity): void {
    if (!this.isCurrent(activeId)) return;
    if (activity.done || activity.truncated) this.progressBySong.delete(activity.songId);
    else this.progressBySong.set(activity.songId, activity);
    this.trimSongProgress();
    this.snapshotValue = {
      ...this.snapshotValue,
      songName: this.snapshotValue.mode === "song" ? activity.songName ?? this.snapshotValue.songName : this.snapshotValue.songName,
      activeSongs: this.activeSongRows(),
    };
  }

  private trimSongProgress(): void {
    while (this.progressBySong.size > ACTIVE_SONG_LIMIT) {
      const activeIds = new Set([...this.activeByWorker.values()].map((item) => item.id));
      const oldestInactive = [...this.progressBySong.keys()].find((id) => !activeIds.has(id));
      if (!oldestInactive) return;
      this.progressBySong.delete(oldestInactive);
    }
  }

  private activeSongRows(): QQActiveSongSnapshot[] {
    const workerCounts = new Map<string, number>();
    for (const active of this.activeByWorker.values()) {
      workerCounts.set(active.id, (workerCounts.get(active.id) ?? 0) + 1);
    }
    const ids = new Set([...this.progressBySong.keys(), ...this.activeByWorker.values()].map((value) => typeof value === "string" ? value : value.id));
    return [...ids].slice(-ACTIVE_SONG_LIMIT).map((id) => {
      const progress = this.progressBySong.get(id);
      const request = [...this.activeByWorker.values()].find((item) => item.id === id);
      const total = progress?.total;
      const inspected = progress?.comments;
      return {
        id,
        name: progress?.songName ?? request?.name,
        workers: workerCounts.get(id) ?? 0,
        pageSize: this.snapshotValue.pageSize,
        pagesProcessed: progress?.pages,
        requestingPage: request?.page,
        requestStartedAt: request?.startedAt ? Date.parse(request.startedAt) : undefined,
        commentsProcessed: inspected,
        totalComments: total,
        progressPercent: total && total > 0 && inspected !== undefined ? Math.min(100, inspected / total * 100) : undefined,
        truncated: progress?.truncated,
      };
    });
  }

  private publishMatch(activeId: string, comment: QQMusicFoundComment): void {
    const generation = this.generation;
    if (!generation || !this.isCurrent(activeId)) return;
    const event = { generation: publicGeneration(generation), comment };
    for (const [subscriber, expectedJobId] of this.subscribers) {
      if (expectedJobId !== activeId) continue;
      try { subscriber(event); } catch { /* A disconnected renderer cannot interrupt persistence. */ }
    }
  }

  private requireGeneration(expectedJobId: string): InternalGeneration {
    const generation = this.generation;
    if (!generation || generation.jobId !== expectedJobId || this.snapshotValue.id !== expectedJobId) {
      throw staleGenerationError();
    }
    return { ...generation, target: { ...generation.target } };
  }

  private requireExactGeneration(expected: QQJobGeneration): InternalGeneration {
    const generation = this.requireGeneration(expected.jobId);
    if (expected.platform !== "qq" || expected.mode !== generation.mode
      || expected.target.kind !== "encryptUin" || expected.target.value !== generation.target.value) {
      throw staleGenerationError();
    }
    return generation;
  }

  private assertGeneration(expected: InternalGeneration): void {
    const current = this.generation;
    if (!current || current.jobId !== expected.jobId || current.mode !== expected.mode
      || current.target.value !== expected.target.value || current.outputPath !== expected.outputPath
      || this.snapshotValue.id !== expected.jobId) {
      throw staleGenerationError();
    }
  }

  private isCurrent(activeId: string): boolean {
    return this.snapshotValue.id === activeId;
  }

  private throwIfStopped(): void {
    if (this.abortController?.signal.aborted) throw new RunCancelled();
  }

  private fail(activeId: string, error: unknown): void {
    if (!this.isCurrent(activeId)) return;
    this.snapshotValue = {
      ...this.snapshotValue,
      status: "error",
      finishedAt: this.now().toISOString(),
      activeSongs: [],
      commentsPerSecond: 0,
      error: message(error),
    };
  }

  private releaseRun(activeId: string): void {
    if (!this.isCurrent(activeId)) return;
    this.abortController?.abort();
    this.transportGate?.cancel();
    cancelQQMusicLanes(this.lanes);
    this.activeByWorker.clear();
    this.progressBySong.clear();
    this.abortController = undefined;
    this.transportGate = undefined;
    this.lanes = [];
    this.inFlight = 0;
    this.lease?.release();
    this.lease = undefined;
  }

  private resetActivity(): void {
    this.activeByWorker.clear();
    this.progressBySong.clear();
    this.seenWorkers.clear();
    this.seenLanes.clear();
    this.commentRate.reset();
    this.pagePerformance.reset();
    this.inFlight = 0;
  }
}

interface ParsedStartRequest {
  mode: "song" | "likes";
  target: string;
  songId?: string;
  pageSize: number;
  likedPageSize: number;
  requestBudget: number;
  minDelayMs: number;
  jitterMs: number;
  forbiddenCooldownMs: number;
  maxCommentPagesPerSong: number;
  maxSongs: number;
  stopAfterFirst: boolean;
  fresh: boolean;
  proxy?: string;
  allowDirect: boolean;
  maxProxyLanes: number;
  hostConcurrency: number;
}

type LanePreparationConfig = Pick<
  ParsedStartRequest,
  | "mode"
  | "minDelayMs"
  | "jitterMs"
  | "forbiddenCooldownMs"
  | "proxy"
  | "allowDirect"
  | "maxProxyLanes"
  | "hostConcurrency"
>;

function parseStartRequest(input: QQStartRequest): ParsedStartRequest {
  if (!input || typeof input !== "object") throw new QQJobManagerError(400, "QQ 音乐任务参数格式错误。");
  const mode = oneOf(input.mode, ["song", "likes"] as const, "mode");
  const target = text(input.target, "target", 1, 512);
  try {
    normalizeUserInput(target);
  } catch {
    throw new QQJobManagerError(400, "QQ 音乐用户目标格式错误。");
  }
  const songId = mode === "song" ? decimalId(input.songId, "QQ 音乐歌曲 ID") : undefined;
  // Validate the legacy field when older resume descriptors send it, but QQ
  // dashboard scheduling is now governed solely by hostConcurrency.
  if (input.workersPerProxy !== undefined) {
    integer(input.workersPerProxy, "workersPerProxy", 1, 8);
  }
  return {
    mode,
    target,
    songId,
    pageSize: integer(input.pageSize ?? 25, "pageSize", 1, 25),
    likedPageSize: integer(input.likedPageSize ?? 500, "likedPageSize", 1, 500),
    requestBudget: integer(input.requestBudget ?? 0, "requestBudget", 0, 100_000),
    minDelayMs: integer(input.minDelayMs ?? 3_000, "minDelayMs", 0, 600_000),
    jitterMs: integer(input.jitterMs ?? 1_000, "jitterMs", 0, 600_000),
    forbiddenCooldownMs: integer(input.forbiddenCooldownMs ?? 900_000, "forbiddenCooldownMs", 1_000, 86_400_000),
    maxCommentPagesPerSong: integer(input.maxCommentPagesPerSong ?? 0, "maxCommentPagesPerSong", 0, 1_000_000),
    maxSongs: integer(input.maxSongs ?? 0, "maxSongs", 0, 100_000),
    stopAfterFirst: boolean(input.stopAfterFirst),
    fresh: boolean(input.fresh),
    proxy: proxyUrl(input.proxy),
    allowDirect: boolean(input.allowDirect),
    maxProxyLanes: integer(input.maxProxyLanes ?? 0, "maxProxyLanes", 0, 32),
    hostConcurrency: integer(input.hostConcurrency ?? 8, "hostConcurrency", 1, 32),
  };
}

function qqTaskPaths(dataPath: string, mode: "song" | "likes", canonicalTarget: string, songId?: string) {
  const key = stableQQMusicTaskKey(mode, canonicalTarget, mode === "song" ? songId : undefined);
  return {
    statePath: join(dataPath, "qq", `state-${key}.json`),
    outputPath: join(dataPath, "qq", `comments-${key}.jsonl`),
  };
}

function publicGeneration(generation: InternalGeneration): QQJobGeneration {
  return {
    platform: "qq",
    mode: generation.mode,
    jobId: generation.jobId,
    target: { ...generation.target },
  };
}

function cloneInternalGeneration(generation: InternalGeneration): InternalGeneration {
  return { ...generation, target: { ...generation.target } };
}

function cloneSnapshot(snapshot: QQJobSnapshot): QQJobSnapshot {
  return {
    ...snapshot,
    generation: snapshot.generation
      ? { ...snapshot.generation, target: { ...snapshot.generation.target } }
      : undefined,
    activeSongs: snapshot.activeSongs.map((song) => ({ ...song })),
  };
}

function defaultClientFactory(proxy?: string): QQMusicPlatformClient {
  return proxy
    ? new QQMusicClient({ fetch: createQQMusicProxyFetch({ proxyUrl: proxy }) })
    : new QQMusicClient();
}

function emptySnapshot(): QQJobSnapshot {
  return {
    platform: "qq",
    status: "idle",
    songs: 0,
    songsProcessed: 0,
    activeSongs: [],
    pagesProcessed: 0,
    commentsInspected: 0,
    matches: 0,
    requestsTotal: 0,
    commentsPerSecond: 0,
    elapsedMs: 0,
    configuredLanes: 0,
    configuredWorkers: 0,
    participatedLanes: 0,
    participatedWorkers: 0,
    peakInFlight: 0,
    proxyEnabled: false,
    coverageComplete: false,
    pageRequestSamples: 0,
    pageRequestAttempts: 0,
    successfulPageRequests: 0,
    failedPageRequests: 0,
  };
}

function staleGenerationError(): QQJobManagerError {
  return new QQJobManagerError(409, "当前 QQ 音乐任务已经切换，请重新加载。");
}

function maskTarget(value: string): string {
  if (value.length > 8) return `${value.slice(0, 4)}****${value.slice(-4)}`;
  if (value.length > 4) return `${value.slice(0, 2)}****${value.slice(-2)}`;
  return `${value.slice(0, 1)}***${value.slice(-1)}`;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (!allowed.includes(value as T[number])) throw new QQJobManagerError(400, `${name} 参数错误。`);
  return value as T[number];
}

function text(value: unknown, name: string, minimum: number, maximum: number): string {
  const result = String(value ?? "").trim();
  if (result.length < minimum || result.length > maximum) throw new QQJobManagerError(400, `${name} 长度错误。`);
  return result;
}

function decimalId(value: unknown, name: string): string {
  const result = String(value ?? "").trim();
  if (!/^\d+$/.test(result)) throw new QQJobManagerError(400, `${name} 格式错误。`);
  return result;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new QQJobManagerError(400, `${name} 必须是 ${minimum}..${maximum} 之间的整数。`);
  }
  return result;
}

function boolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function proxyUrl(value: unknown): string | undefined {
  const result = String(value ?? "").trim();
  if (!result) return undefined;
  let parsed: URL;
  try { parsed = new URL(result); } catch { throw new QQJobManagerError(400, "代理 URL 格式错误。"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new QQJobManagerError(400, "QQ 音乐仅支持 HTTP/HTTPS 代理。");
  }
  if (!parsed.hostname || (parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    throw new QQJobManagerError(400, "代理 URL 不能包含路径、查询参数或片段。");
  }
  return parsed.toString();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RunCancelled();
}

async function executeControlAcrossLanes<T>(
  lanes: QQCommentLane[],
  label: string,
  request: (lane: QQCommentLane) => Promise<T>,
): Promise<T> {
  if (lanes.length === 0) throw new QQJobManagerError(409, "QQ 音乐任务没有可用出口。");
  let lastLaneError: unknown;
  for (const lane of lanes) {
    try {
      return await lane.governor.execute(label, () =>
        lane.transportGate.run(() => request(lane))
      );
    } catch (error) {
      if (error instanceof RunCancelled || error instanceof CooldownRequired) throw error;
      if (!isLaneControlFailure(error)) throw error;
      lastLaneError = error;
    }
  }
  throw lastLaneError ?? new QQJobManagerError(409, "QQ 音乐任务没有可用出口。");
}

function isLaneControlFailure(error: unknown, visited = new Set<object>()): boolean {
  if (!error || typeof error !== "object" || visited.has(error)) return false;
  visited.add(error);
  if (error instanceof QQMusicProxyError) return true;
  if (error instanceof QQMusicApiError) return error.retryable;
  if (error instanceof TypeError) return true;
  const candidate = error as Record<string, unknown>;
  if (typeof candidate.code === "string" && /^(?:EAI_AGAIN|ECONN|EHOST|ENET|ETIMEDOUT)/.test(candidate.code)) return true;
  return isLaneControlFailure(candidate.cause, visited);
}

function canonicalEncryptUin(value: unknown): string {
  const canonical = String(value ?? "").trim();
  if (!/^[A-Za-z0-9*_.-]{4,128}$/.test(canonical)) {
    throw new QQJobManagerError(502, "QQ 音乐返回了无效的 EncryptUin。");
  }
  return canonical;
}

function verificationProfileField(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new QQJobManagerError(502, `QQ 音乐公开身份响应缺少可验证的${field}。`);
  }
  return normalized;
}

async function abortRace<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new RunCancelled());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
