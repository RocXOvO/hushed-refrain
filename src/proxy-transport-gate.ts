import { errorStatus, RunCancelled } from "./errors";
import type { RequestGovernor } from "./governor";

export const DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT = 8;
export const DEFAULT_PROXY_TRANSPORT_START_DELAY_MS = 50;
export const DEFAULT_PROXY_TRANSPORT_START_JITTER_MS = 0;

export interface ProxyTransportGateOptions {
  maxConcurrent?: number;
  minStartDelayMs?: number;
  startJitterMs?: number;
  adaptiveFailureThreshold?: number;
  adaptiveFailureWindowMs?: number;
  adaptiveRecoverySuccesses?: number;
  adaptiveRecoveryIntervalMs?: number;
  minimumAdaptiveConcurrent?: number;
}

export interface ProxyTransportGateRuntime {
  now: () => number;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

interface CapacityWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

const defaultRuntime: ProxyTransportGateRuntime = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/**
 * Task-wide first-hop protection shared by every proxy lane.
 *
 * Per-lane governors control each exit's start rate. This gate independently
 * caps the aggregate number of proxy requests and smooths their start times as
 * observed by the upstream proxy provider.
 */
export class ProxyTransportGate {
  private active = 0;
  private cancelled = false;
  private lastStartedAt = 0;
  private readonly waiters: CapacityWaiter[] = [];
  private readonly sleepWaiters = new Set<() => void>();
  private startTail: Promise<void> = Promise.resolve();
  private readonly maxConcurrent: number;
  private readonly minStartDelayMs: number;
  private readonly startJitterMs: number;
  private readonly adaptiveFailureThreshold: number;
  private readonly adaptiveFailureWindowMs: number;
  private readonly adaptiveRecoverySuccesses: number;
  private readonly adaptiveRecoveryIntervalMs: number;
  private readonly minimumAdaptiveConcurrent: number;
  private effectiveMaxConcurrent: number;
  private transientFailureTimes: number[] = [];
  private successesSinceAdjustment = 0;
  private lastAdjustmentAt = 0;

  constructor(
    options: ProxyTransportGateOptions = {},
    private readonly runtime: ProxyTransportGateRuntime = defaultRuntime,
  ) {
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT;
    this.minStartDelayMs = options.minStartDelayMs ?? DEFAULT_PROXY_TRANSPORT_START_DELAY_MS;
    this.startJitterMs = options.startJitterMs ?? DEFAULT_PROXY_TRANSPORT_START_JITTER_MS;
    this.adaptiveFailureThreshold = options.adaptiveFailureThreshold ?? 3;
    this.adaptiveFailureWindowMs = options.adaptiveFailureWindowMs ?? 10_000;
    this.adaptiveRecoverySuccesses = options.adaptiveRecoverySuccesses ?? 20;
    this.adaptiveRecoveryIntervalMs = options.adaptiveRecoveryIntervalMs ?? 5_000;
    this.minimumAdaptiveConcurrent = options.minimumAdaptiveConcurrent ?? Math.min(4, this.maxConcurrent);
    this.effectiveMaxConcurrent = this.maxConcurrent;
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent <= 0) {
      throw new Error("maxConcurrent must be a positive integer.");
    }
    if (!Number.isInteger(this.minStartDelayMs) || this.minStartDelayMs < 0) {
      throw new Error("minStartDelayMs must be a non-negative integer.");
    }
    if (!Number.isInteger(this.startJitterMs) || this.startJitterMs < 0) {
      throw new Error("startJitterMs must be a non-negative integer.");
    }
    if (!Number.isInteger(this.adaptiveFailureThreshold) || this.adaptiveFailureThreshold <= 0) {
      throw new Error("adaptiveFailureThreshold must be a positive integer.");
    }
    if (!Number.isInteger(this.adaptiveFailureWindowMs) || this.adaptiveFailureWindowMs <= 0) {
      throw new Error("adaptiveFailureWindowMs must be a positive integer.");
    }
    if (!Number.isInteger(this.adaptiveRecoverySuccesses) || this.adaptiveRecoverySuccesses <= 0) {
      throw new Error("adaptiveRecoverySuccesses must be a positive integer.");
    }
    if (!Number.isInteger(this.adaptiveRecoveryIntervalMs) || this.adaptiveRecoveryIntervalMs < 0) {
      throw new Error("adaptiveRecoveryIntervalMs must be a non-negative integer.");
    }
    if (
      !Number.isInteger(this.minimumAdaptiveConcurrent) ||
      this.minimumAdaptiveConcurrent <= 0 ||
      this.minimumAdaptiveConcurrent > this.maxConcurrent
    ) {
      throw new Error("minimumAdaptiveConcurrent must be within the configured concurrency range.");
    }
  }

