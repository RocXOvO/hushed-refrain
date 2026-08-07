import {
  DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT,
  DEFAULT_PROXY_TRANSPORT_START_DELAY_MS,
  DEFAULT_PROXY_TRANSPORT_START_JITTER_MS,
} from "./proxy-transport-gate";

export interface EstimateInput {
  comments: number;
  pageSize: number;
  minDelayMs: number;
  jitterMs: number;
  networkMs?: number;
  lanes?: number;
  workersPerLane?: number;
  maxWorkers?: number;
  proxyTransport?: boolean;
  proxyTransportMaxConcurrent?: number;
  proxyTransportStartDelayMs?: number;
  proxyTransportStartJitterMs?: number;
}

export interface ScanEstimate {
  comments: number;
  pages: number;
  optimisticSeconds: number;
  expectedSeconds: number;
  conservativeSeconds: number;
  expectedCommentsPerSecond: number;
  lanes: number;
  workersPerLane: number;
  totalWorkers: number;
  effectiveWorkers?: number;
  proxyTransportMaxConcurrent?: number;
  proxyTransportStartDelayMs?: number;
  proxyTransportStartJitterMs?: number;
}

export function estimateCommentScan(input: EstimateInput): ScanEstimate {
  const comments = nonNegativeInteger(input.comments, "comments");
  const pageSize = positiveInteger(input.pageSize, "pageSize");
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
    proxyTransport ? proxyTransportMaxConcurrent : Number.POSITIVE_INFINITY,
  );
  const pages = Math.ceil(comments / pageSize);

  const duration = (spacingMs: number, transportJitterFactor: number): number => {
    if (pages === 0) return 0;
    const perLaneCycleMs = Math.max(spacingMs, networkMs) / workersPerLane;
    const laneTopologyCycleMs = perLaneCycleMs / lanes;
    const workerCycleMs = networkMs / effectiveWorkers;
    const transportCycleMs = proxyTransport
      ? Math.max(
        proxyTransportStartDelayMs + proxyTransportStartJitterMs * transportJitterFactor,
        networkMs / proxyTransportMaxConcurrent,
      )
      : 0;
    return Math.ceil(Math.max(networkMs, pages * Math.max(laneTopologyCycleMs, workerCycleMs, transportCycleMs)) / 1_000);
  };
  const optimisticSeconds = duration(minDelayMs, 0);
  const expectedSeconds = duration(minDelayMs + jitterMs / 2, 0.5);
  const conservativeSeconds = duration(minDelayMs + jitterMs, 1);

  return {
    comments,
    pages,
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
        proxyTransportStartDelayMs,
        proxyTransportStartJitterMs,
      }
      : {}),
  };
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
