import { RunCancelled } from "./errors";
import type { RequestGovernor } from "./governor";

export const DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT = 8;
export const DEFAULT_PROXY_TRANSPORT_START_DELAY_MS = 80;

export interface ProxyTransportGateOptions {
  maxConcurrent?: number;
  minStartDelayMs?: number;
}

export interface ProxyTransportGateRuntime {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

interface CapacityWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

const defaultRuntime: ProxyTransportGateRuntime = {
  now: () => Date.now(),
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
  private startTail: Promise<void> = Promise.resolve();
  private readonly maxConcurrent: number;
  private readonly minStartDelayMs: number;

  constructor(
    options: ProxyTransportGateOptions = {},
    private readonly runtime: ProxyTransportGateRuntime = defaultRuntime,
  ) {
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_PROXY_TRANSPORT_MAX_CONCURRENT;
    this.minStartDelayMs = options.minStartDelayMs ?? DEFAULT_PROXY_TRANSPORT_START_DELAY_MS;
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent <= 0) {
      throw new Error("maxConcurrent must be a positive integer.");
    }
    if (!Number.isInteger(this.minStartDelayMs) || this.minStartDelayMs < 0) {
      throw new Error("minStartDelayMs must be a non-negative integer.");
    }
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new RunCancelled());
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
        const waitMs = this.lastStartedAt + this.minStartDelayMs - this.runtime.now();
        if (waitMs > 0) await this.runtime.sleep(waitMs);
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
