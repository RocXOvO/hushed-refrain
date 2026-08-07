export type CoordinatedTaskMode = "source" | "parallel" | "pool";

export interface TaskLease {
  mode: CoordinatedTaskMode;
  release(): void;
}

export class TaskCoordinator {
  private active?: { mode: CoordinatedTaskMode; token: symbol };

  acquire(mode: CoordinatedTaskMode): TaskLease | undefined {
    if (this.active) return undefined;
    const token = Symbol(mode);
    this.active = { mode, token };
    let released = false;
    return {
      mode,
      release: () => {
        if (released) return;
        released = true;
        if (this.active?.token === token) this.active = undefined;
      },
    };
  }

  isBusy(): boolean {
    return this.active !== undefined;
  }

  activeMode(): CoordinatedTaskMode | undefined {
    return this.active?.mode;
  }
}

export function taskElapsedMs(startedAt: string | undefined, finishedAt: string | undefined, now = Date.now()): number {
  if (!startedAt) return 0;
  const start = Date.parse(startedAt);
  const finish = finishedAt ? Date.parse(finishedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return 0;
  return Math.max(0, finish - start);
}
