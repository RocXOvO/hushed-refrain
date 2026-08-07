interface CommentRateSample {
  at: number;
  comments: number;
}

/** Rolling rate of comments actually returned by successful page requests. */
export class CommentRateTracker {
  private readonly samples: CommentRateSample[] = [];
  private head = 0;
  private total = 0;
  private startedAt = 0;

  constructor(private readonly windowMs = 10_000) {
    if (!Number.isInteger(windowMs) || windowMs <= 0) {
      throw new Error("windowMs must be a positive integer.");
    }
    this.reset();
  }

  reset(at = Date.now()): void {
    this.samples.length = 0;
    this.head = 0;
    this.total = 0;
    this.startedAt = finiteTime(at);
  }

  record(comments: number, at = Date.now()): void {
    if (!Number.isFinite(comments) || comments <= 0) return;
    const sample = {
      at: Math.max(this.startedAt, finiteTime(at)),
      comments: Math.floor(comments),
    };
    this.samples.push(sample);
    this.total += sample.comments;
    this.prune(sample.at);
  }

  rate(at = Date.now()): number {
    const now = Math.max(this.startedAt, finiteTime(at));
    this.prune(now);
    if (this.total <= 0) return 0;
    const observedFrom = Math.max(this.startedAt, now - this.windowMs);
    const observedMs = Math.max(1_000, now - observedFrom);
    return Math.round((this.total * 1_000 / observedMs) * 10) / 10;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.head < this.samples.length && this.samples[this.head].at <= cutoff) {
      this.total -= this.samples[this.head].comments;
      this.head += 1;
    }
    if (this.head >= 128 && this.head * 2 >= this.samples.length) {
      this.samples.splice(0, this.head);
      this.head = 0;
    }
  }
}

function finiteTime(value: number): number {
  return Number.isFinite(value) ? value : Date.now();
}
