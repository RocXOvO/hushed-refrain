export interface CheckpointCoordinatorOptions<State> {
  /** Returns the mutable scanner state that should be cloned for persistence. */
  state: () => State;
  /** Reconciles counters that live outside the scanner state before every opportunity. */
  reconcile?: () => void;
  /** Publishes the current mutable state to the best-effort live status callback. */
  publish: () => void;
  /** Persists one immutable snapshot. Calls are serialized in capture order. */
  persist: (snapshot: State) => Promise<void>;
  liveIntervalMs: number;
  persistIntervalMs: number;
}

/**
 * Coordinates a scanner's live and durable checkpoint paths without owning any
 * scan-domain state. Live publication uses a leading/trailing limiter, while
 * durable snapshots use an independent interval and a serialized write tail.
 */
export class CheckpointCoordinator<State> {
  private persistenceTail = Promise.resolve();
  private lastPersistAt = 0;
  private lastLiveAt = 0;
  private liveTimer: NodeJS.Timeout | undefined;
  private liveDirty = false;
  private disposed = false;

  constructor(private readonly options: CheckpointCoordinatorOptions<State>) {
    if (!Number.isFinite(options.liveIntervalMs) || options.liveIntervalMs < 0) {
      throw new Error("liveIntervalMs must be a non-negative finite number.");
    }
    if (!Number.isFinite(options.persistIntervalMs) || options.persistIntervalMs < 0) {
      throw new Error("persistIntervalMs must be a non-negative finite number.");
    }
  }

  async checkpoint(force = false): Promise<void> {
    if (this.disposed) return;

    this.options.reconcile?.();
    const now = Date.now();
    this.publishLive(now, force);

    if (!force && now - this.lastPersistAt < this.options.persistIntervalMs) return;
    this.lastPersistAt = now;
    const snapshot = structuredClone(this.options.state());
    const write = this.persistenceTail.then(() => this.options.persist(snapshot));
    this.persistenceTail = write.catch(() => undefined);
    await write;
  }

  dispose(): void {
    this.disposed = true;
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
    this.liveDirty = false;
  }

  private publishLive(now: number, force: boolean): void {
    if (force) {
      if (this.liveTimer) clearTimeout(this.liveTimer);
      this.liveTimer = undefined;
      this.liveDirty = false;
      this.lastLiveAt = now;
      this.options.publish();
      return;
    }

    const remaining = this.options.liveIntervalMs - (now - this.lastLiveAt);
    if (remaining <= 0 && !this.liveTimer) {
      this.lastLiveAt = now;
      this.options.publish();
      return;
    }

    this.liveDirty = true;
    if (this.liveTimer) return;
    this.liveTimer = setTimeout(() => {
      this.liveTimer = undefined;
      if (this.disposed || !this.liveDirty) return;
      this.liveDirty = false;
      this.lastLiveAt = Date.now();
      this.options.publish();
    }, Math.max(1, remaining));
    this.liveTimer.unref?.();
  }
}
