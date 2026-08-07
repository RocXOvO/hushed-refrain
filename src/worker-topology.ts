export function workerCountForTopology(
  laneCount: number,
  workersPerLane: number,
  maxWorkers?: number,
): number {
  assertPositiveInteger(laneCount, "laneCount");
  assertPositiveInteger(workersPerLane, "workersPerLane");
  if (maxWorkers !== undefined) assertPositiveInteger(maxWorkers, "maxWorkers");
  return Math.min(laneCount * workersPerLane, maxWorkers ?? Number.POSITIVE_INFINITY);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
}
