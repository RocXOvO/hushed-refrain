export interface ProxyLaneSelection {
  mode: "auto" | "manual";
  available: number;
  selected: number;
  requested: number;
}

export function selectProxyLanes<T>(
  entries: readonly T[],
  requested: number,
  workersPerLane: number,
  hostConcurrency: number,
): { entries: T[]; selection: ProxyLaneSelection } {
  assertNonNegativeInteger(requested, "requested proxy lanes");
  assertPositiveInteger(workersPerLane, "workers per lane");
  assertPositiveInteger(hostConcurrency, "host concurrency");

  const available = entries.length;
  const target = requested === 0 ? available : requested;
  const selected = Math.min(available, target);
  return {
    entries: entries.slice(0, selected),
    selection: {
      mode: requested === 0 ? "auto" : "manual",
      available,
      selected,
      requested,
    },
  };
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
}
