import { RunCancelled } from "../errors";

export const DEFAULT_QQ_TRANSPORT_MAX_CONCURRENT = 4;
export const DEFAULT_QQ_TRANSPORT_START_DELAY_MS = 50;
export const MAX_QQ_TRANSPORT_CONCURRENT = 32;
export const MIN_QQ_TRANSPORT_START_DELAY_MS = 50;

export interface QQMusicTransportProfile {
  maxConcurrent: number;
  minStartDelayMs: number;
  checkpointSlots: number;
}

/** Scale the aggregate guard with independently paced proxy exits. */
export function qqMusicTransportProfile(
  mode: "song" | "likes",
  laneCount: number,
  taskWorkerCapacity: number,
): QQMusicTransportProfile {
  positiveInteger(laneCount, "QQ laneCount");
  const workerCap = positiveInteger(taskWorkerCapacity, "QQ taskWorkerCapacity");
  if (mode === "song") {
    return {
      maxConcurrent: 1,
      minStartDelayMs: DEFAULT_QQ_TRANSPORT_START_DELAY_MS,
      checkpointSlots: 1,
    };
  }
  const maxConcurrent = Math.min(workerCap, MAX_QQ_TRANSPORT_CONCURRENT);
  return {
    maxConcurrent,
    minStartDelayMs: MIN_QQ_TRANSPORT_START_DELAY_MS,
    checkpointSlots: maxConcurrent,
  };
}

export interface QQMusicTransportGateOptions {
  maxConcurrent?: number;
  minStartDelayMs?: number;
}

export interface QQMusicTransportGateRuntime {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

interface CapacityWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

const defaultRuntime: QQMusicTransportGateRuntime = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/** Task-wide QQ first-hop protection shared by every direct or proxy lane. */
export class QQMusicTransportGate {
  private active = 0;
  private cancelled = false;
  private readonly cancellation = new AbortController();
  private lastStartedAt = 0;
  private readonly waiters: CapacityWaiter[] = [];
  private readonly waitCancellation = new Set<(error: unknown) => void>();
  private startTail: Promise<void> = Promise.resolve();
  private readonly maxConcurrent: number;
  private readonly minStartDelayMs: number;

  constructor(
    options: QQMusicTransportGateOptions = {},
    private readonly runtime: QQMusicTransportGateRuntime = defaultRuntime,
  ) {
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_QQ_TRANSPORT_MAX_CONCURRENT;
    this.minStartDelayMs = options.minStartDelayMs ?? DEFAULT_QQ_TRANSPORT_START_DELAY_MS;
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent <= 0) {
      throw new Error("QQ transport maxConcurrent must be a positive integer.");
    }
    if (!Number.isInteger(this.minStartDelayMs) || this.minStartDelayMs < 0) {
      throw new Error("QQ transport minStartDelayMs must be a non-negative integer.");
    }
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  get signal(): AbortSignal {
    return this.cancellation.signal;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.cancellation.abort();
    const error = new RunCancelled();
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    for (const reject of [...this.waitCancellation]) reject(error);
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
    this.startTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      this.throwIfCancelled();
      if (this.lastStartedAt !== 0) {
        const waitMs = this.lastStartedAt + this.minStartDelayMs - this.runtime.now();
        if (waitMs > 0) await this.sleepOrStop(waitMs);
      }
      this.throwIfCancelled();
      this.lastStartedAt = this.runtime.now();
    } finally {
      release();
    }
  }

  private async sleepOrStop(milliseconds: number): Promise<void> {
    this.throwIfCancelled();
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

  private throwIfCancelled(): void {
    if (this.cancelled) throw new RunCancelled();
  }
}

export function cancelQQMusicLanes(
  lanes: ReadonlyArray<{
    governor: { cancel(): void };
    transportGate: { cancel(): void };
    client?: { close?(): void };
  }>,
): void {
  const gates = new Set(lanes.map((lane) => lane.transportGate));
  for (const lane of lanes) lane.governor.cancel();
  for (const gate of gates) gate.cancel();
  for (const lane of lanes) lane.client?.close?.();
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}
