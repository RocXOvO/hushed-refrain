import {
  AuthenticationRequired,
  CooldownRequired,
  RequestBudgetExhausted,
  RunCancelled,
  errorStatus,
} from "./errors";

export interface GovernorOptions {
  minDelayMs: number;
  jitterMs: number;
  concurrency?: number;
  maxRetries: number;
  forbiddenCooldownMs: number;
  requestBudget: number;
  retryBaseMs?: number;
  retryCapMs?: number;
}

interface GovernorRuntime {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
}

const defaultRuntime: GovernorRuntime = {
  now: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  random: () => Math.random(),
};

export class RequestGovernor {
  private lastRequestAt = 0;
  private used = 0;
  private terminalError?: RunCancelled | CooldownRequired;
  private readonly waitCancellation = new Set<(error: unknown) => void>();
  private slotTail: Promise<void> = Promise.resolve();
  private readonly concurrency: number;

  constructor(
    private readonly options: GovernorOptions,
    private readonly runtime: GovernorRuntime = defaultRuntime,
  ) {
    const concurrency = options.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency <= 0) {
      throw new Error("concurrency must be a positive integer.");
    }
    this.concurrency = concurrency;
  }

  get requestsUsed(): number {
    return this.used;
  }

  cancel(): void {
    const error = new RunCancelled();
    this.terminalError = error;
    this.wakeWaiters(error);
  }

  async execute<T>(label: string, request: () => Promise<T>): Promise<T> {
    let retry = 0;
    while (true) {
      this.throwIfUnavailable();
      await this.reserveSlot();

      try {
        return await request();
      } catch (error) {
        if (error instanceof RunCancelled) throw error;
        if (error instanceof AuthenticationRequired) throw error;
        const status = errorStatus(error);
        if (status === 301) throw new AuthenticationRequired();
        if (status === 403 || status === 429) {
          const cooldown = new CooldownRequired(status, this.options.forbiddenCooldownMs);
          this.terminalError = cooldown;
          this.wakeWaiters(cooldown);
          throw cooldown;
        }

        if (!isRetryable(status) || retry >= this.options.maxRetries) {
          const detail = error instanceof Error ? error.message : JSON.stringify(error);
          throw new Error(`${label} failed${status ? ` (${status})` : ""}: ${detail}`);
        }

        const base = this.options.retryBaseMs ?? 2_000;
        const cap = this.options.retryCapMs ?? 30_000;
        const backoff = Math.min(cap, base * 2 ** retry);
        const jitter = Math.floor(this.runtime.random() * this.options.jitterMs);
        await this.sleepOrStop(backoff + jitter);
        this.throwIfUnavailable();
        retry += 1;
      }
    }
  }

  private async reserveSlot(): Promise<void> {
    let release = (): void => {};
    const previous = this.slotTail;
    this.slotTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.throwIfUnavailable();
      if (this.options.requestBudget > 0 && this.used >= this.options.requestBudget) {
        throw new RequestBudgetExhausted(this.options.requestBudget);
      }
      if (this.lastRequestAt !== 0) {
        const jitter = Math.floor(this.runtime.random() * this.options.jitterMs);
        const workerSpacingMs = Math.ceil((this.options.minDelayMs + jitter) / this.concurrency);
        const target = this.lastRequestAt + workerSpacingMs;
        const waitMs = target - this.runtime.now();
        if (waitMs > 0) await this.sleepOrStop(waitMs);
      }
      this.throwIfUnavailable();
      this.used += 1;
      this.lastRequestAt = this.runtime.now();
    } finally {
      release();
    }
  }

  private async sleepOrStop(milliseconds: number): Promise<void> {
    this.throwIfUnavailable();
    if (milliseconds <= 0) return;
    let rejectCancellation = (_error: unknown): void => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
      this.waitCancellation.add(rejectCancellation);
    });
    try {
      await Promise.race([this.runtime.sleep(milliseconds), cancelled]);
    } finally {
      this.waitCancellation.delete(rejectCancellation);
    }
  }

  private wakeWaiters(error: unknown): void {
    for (const reject of [...this.waitCancellation]) reject(error);
  }

  private throwIfUnavailable(): void {
    if (this.terminalError) throw this.terminalError;
  }
}

function isRetryable(status: number | undefined): boolean {
  return status === undefined || status === 408 || status === 425 || (status >= 500 && status <= 599);
}
