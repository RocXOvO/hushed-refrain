import assert from "node:assert/strict";
import { test } from "node:test";
import { PagePerformanceTracker } from "../src/page-performance";
import type { ScanRequestActivity } from "../src/types";

function activity(
  phase: ScanRequestActivity["phase"],
  elapsedMs?: number,
  comments?: number,
  extra: Partial<ScanRequestActivity> = {},
): ScanRequestActivity {
  return {
    phase,
    operation: "comment-page",
    lane: "proxy-1",
    songId: "1",
    page: 1,
    elapsedMs,
    comments,
    ...extra,
  };
}

test("summarizes real page latency, fill, and final request success ratio", () => {
  const tracker = new PagePerformanceTracker();
  tracker.record(activity("start"));
  tracker.record(activity("success", 400, 1_000));
  tracker.record(activity("success", 600, 200));
  tracker.record(activity("failure", 500));

  assert.deepEqual(tracker.snapshot(), {
    pageRequestSamples: 3,
    pageRequestAttempts: 3,
    successfulPageRequests: 2,
    failedPageRequests: 1,
    averagePageRequestMs: 500,
    pageRequestSuccessRatio: 0.6667,
    averageCommentsPerPage: 600,
  });
});

test("reset discards telemetry from the previous task", () => {
  const tracker = new PagePerformanceTracker();
  tracker.record(activity("success", 400, 1_000));
  tracker.reset();
  assert.deepEqual(tracker.snapshot(), {
    pageRequestSamples: 0,
    pageRequestAttempts: 0,
    successfulPageRequests: 0,
    failedPageRequests: 0,
  });
});

test("uses only network time and counts every remote retry attempt", () => {
  const tracker = new PagePerformanceTracker();
  tracker.record(activity("success", 2_400, 1_000, {
    attempts: 2,
    networkElapsedMs: 400,
    effectiveComments: 600,
  }));

  assert.deepEqual(tracker.snapshot(), {
    pageRequestSamples: 1,
    pageRequestAttempts: 2,
    successfulPageRequests: 1,
    failedPageRequests: 0,
    averagePageRequestMs: 200,
    pageRequestSuccessRatio: 0.5,
    averageCommentsPerPage: 600,
  });
});
