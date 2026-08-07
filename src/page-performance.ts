import type { ScanRequestActivity } from "./types";

export interface PagePerformanceSnapshot {
  pageRequestSamples: number;
  pageRequestAttempts: number;
  successfulPageRequests: number;
  failedPageRequests: number;
  averagePageRequestMs?: number;
  averageCommentsPerPage?: number;
  pageRequestSuccessRatio?: number;
}

/** Accumulates real comment-page cost so estimates can calibrate to the active task. */
export class PagePerformanceTracker {
  private successes = 0;
  private failures = 0;
  private attempts = 0;
  private networkElapsedMs = 0;
  private comments = 0;

  reset(): void {
    this.successes = 0;
    this.failures = 0;
    this.attempts = 0;
    this.networkElapsedMs = 0;
    this.comments = 0;
  }

  record(activity: ScanRequestActivity): void {
    if (activity.phase === "start") return;
    if (activity.attempts !== undefined && (!Number.isInteger(activity.attempts) || activity.attempts <= 0)) return;
    const attempts = Number.isInteger(activity.attempts) && Number(activity.attempts) > 0
      ? Number(activity.attempts)
      : 1;
    this.attempts += attempts;
    const networkElapsedMs = Number(activity.networkElapsedMs ?? activity.elapsedMs);
    if (Number.isFinite(networkElapsedMs) && networkElapsedMs >= 0) this.networkElapsedMs += networkElapsedMs;
    if (activity.phase === "success") {
      this.successes += 1;
      const comments = Number(activity.effectiveComments ?? activity.comments);
      if (Number.isFinite(comments) && comments >= 0) this.comments += Math.floor(comments);
    } else {
      this.failures += 1;
    }
  }

  snapshot(): PagePerformanceSnapshot {
    const samples = this.successes + this.failures;
    return {
      pageRequestSamples: samples,
      pageRequestAttempts: this.attempts,
      successfulPageRequests: this.successes,
      failedPageRequests: this.failures,
      ...(this.attempts > 0 ? {
        averagePageRequestMs: Math.round(this.networkElapsedMs / this.attempts),
        pageRequestSuccessRatio: Number((this.successes / this.attempts).toFixed(4)),
      } : {}),
      ...(this.successes > 0 ? {
        averageCommentsPerPage: Number((this.comments / this.successes).toFixed(2)),
      } : {}),
    };
  }
}
