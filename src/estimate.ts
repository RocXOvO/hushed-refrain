import {
  DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT,
  DEFAULT_PROXY_TRANSPORT_START_DELAY_MS,
  DEFAULT_PROXY_TRANSPORT_START_JITTER_MS,
} from "./proxy-transport-gate";
import { qqMusicTransportProfile } from "./qq-music/transport-gate";

export type EstimatePlatform = "netease" | "qq";

const QQ_COMMENT_PAGE_SIZE_MAX = 25;

export interface EstimateInput {
  platform?: EstimatePlatform;
  comments: number;
  pageSize: number;
  partitions?: number;
  observedCommentsPerPage?: number;
  requestSuccessRatio?: number;
  minDelayMs: number;
  jitterMs: number;
  networkMs?: number;
  lanes?: number;
  workersPerLane?: number;
  maxWorkers?: number;
  proxyTransport?: boolean;
  proxyTransportMaxConcurrent?: number;
  proxyTransportEffectiveConcurrent?: number;
  proxyTransportStartDelayMs?: number;
  proxyTransportEffectiveStartDelayMs?: number;
  proxyTransportStartJitterMs?: number;
  serialRequestChain?: boolean;
  workersShareLanePacing?: boolean;
  checkpointSlots?: number;
}

export interface ScanEstimate {
  platform?: EstimatePlatform;
  comments: number;
  pages: number;
  estimatedRequests: number;
  partitions: number;
  commentsPerPage: number;
  requestSuccessRatio: number;
  optimisticSeconds: number;
  expectedSeconds: number;
  conservativeSeconds: number;
  expectedCommentsPerSecond: number;
  lanes: number;
  workersPerLane: number;
  totalWorkers: number;
  effectiveWorkers?: number;
  proxyTransportMaxConcurrent?: number;
  proxyTransportEffectiveConcurrent?: number;
  proxyTransportStartDelayMs?: number;
  proxyTransportStartJitterMs?: number;
  checkpointSlots?: number;
  serialRequestChain?: boolean;
  workersShareLanePacing?: boolean;
}

