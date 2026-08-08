import { RunCancelled } from "./errors";

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
  private cancelled = false;
  private readonly wakeWaiters = new Set<() => void>();

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

  get failureCount(): number {
    return this.consecutiveFailures;
  }

  get ready(): boolean {
    return !this.cancelled && this.retryAt <= this.runtime.now();
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.retryAt = 0;
    for (const wake of [...this.wakeWaiters]) wake();
    this.wakeWaiters.clear();
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const wake of [...this.wakeWaiters]) wake();
    this.wakeWaiters.clear();
  }

  async waitUntilReady(signal?: AbortSignal): Promise<void> {
    if (this.cancelled) return;
    if (signal?.aborted) throw new RunCancelled();
    const waitMs = this.retryAt - this.runtime.now();
    if (waitMs <= 0) return;
    let wake = (): void => {};
    let rejectAbort = (_error: unknown): void => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const awakened = new Promise<void>((resolve) => {
      wake = resolve;
      this.wakeWaiters.add(wake);
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const sleeping = this.runtime === defaultRuntime
      ? new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })
      : this.runtime.sleep(waitMs);
    try {
      await Promise.race([sleeping, awakened, aborted]);
    } finally {
      if (timer) clearTimeout(timer);
      this.wakeWaiters.delete(wake);
      signal?.removeEventListener("abort", onAbort);
    }

    function onAbort(): void {
      rejectAbort(new RunCancelled());
    }
  }
}
