export class AsyncWorkQueue<T> {
  private readonly items: T[];
  private readonly waiters: Array<(item: T | undefined) => void> = [];
  private inFlight = 0;
  private closed = false;

  constructor(initialItems: Iterable<T>) {
    this.items = [...initialItems];
  }

  take(): Promise<T | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    const item = this.items.shift();
    if (item !== undefined) {
      this.inFlight += 1;
      return Promise.resolve(item);
    }
    if (this.inFlight === 0) {
      this.closed = true;
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  complete(requeue?: T | readonly T[]): void {
    if (this.inFlight <= 0) throw new Error("Cannot complete work that was not taken.");
    this.inFlight -= 1;
    if (!this.closed && requeue !== undefined) {
      if (Array.isArray(requeue)) this.items.push(...requeue);
      else this.items.push(requeue as T);
    }
    this.dispatch();
  }

  waitingCount(): number {
    return this.waiters.length;
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.items.length = 0;
    this.resolveWaiters();
  }

  private dispatch(): void {
    while (!this.closed && this.items.length > 0 && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      const item = this.items.shift()!;
      this.inFlight += 1;
      waiter(item);
    }
    if (!this.closed && this.items.length === 0 && this.inFlight === 0) {
      this.closed = true;
      this.resolveWaiters();
    }
  }

  private resolveWaiters(): void {
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }
}
