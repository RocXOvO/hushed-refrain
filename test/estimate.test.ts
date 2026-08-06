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
    lanes: 1,
    workersPerLane: 1,
    totalWorkers: 1,
  });
});

test("scales throughput across independent proxy lanes", () => {
  const estimate = estimateCommentScan({
    comments: 100_000,
    pageSize: 100,
    minDelayMs: 2_500,
    jitterMs: 800,
    networkMs: 400,
    lanes: 4,
    workersPerLane: 1,
  });

  assert.equal(estimate.expectedSeconds, 725);
  assert.equal(estimate.expectedCommentsPerSecond, 137.93);
  assert.equal(estimate.totalWorkers, 4);
});

test("accounts for worker concurrency when network latency exceeds spacing", () => {
  const estimate = estimateCommentScan({
    comments: 100_000,
    pageSize: 100,
    minDelayMs: 0,
    jitterMs: 0,
    networkMs: 800,
    lanes: 4,
    workersPerLane: 2,
  });

  assert.equal(estimate.expectedSeconds, 100);
  assert.equal(estimate.expectedCommentsPerSecond, 1_000);
});

test("scales delay-bound throughput across workers on one lane", () => {
  const singleWorker = estimateCommentScan({
    comments: 100_000,
    pageSize: 100,
    minDelayMs: 2_500,
    jitterMs: 800,
    networkMs: 400,
    lanes: 1,
    workersPerLane: 1,
  });
  const fourWorkers = estimateCommentScan({
    comments: 100_000,
    pageSize: 100,
    minDelayMs: 2_500,
    jitterMs: 800,
    networkMs: 400,
    lanes: 1,
    workersPerLane: 4,
  });

  assert.equal(singleWorker.expectedSeconds, 2_900);
  assert.equal(fourWorkers.expectedSeconds, 725);
  assert.equal(fourWorkers.expectedCommentsPerSecond, 137.93);
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
