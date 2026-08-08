import { QQ_MUSIC_COMMENT_PAGE_SIZE_MAX } from "./client";
import { workerCountForTopology } from "../worker-topology";

export type QQMusicBenchmarkMode = "song" | "likes";

export interface QQMusicBenchmarkInput {
  mode: QQMusicBenchmarkMode;
  lanes: number;
  workersPerLane: number;
  maxWorkers: number;
  songCount: number;
  pagesPerSong: number;
  pageSize: number;
  minDelayMs: number;
  averageJitterMs: number;
  gateMaxConcurrent: number;
  gateMinStartDelayMs: number;
  averageRequestMs: number;
  averageCheckpointMs: number;
  averageCheckpointBytes?: number;
  checkpointIntervalMs?: number;
  checkpointPageCap?: number;
  checkpointSlots?: number;
  averageCheckpointBatchPages?: number;
  sourceRequests?: number;
}

export interface QQMusicBenchmarkResult {
  mode: QQMusicBenchmarkMode;
  pages: number;
  comments: number;
  requests: number;
  durationMs: number;
  pagesPerSecond: number;
  commentsPerSecond: number;
  maxSameSongConcurrent: 1;
  participatingLanes: number;
  workers: number;
  pageCheckpointWrites: number;
  controlCheckpointWrites: number;
  checkpointWrites: number;
  checkpointBytes: number;
  sourceDurationMs: number;
}

/**
 * Deterministic delay-bound model for comparing QQ scan topologies without
 * sending traffic to QQ Music. It intentionally keeps one request chain per
 * song and never treats workers on one lane as extra per-IP request-start
 * rate. Workers may still overlap already-started requests up to the shared
 * transport/checkpoint bounds, matching RequestGovernor semantics.
 */
export function modelQQMusicBenchmark(
  input: QQMusicBenchmarkInput,
): QQMusicBenchmarkResult {
  validateInput(input);
  const pages = input.songCount * input.pagesPerSong;
  const comments = pages * input.pageSize;
  const sourceRequests = input.sourceRequests ?? (input.mode === "likes" ? 1 : 0);
  const requests = pages + sourceRequests;
  const laneCycleMs = input.minDelayMs + input.averageJitterMs;
  const perLaneRateBoundMs = laneCycleMs / input.lanes;
  const boundedCheckpoint = input.mode === "likes" && (input.checkpointIntervalMs ?? 0) > 0;
  const checkpointBatchPages = boundedCheckpoint
    ? input.averageCheckpointBatchPages ?? (input.checkpointPageCap ?? 4)
    : 1;
  const checkpointBoundMs = input.averageCheckpointMs / checkpointBatchPages;
  // A fresh song scan checkpoints task creation, resolved song metadata and
  // terminal state. Likes mode checkpoints task creation, every source page
  // and terminal state.
  const controlCheckpointWrites = input.mode === "song" ? 3 : 2 + sourceRequests;
  const workers = input.mode === "song"
    ? 1
    : workerCountForTopology(input.lanes, input.workersPerLane, input.maxWorkers);

  let startIntervalMs: number;
  if (input.mode === "song") {
    startIntervalMs = Math.max(
      input.gateMinStartDelayMs,
      perLaneRateBoundMs,
      input.averageRequestMs + checkpointBoundMs,
    );
  } else {
    const activeRequests = Math.max(1, Math.min(
      input.songCount,
      workers,
      input.gateMaxConcurrent,
      input.checkpointSlots ?? input.gateMaxConcurrent,
    ));
    startIntervalMs = Math.max(
      input.gateMinStartDelayMs,
      perLaneRateBoundMs,
      input.averageRequestMs / activeRequests,
      checkpointBoundMs,
    );
  }

  const commentDurationMs = pages === 0
    ? 0
    : ((pages - 1) * startIntervalMs) + input.averageRequestMs + checkpointBoundMs;
  const sourceDurationMs = sourceRequests * Math.max(laneCycleMs, input.averageRequestMs);
  const durationMs = commentDurationMs
    + sourceDurationMs
    + controlCheckpointWrites * input.averageCheckpointMs;
  const measuredSeconds = durationMs / 1_000;
  const pagesPerSecond = measuredSeconds > 0 ? pages / measuredSeconds : 0;
  const commentsPerSecond = measuredSeconds > 0 ? comments / measuredSeconds : 0;

  const pageCheckpointWrites = boundedCheckpoint
    ? input.averageCheckpointBatchPages !== undefined
      ? Math.ceil(pages / input.averageCheckpointBatchPages)
      : Math.min(pages, Math.max(
        1,
        Math.ceil(commentDurationMs / input.checkpointIntervalMs!),
        Math.ceil(pages / (input.checkpointPageCap ?? 4)),
      ))
    : pages;
  const checkpointWrites = pageCheckpointWrites + controlCheckpointWrites;
  const checkpointBytes = checkpointWrites * (input.averageCheckpointBytes ?? 0);

  return {
    mode: input.mode,
    pages,
    comments,
    requests,
    durationMs,
    pagesPerSecond,
    commentsPerSecond,
    maxSameSongConcurrent: 1,
    participatingLanes: Math.min(input.lanes, pages),
    workers,
    pageCheckpointWrites,
    controlCheckpointWrites,
    checkpointWrites,
    checkpointBytes,
    sourceDurationMs,
  };
}

function validateInput(input: QQMusicBenchmarkInput): void {
  positiveInteger(input.lanes, "lanes");
  positiveInteger(input.workersPerLane, "workersPerLane");
  positiveInteger(input.maxWorkers, "maxWorkers");
  positiveInteger(input.songCount, "songCount");
  positiveInteger(input.pagesPerSong, "pagesPerSong");
  positiveInteger(input.pageSize, "pageSize");
  if (input.pageSize > QQ_MUSIC_COMMENT_PAGE_SIZE_MAX) {
    throw new Error(`pageSize cannot exceed the live QQ Music limit ${QQ_MUSIC_COMMENT_PAGE_SIZE_MAX}.`);
  }
  positiveInteger(input.gateMaxConcurrent, "gateMaxConcurrent");
  nonNegative(input.minDelayMs, "minDelayMs");
  nonNegative(input.averageJitterMs, "averageJitterMs");
  nonNegative(input.gateMinStartDelayMs, "gateMinStartDelayMs");
  nonNegative(input.averageRequestMs, "averageRequestMs");
  nonNegative(input.averageCheckpointMs, "averageCheckpointMs");
  if (input.averageCheckpointBytes !== undefined) nonNegative(input.averageCheckpointBytes, "averageCheckpointBytes");
  if (input.checkpointIntervalMs !== undefined) nonNegative(input.checkpointIntervalMs, "checkpointIntervalMs");
  if (input.checkpointPageCap !== undefined) positiveInteger(input.checkpointPageCap, "checkpointPageCap");
  if (input.checkpointSlots !== undefined) positiveInteger(input.checkpointSlots, "checkpointSlots");
  if (input.averageCheckpointBatchPages !== undefined) {
    positive(input.averageCheckpointBatchPages, "averageCheckpointBatchPages");
    if (input.averageCheckpointBatchPages > (input.checkpointPageCap ?? 4)) {
      throw new Error("averageCheckpointBatchPages cannot exceed checkpointPageCap.");
    }
  }
  if (input.sourceRequests !== undefined) nonNegativeInteger(input.sourceRequests, "sourceRequests");
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
}

function nonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
}

function nonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative.`);
}

function positive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`);
}
