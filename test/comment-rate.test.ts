import assert from "node:assert/strict";
import { test } from "node:test";
import { CommentRateTracker } from "../src/comment-rate";

test("reports the rolling rate of comments actually returned", () => {
  const tracker = new CommentRateTracker(10_000);
  tracker.reset(1_000);
  tracker.record(1_000, 2_000);
  tracker.record(500, 3_000);

  assert.equal(tracker.rate(4_000), 500);
  assert.equal(tracker.rate(8_000), 214.3);
});

test("decays to zero after the rolling window has no successful comments", () => {
  const tracker = new CommentRateTracker(5_000);
  tracker.reset(1_000);
  tracker.record(250, 2_000);

  assert.equal(tracker.rate(6_999), 50);
  assert.equal(tracker.rate(7_000), 0);
});

test("reset prevents a new task from inheriting the previous task rate", () => {
  const tracker = new CommentRateTracker();
  tracker.reset(1_000);
  tracker.record(1_000, 2_000);
  tracker.reset(5_000);

  assert.equal(tracker.rate(6_000), 0);
});
