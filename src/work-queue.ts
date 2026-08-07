export class AsyncWorkQueue<T> {
  private items: T[];
  private head = 0;
  private readonly waiters: Array<(item: T | undefined) => void> = [];
  private inFlight = 0;
  private closed = false;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;

  constructor(initialItems: Iterable<T>) {
    this.items = [...initialItems];
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  take(): Promise<T | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    const item = this.dequeue();
    if (item !== undefined) {
      this.inFlight += 1;
      return Promise.resolve(item);
    }
    if (this.inFlight === 0) {
      this.close();
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

  isClosed(): boolean {
    return this.closed;
  }

  whenClosed(): Promise<void> {
    return this.closedPromise;
  }

  stop(): void {
    if (this.closed) return;
    this.close();
    this.items.length = 0;
    this.head = 0;
    this.resolveWaiters();
  }

  private dispatch(): void {
    while (!this.closed && this.queuedCount() > 0 && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      const item = this.dequeue()!;
      this.inFlight += 1;
      waiter(item);
    }
    if (!this.closed && this.queuedCount() === 0 && this.inFlight === 0) {
      this.close();
      this.resolveWaiters();
    }
  }

  private dequeue(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head];
    this.head += 1;
    if (this.head >= 1_024 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }

  private queuedCount(): number {
    return this.items.length - this.head;
  }

  private resolveWaiters(): void {
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveClosed();
  }
}
