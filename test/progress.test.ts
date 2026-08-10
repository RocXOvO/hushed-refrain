import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeCommentTotal, timeCoveragePercent } from "../src/progress";

test("keeps the largest credible comment total", () => {
  assert.equal(mergeCommentTotal(undefined, 100, 20), 100);
  assert.equal(mergeCommentTotal(100, 0, 40), 100);
  assert.equal(mergeCommentTotal(100, undefined, 120), 120);
});

test("parallel time coverage does not regress when an unfinished shard is split", () => {
  const before = timeCoveragePercent(0, 100, [
    { startTime: 0, endTime: 100, cursor: "60", done: false },
  ]);
  const after = timeCoveragePercent(0, 100, [
    { startTime: 30, endTime: 60, cursor: "60", done: false },
    { startTime: 0, endTime: 30, cursor: "30", done: false },
  ]);
  assert.equal(before, 40);
  assert.equal(after, 40);
});

test("completed shards contribute no remaining time", () => {
  assert.equal(timeCoveragePercent(0, 100, [
    { startTime: 0, endTime: 50, cursor: "50", done: true },
    { startTime: 50, endTime: 100, cursor: "75", done: false },
  ]), 75);
});

test("keeps sub-percent time coverage instead of hiding it behind integer jumps", () => {
  assert.equal(timeCoveragePercent(0, 10_000, [
    { startTime: 0, endTime: 10_000, cursor: "9985", done: false },
  ]), 0.15);
});

test("intersects legacy global shards with a trusted display-time lower bound", () => {
  assert.equal(timeCoveragePercent(6_000, 10_000, [
    { startTime: 0, endTime: 10_000, cursor: "8000", done: false },
  ]), 50);
});

test("does not show full time coverage before the final page proves completion", () => {
  assert.equal(timeCoveragePercent(50, 100, [
    { startTime: 0, endTime: 100, cursor: "40", done: false },
  ]), 99.99);
  assert.equal(timeCoveragePercent(50, 100, [
    { startTime: 0, endTime: 100, cursor: "40", done: true },
  ]), 100);
});