export function estimateCommentScan(input: EstimateInput): ScanEstimate {
  const platform = input.platform ?? "netease";
  const comments = nonNegativeInteger(input.comments, "comments");
  const pageSize = positiveInteger(input.pageSize, "pageSize");
  if (platform === "qq" && pageSize > QQ_COMMENT_PAGE_SIZE_MAX) {
    throw new Error(`QQ Music pageSize must not exceed ${QQ_COMMENT_PAGE_SIZE_MAX}.`);
  }
  const partitions = positiveInteger(input.partitions ?? 1, "partitions");
  const commentsPerPage = input.observedCommentsPerPage === undefined
    ? pageSize
    : positiveNumber(input.observedCommentsPerPage, "observedCommentsPerPage");
  const requestSuccessRatio = input.requestSuccessRatio === undefined
    ? 1
    : ratio(input.requestSuccessRatio, "requestSuccessRatio");
  const minDelayMs = nonNegativeInteger(input.minDelayMs, "minDelayMs");
  const jitterMs = nonNegativeInteger(input.jitterMs, "jitterMs");
  const networkMs = nonNegativeInteger(input.networkMs ?? 400, "networkMs");
  const lanes = positiveInteger(input.lanes ?? 1, "lanes");
  const workersPerLane = positiveInteger(input.workersPerLane ?? 1, "workersPerLane");
  const totalWorkers = lanes * workersPerLane;
  const maxWorkers = input.maxWorkers === undefined
    ? totalWorkers
    : positiveInteger(input.maxWorkers, "maxWorkers");
  const serialRequestChain = Boolean(input.serialRequestChain);
  const workersShareLanePacing = Boolean(input.workersShareLanePacing);
  const qqProfile = platform === "qq"
    ? qqMusicTransportProfile(serialRequestChain ? "song" : "likes", lanes, Math.min(totalWorkers, maxWorkers))
    : undefined;
  const proxyTransport = platform === "qq" || Boolean(input.proxyTransport);
  const proxyTransportMaxConcurrent = positiveInteger(
    input.proxyTransportMaxConcurrent
      ?? (qqProfile?.maxConcurrent ?? DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT),
    "proxyTransportMaxConcurrent",
  );
  const proxyTransportEffectiveConcurrent = positiveInteger(
    input.proxyTransportEffectiveConcurrent ?? proxyTransportMaxConcurrent,
    "proxyTransportEffectiveConcurrent",
  );
  if (proxyTransportEffectiveConcurrent > proxyTransportMaxConcurrent) {
    throw new Error("proxyTransportEffectiveConcurrent must not exceed proxyTransportMaxConcurrent.");
  }
  const proxyTransportStartDelayMs = nonNegativeInteger(
    input.proxyTransportStartDelayMs
      ?? (qqProfile?.minStartDelayMs ?? DEFAULT_PROXY_TRANSPORT_START_DELAY_MS),
    "proxyTransportStartDelayMs",
  );
  const proxyTransportStartJitterMs = nonNegativeInteger(
    input.proxyTransportStartJitterMs
      ?? (platform === "qq" ? 0 : DEFAULT_PROXY_TRANSPORT_START_JITTER_MS),
    "proxyTransportStartJitterMs",
  );
  const boundedWorkers = Math.min(
    totalWorkers,
    maxWorkers,
    proxyTransport ? proxyTransportEffectiveConcurrent : Number.POSITIVE_INFINITY,
  );
  const checkpointSlots = platform === "qq"
    ? positiveInteger(input.checkpointSlots ?? qqProfile!.checkpointSlots, "checkpointSlots")
    : Number.POSITIVE_INFINITY;
  const effectiveWorkers = serialRequestChain
    ? 1
    : Math.min(boundedWorkers, checkpointSlots);
  const pacingWorkersPerLane = serialRequestChain || workersShareLanePacing
    ? 1
    : workersPerLane;
  const pages = pageCount(
    comments,
    pageSize,
    commentsPerPage,
    partitions,
    input.observedCommentsPerPage !== undefined,
    input.partitions !== undefined,
  );
  const estimatedRequests = pages === 0 ? 0 : Math.ceil(pages / requestSuccessRatio);
  const effectiveTransportStartDelayMs = proxyTransport
    ? Math.ceil(proxyTransportStartDelayMs * proxyTransportMaxConcurrent / proxyTransportEffectiveConcurrent)
    : 0;

  const duration = (spacingMs: number, transportJitterFactor: number): number => {
    if (estimatedRequests === 0) return 0;
    const laneTopologyCycleMs = spacingMs / pacingWorkersPerLane / lanes;
    const workerCycleMs = networkMs / effectiveWorkers;
    const transportCycleMs = proxyTransport
      ? Math.max(
        effectiveTransportStartDelayMs + proxyTransportStartJitterMs * transportJitterFactor,
        networkMs / proxyTransportEffectiveConcurrent,
      )
      : 0;
    return Math.ceil(Math.max(networkMs, estimatedRequests * Math.max(laneTopologyCycleMs, workerCycleMs, transportCycleMs)) / 1_000);
  };
  const optimisticSeconds = duration(minDelayMs, 0);
  const expectedSeconds = duration(minDelayMs + jitterMs / 2, 0.5);
  const conservativeSeconds = duration(minDelayMs + jitterMs, 1);

  return {
    ...(input.platform !== undefined ? { platform } : {}),
    comments,
    pages,
    estimatedRequests,
    partitions,
    commentsPerPage: Number(commentsPerPage.toFixed(2)),
    requestSuccessRatio,
    optimisticSeconds,
    expectedSeconds,
    conservativeSeconds,
    expectedCommentsPerSecond:
      expectedSeconds === 0 ? 0 : Number((comments / expectedSeconds).toFixed(2)),
    lanes,
    workersPerLane,
    totalWorkers,
    ...(input.maxWorkers !== undefined || proxyTransport || serialRequestChain ? { effectiveWorkers } : {}),
    ...(platform === "qq" ? { checkpointSlots } : {}),
    ...(serialRequestChain ? { serialRequestChain: true } : {}),
    ...(workersShareLanePacing ? { workersShareLanePacing: true } : {}),
    ...(proxyTransport
      ? {
        proxyTransportMaxConcurrent,
        proxyTransportEffectiveConcurrent,
        proxyTransportStartDelayMs,
        proxyTransportEffectiveStartDelayMs: effectiveTransportStartDelayMs,
        proxyTransportStartJitterMs,
      }
      : {}),
  };
}

function pageCount(
  comments: number,
  pageSize: number,
  commentsPerPage: number,
  partitions: number,
  calibrated: boolean,
  partitionsExplicit: boolean,
): number {
  if (comments === 0) return partitionsExplicit ? partitions : 0;
  if (calibrated) return Math.max(partitions, Math.ceil(comments / Math.min(pageSize, commentsPerPage)));
  const smallerPartitionSize = Math.floor(comments / partitions);
  const largerPartitions = comments % partitions;
  return (partitions - largerPartitions) * Math.max(1, Math.ceil(smallerPartitionSize / pageSize))
    + largerPartitions * Math.max(1, Math.ceil((smallerPartitionSize + 1) / pageSize));
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

function ratio(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be greater than zero and no greater than one.`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}
