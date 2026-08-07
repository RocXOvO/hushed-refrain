import { RunCancelled } from "./errors";
import type { RequestGovernor } from "./governor";

export const DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT = 8;
export const DEFAULT_PROXY_TRANSPORT_START_DELAY_MS = 80;
export const DEFAULT_PROXY_TRANSPORT_START_JITTER_MS = 40;

export interface ProxyTransportGateOptions {
  maxConcurrent?: number;
  minStartDelayMs?: number;
  startJitterMs?: number;
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

  constructor(
    options: ProxyTransportGateOptions = {},
    private readonly runtime: ProxyTransportGateRuntime = defaultRuntime,
  ) {
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT;
    this.minStartDelayMs = options.minStartDelayMs ?? DEFAULT_PROXY_TRANSPORT_START_DELAY_MS;
    this.startJitterMs = options.startJitterMs ?? DEFAULT_PROXY_TRANSPORT_START_JITTER_MS;
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent <= 0) {
      throw new Error("maxConcurrent must be a positive integer.");
    }
    if (!Number.isInteger(this.minStartDelayMs) || this.minStartDelayMs < 0) {
      throw new Error("minStartDelayMs must be a non-negative integer.");
    }
    if (!Number.isInteger(this.startJitterMs) || this.startJitterMs < 0) {
      throw new Error("startJitterMs must be a non-negative integer.");
    }
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
      return await request();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    this.throwIfCancelled();
    if (this.active < this.maxConcurrent && this.waiters.length === 0) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    if (this.cancelled) return;
    const next = this.waiters.shift();
    if (!next) return;
    this.active += 1;
    next.resolve();
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
        const waitMs = this.lastStartedAt + this.minStartDelayMs + jitterMs - this.runtime.now();
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
