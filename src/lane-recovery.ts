export interface LaneRecoveryRuntime {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

const defaultRuntime: LaneRecoveryRuntime = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/** Keeps transient network failures from permanently shrinking a long scan. */
export class LaneRecovery {
  private consecutiveFailures = 0;
  private retryAt = 0;

  constructor(
    private readonly baseDelayMs = 1_000,
    private readonly maximumDelayMs = 30_000,
    private readonly runtime: LaneRecoveryRuntime = defaultRuntime,
  ) {
    if (!Number.isInteger(baseDelayMs) || baseDelayMs < 0) throw new Error("baseDelayMs must be non-negative.");
    if (!Number.isInteger(maximumDelayMs) || maximumDelayMs < baseDelayMs) throw new Error("maximumDelayMs must not be smaller than baseDelayMs.");
  }

  recordFailure(): number {
    this.consecutiveFailures += 1;
    const delay = Math.min(
      this.maximumDelayMs,
      this.baseDelayMs * 2 ** Math.min(20, this.consecutiveFailures - 1),
    );
    this.retryAt = Math.max(this.retryAt, this.runtime.now() + delay);
    return delay;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.retryAt = 0;
  }

  async waitUntilReady(): Promise<void> {
    const waitMs = this.retryAt - this.runtime.now();
    if (waitMs > 0) await this.runtime.sleep(waitMs);
  }
}
