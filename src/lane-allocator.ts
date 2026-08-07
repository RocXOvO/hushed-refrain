export interface LanePermit<T> {
  lane: T;
  release: () => void;
}

/** Fairly assigns healthy lanes without exceeding the per-lane worker limit. */
export class LaneAllocator<T> {
  private readonly inUse = new Map<T, number>();
  private readonly waiters = new Set<() => void>();
  private cursor = 0;
  private cancelled = false;

  constructor(
    private readonly lanes: readonly T[],
    private readonly maxPerLane: number,
    private readonly isAvailable: (lane: T) => boolean = () => true,
    private readonly isReady: (lane: T) => boolean = () => true,
    private readonly mayBecomeAvailable: () => boolean = () => false,
  ) {
    if (lanes.length === 0) throw new Error("At least one lane is required.");
    if (!Number.isInteger(maxPerLane) || maxPerLane <= 0) {
      throw new Error("maxPerLane must be a positive integer.");
    }
    for (const lane of lanes) this.inUse.set(lane, 0);
  }

  async acquire(): Promise<LanePermit<T> | undefined> {
    while (!this.cancelled) {
      const permit = this.tryAcquire();
      if (permit) return permit;
      if (!this.lanes.some((lane) => this.isAvailable(lane)) && !this.mayBecomeAvailable()) return undefined;
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
    return undefined;
  }

  notify(): void {
    for (const wake of [...this.waiters]) wake();
    this.waiters.clear();
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.notify();
  }

  private tryAcquire(): LanePermit<T> | undefined {
    for (let offset = 0; offset < this.lanes.length; offset += 1) {
      const index = (this.cursor + offset) % this.lanes.length;
      const lane = this.lanes[index];
      if (
        !this.isAvailable(lane) ||
        !this.isReady(lane) ||
        (this.inUse.get(lane) ?? 0) >= this.maxPerLane
      ) continue;
      this.cursor = (index + 1) % this.lanes.length;
      this.inUse.set(lane, (this.inUse.get(lane) ?? 0) + 1);
      let released = false;
      return {
        lane,
        release: () => {
          if (released) return;
          released = true;
          this.inUse.set(lane, Math.max(0, (this.inUse.get(lane) ?? 1) - 1));
          this.notify();
        },
      };
    }
    return undefined;
  }
}
