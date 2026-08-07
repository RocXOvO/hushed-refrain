import {
  DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT,
  DEFAULT_PROXY_TRANSPORT_START_DELAY_MS,
  DEFAULT_PROXY_TRANSPORT_START_JITTER_MS,
} from "./proxy-transport-gate";

export interface EstimateInput {
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
}

export interface ScanEstimate {
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
}

export function estimateCommentScan(input: EstimateInput): ScanEstimate {
  const comments = nonNegativeInteger(input.comments, "comments");
  const pageSize = positiveInteger(input.pageSize, "pageSize");
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
  const proxyTransport = Boolean(input.proxyTransport);
  const proxyTransportMaxConcurrent = positiveInteger(
    input.proxyTransportMaxConcurrent ?? DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT,
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
    input.proxyTransportStartDelayMs ?? DEFAULT_PROXY_TRANSPORT_START_DELAY_MS,
    "proxyTransportStartDelayMs",
  );
  const proxyTransportStartJitterMs = nonNegativeInteger(
    input.proxyTransportStartJitterMs ?? DEFAULT_PROXY_TRANSPORT_START_JITTER_MS,
    "proxyTransportStartJitterMs",
  );
  const totalWorkers = lanes * workersPerLane;
  const maxWorkers = input.maxWorkers === undefined
    ? totalWorkers
    : positiveInteger(input.maxWorkers, "maxWorkers");
  const effectiveWorkers = Math.min(
    totalWorkers,
    maxWorkers,
    proxyTransport ? proxyTransportEffectiveConcurrent : Number.POSITIVE_INFINITY,
  );
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
    const perLaneCycleMs = Math.max(spacingMs, networkMs) / workersPerLane;
    const laneTopologyCycleMs = perLaneCycleMs / lanes;
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
    ...(input.maxWorkers !== undefined || proxyTransport ? { effectiveWorkers } : {}),
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
