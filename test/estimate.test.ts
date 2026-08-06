import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateCommentScan } from "../src/estimate";

test("estimates a 100k comment scan at the configured serial rate", () => {
  const estimate = estimateCommentScan({
    comments: 100_000,
    pageSize: 100,
    minDelayMs: 2_500,
    jitterMs: 800,
    networkMs: 400,
  });

  assert.deepEqual(estimate, {
    comments: 100_000,
    pages: 1_000,
    optimisticSeconds: 2_500,
    expectedSeconds: 2_900,
    conservativeSeconds: 3_300,
    expectedCommentsPerSecond: 34.48,
  });
});

test("network latency becomes the lower bound when delay is zero", () => {
  const estimate = estimateCommentScan({
    comments: 1_000,
    pageSize: 100,
    minDelayMs: 0,
    jitterMs: 0,
    networkMs: 500,
  });
  assert.equal(estimate.pages, 10);
  assert.equal(estimate.expectedSeconds, 5);
});

test("rejects an invalid page size", () => {
  assert.throws(() => estimateCommentScan({
    comments: 10,
    pageSize: 0,
    minDelayMs: 0,
    jitterMs: 0,
  }), /pageSize/);
});
