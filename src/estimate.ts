export interface EstimateInput {
  comments: number;
  pageSize: number;
  minDelayMs: number;
  jitterMs: number;
  networkMs?: number;
  lanes?: number;
  workersPerLane?: number;
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
}

export function estimateCommentScan(input: EstimateInput): ScanEstimate {
  const comments = nonNegativeInteger(input.comments, "comments");
  const pageSize = positiveInteger(input.pageSize, "pageSize");
  const minDelayMs = nonNegativeInteger(input.minDelayMs, "minDelayMs");
  const jitterMs = nonNegativeInteger(input.jitterMs, "jitterMs");
  const networkMs = nonNegativeInteger(input.networkMs ?? 400, "networkMs");
  const lanes = positiveInteger(input.lanes ?? 1, "lanes");
  const workersPerLane = positiveInteger(input.workersPerLane ?? 1, "workersPerLane");
  const pages = Math.ceil(comments / pageSize);

  const duration = (spacingMs: number): number => {
    if (pages === 0) return 0;
    const perLaneCycleMs = Math.max(spacingMs, networkMs / workersPerLane);
    return Math.ceil(Math.max(networkMs, pages * perLaneCycleMs / lanes) / 1_000);
  };
  const optimisticSeconds = duration(minDelayMs);
  const expectedSeconds = duration(minDelayMs + jitterMs / 2);
  const conservativeSeconds = duration(minDelayMs + jitterMs);

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
    totalWorkers: lanes * workersPerLane,
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
