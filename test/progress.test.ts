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
