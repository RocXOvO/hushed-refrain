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
    estimatedRequests: 1_000,
    partitions: 1,
    commentsPerPage: 100,
    requestSuccessRatio: 1,
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

test("uses the configured host concurrency and randomized start interval", () => {
  const estimate = estimateCommentScan({
    comments: 100_000,
    pageSize: 1_000,
    minDelayMs: 0,
    jitterMs: 0,
    networkMs: 400,
    lanes: 8,
    workersPerLane: 2,
    proxyTransport: true,
    proxyTransportMaxConcurrent: 4,
    proxyTransportStartDelayMs: 80,
    proxyTransportStartJitterMs: 120,
  });

  assert.equal(estimate.effectiveWorkers, 4);
  assert.equal(estimate.proxyTransportMaxConcurrent, 4);
  assert.equal(estimate.proxyTransportEffectiveStartDelayMs, 80);
  assert.equal(estimate.proxyTransportStartJitterMs, 120);
  assert.equal(estimate.optimisticSeconds, 10);
  assert.equal(estimate.expectedSeconds, 14);
  assert.equal(estimate.conservativeSeconds, 20);
});

test("accounts for independent song pagination instead of dividing only the aggregate total", () => {
  const estimate = estimateCommentScan({
    comments: 60_000,
    pageSize: 1_000,
    partitions: 100,
    minDelayMs: 2_500,
    jitterMs: 0,
    networkMs: 500,
  });

  assert.equal(estimate.pages, 100);
  assert.equal(estimate.estimatedRequests, 100);
  assert.equal(estimate.expectedSeconds, 250);
});

test("calibrates page fill, terminal failures, and adaptive transport capacity", () => {
  const estimate = estimateCommentScan({
    comments: 60_000,
    pageSize: 1_000,
    partitions: 100,
    observedCommentsPerPage: 600,
    requestSuccessRatio: 0.8,
    minDelayMs: 0,
    jitterMs: 0,
    networkMs: 550,
    lanes: 8,
    workersPerLane: 2,
    maxWorkers: 8,
    proxyTransport: true,
    proxyTransportMaxConcurrent: 8,
    proxyTransportEffectiveConcurrent: 4,
    proxyTransportStartDelayMs: 80,
    proxyTransportStartJitterMs: 40,
  });

  assert.equal(estimate.pages, 100);
  assert.equal(estimate.estimatedRequests, 125);
  assert.equal(estimate.effectiveWorkers, 4);
  assert.equal(estimate.proxyTransportEffectiveConcurrent, 4);
  assert.equal(estimate.proxyTransportEffectiveStartDelayMs, 160);
  assert.equal(estimate.expectedSeconds, 23);
});

test("keeps page estimates stable at a partition boundary", () => {
  const estimate = estimateCommentScan({
    comments: 100_001,
    pageSize: 1_000,
    partitions: 100,
    minDelayMs: 0,
    jitterMs: 0,
  });
  assert.equal(estimate.pages, 101);
});

test("includes one discovery page for every explicit empty partition", () => {
  const estimate = estimateCommentScan({
    comments: 0,
    pageSize: 1_000,
    partitions: 100,
    minDelayMs: 0,
    jitterMs: 0,
  });
  assert.equal(estimate.pages, 100);
});

test("rejects an effective transport capacity above the configured host limit", () => {
  assert.throws(() => estimateCommentScan({
    comments: 1_000,
    pageSize: 1_000,
    minDelayMs: 0,
    jitterMs: 0,
    proxyTransport: true,
    proxyTransportMaxConcurrent: 4,
    proxyTransportEffectiveConcurrent: 8,
  }), /must not exceed/);
});
