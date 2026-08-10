import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readJsonlTail } from "./jsonl-tail";
import type { ScanSchedulerActivity } from "./types";

/** Stable page-request shape consumed by shared diagnostics across platforms. */
export interface PageRequestActivity {
  phase: "start" | "success" | "failure";
  startedAt?: string;
  lane: string;
  workerId?: string;
  operation: "comment-page" | "comment-floor";
  songId: string;
  songName?: string;
  page: number;
  shardId?: number;
  parentCommentId?: string;
  elapsedMs?: number;
  networkElapsedMs?: number;
  attempts?: number;
  comments?: number;
  effectiveComments?: number;
  totalComments?: number;
  hasMore?: boolean;
  status?: number;
  rateLimited?: boolean;
  error?: string;
}

export type TaskLogLevel = "debug" | "info" | "warn" | "error";

export interface TaskLogEntry {
  timestamp: string;
  level: TaskLogLevel;
  event: string;
  mode: "source" | "parallel" | "qq";
  runId: string;
  message: string;
  details?: Record<string, unknown>;
}

export class TaskLogger {
  private tail = Promise.resolve();
  private initialized = false;

  constructor(
    readonly path: string,
    private readonly mode: "source" | "parallel" | "qq",
    private readonly runId: string,
  ) {}

  write(
    level: TaskLogLevel,
    event: string,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const entry: TaskLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      mode: this.mode,
      runId: this.runId,
      message,
      details,
    };
    this.tail = this.tail.then(async () => {
      if (!this.initialized) {
        await mkdir(dirname(this.path), { recursive: true });
        this.initialized = true;
      }
      await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    }).catch(() => {
      // Diagnostics must never interrupt or change scan results.
    });
    return this.tail;
  }

  request(activity: PageRequestActivity): void {
    const suffix = activity.operation === "comment-floor"
      ? `评论 ${activity.parentCommentId ?? "未知"} 的楼中楼第 ${activity.page} 页`
      : activity.shardId === undefined
      ? `第 ${activity.page} 页`
      : `分片 ${activity.shardId} 第 ${activity.page} 页`;
    if (activity.phase === "start") {
      void this.write("debug", "page_start", `${activity.lane} 开始请求歌曲 ${activity.songId} ${suffix}。`, activityDetails(activity));
      return;
    }
    if (activity.phase === "success") {
      void this.write(
        "info",
        "page_success",
        `${activity.lane} 成功读取 ${activity.comments ?? 0} 条评论，耗时 ${activity.elapsedMs ?? 0}ms。`,
        activityDetails(activity),
      );
      return;
    }
    const rateLimited = activity.rateLimited === true;
    void this.write(
      rateLimited ? "warn" : "error",
      rateLimited ? "rate_limited" : "page_failure",
      rateLimited
        ? `${activity.lane} 触发远端风控/限流（${activity.status ?? "未知状态"}），本出口将冷却。`
        : `${activity.lane} 读取失败：${activity.error ?? "未知错误"}`,
      activityDetails(activity),
    );
  }

  scheduler(activity: ScanSchedulerActivity): void {
    void this.write(
      "info",
      "adaptive_split",
      `检测到 ${activity.waitingWorkers} 个空闲 Worker，已将分片 ${activity.originalShardId} 的剩余范围拆分为两段。`,
      activityDetails(activity),
    );
  }
}

export async function readTaskLog(path: string | undefined, limit: number): Promise<TaskLogEntry[]> {
  if (!path) return [];
  return readJsonlTail<TaskLogEntry>(path, limit);
}

function activityDetails(activity: PageRequestActivity | ScanSchedulerActivity): Record<string, unknown> {
  return Object.fromEntries(Object.entries(activity).filter(([, value]) => value !== undefined));
}