  get currentMaxConcurrent(): number {
    return this.effectiveMaxConcurrent;
  }

  get currentMinStartDelayMs(): number {
    return Math.ceil(this.minStartDelayMs * this.maxConcurrent / this.effectiveMaxConcurrent);
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new RunCancelled());
    for (const wake of [...this.sleepWaiters]) wake();
    this.sleepWaiters.clear();
  }

  async run<T>(request: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      await this.reserveStart();
      this.throwIfCancelled();
      const value = await request();
      this.recordSuccess();
      return value;
    } catch (error) {
      this.recordFailure(error);
      throw error;
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    this.throwIfCancelled();
    if (this.active < this.effectiveMaxConcurrent && this.waiters.length === 0) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    if (this.cancelled) return;
    this.drainCapacity();
  }

  private async reserveStart(): Promise<void> {
    let release = (): void => {};
    const previous = this.startTail;
    this.startTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.throwIfCancelled();
      if (this.lastStartedAt !== 0) {
        const sample = this.runtime.random();
        const random = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0;
        const jitterMs = Math.min(
          this.startJitterMs,
          Math.floor(random * (this.startJitterMs + 1)),
        );
        const waitMs = this.lastStartedAt + this.currentMinStartDelayMs + jitterMs - this.runtime.now();
        if (waitMs > 0) await this.cancellableSleep(waitMs);
      }
      this.throwIfCancelled();
      this.lastStartedAt = this.runtime.now();
    } finally {
      release();
    }
  }

  private throwIfCancelled(): void {
    if (this.cancelled) throw new RunCancelled();
  }

  private recordFailure(error: unknown): void {
    if (!isTransientTransportFailure(error)) return;
    const now = this.runtime.now();
    const cutoff = now - this.adaptiveFailureWindowMs;
    this.transientFailureTimes = this.transientFailureTimes.filter((at) => at > cutoff);
    this.transientFailureTimes.push(now);
    this.successesSinceAdjustment = 0;
    if (
      this.transientFailureTimes.length < this.adaptiveFailureThreshold ||
      this.effectiveMaxConcurrent <= this.minimumAdaptiveConcurrent
    ) return;
    this.effectiveMaxConcurrent = Math.max(
      this.minimumAdaptiveConcurrent,
      Math.floor(this.effectiveMaxConcurrent / 2),
    );
    this.transientFailureTimes = [];
    this.lastAdjustmentAt = now;
  }

  private recordSuccess(): void {
    if (this.effectiveMaxConcurrent >= this.maxConcurrent) {
      this.successesSinceAdjustment = 0;
      return;
    }
    this.successesSinceAdjustment += 1;
    const now = this.runtime.now();
    if (
      this.successesSinceAdjustment < this.adaptiveRecoverySuccesses ||
      now - this.lastAdjustmentAt < this.adaptiveRecoveryIntervalMs
    ) return;
    this.effectiveMaxConcurrent = Math.min(this.maxConcurrent, this.effectiveMaxConcurrent + 1);
    this.successesSinceAdjustment = 0;
    this.lastAdjustmentAt = now;
    this.transientFailureTimes = [];
    this.drainCapacity();
  }

  private drainCapacity(): void {
    while (!this.cancelled && this.active < this.effectiveMaxConcurrent) {
      const next = this.waiters.shift();
      if (!next) return;
      this.active += 1;
      next.resolve();
    }
  }

  private async cancellableSleep(milliseconds: number): Promise<void> {
    let wake = (): void => {};
    const cancelled = new Promise<void>((resolve) => {
      wake = resolve;
      this.sleepWaiters.add(wake);
    });
    try {
      await Promise.race([this.runtime.sleep(milliseconds), cancelled]);
    } finally {
      this.sleepWaiters.delete(wake);
    }
  }
}

function isTransientTransportFailure(error: unknown): boolean {
  if (error instanceof RunCancelled) return false;
  const status = errorStatus(error);
  return status === undefined || status === 408 || status === 425 || (status >= 500 && status <= 599);
}

export interface ProxyTransportLane {
  governor: RequestGovernor;
  transportGate?: ProxyTransportGate;
}

export function executeProxyRequest<T>(
  lane: ProxyTransportLane,
  label: string,
  request: () => Promise<T>,
): Promise<T> {
  return lane.governor.execute(label, () =>
    lane.transportGate ? lane.transportGate.run(request) : request()
  );
}

export function executeBestEffortProxyRequest<T>(
  lane: ProxyTransportLane,
  label: string,
  request: () => Promise<T>,
): Promise<T> {
  return lane.governor.executeBestEffort(label, () =>
    lane.transportGate ? lane.transportGate.run(request) : request()
  );
}
