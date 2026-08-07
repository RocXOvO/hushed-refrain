import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readTaskLog, TaskLogger } from "../src/task-log";

test("persists structured page success and rate-limit diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-task-log-"));
  const logger = new TaskLogger(join(directory, "logs", "run.jsonl"), "parallel", "run-1");
  await logger.write("info", "task_started", "started");
  logger.request({
    phase: "success",
    lane: "proxy-1",
    operation: "comment-page",
    songId: "186016",
    page: 2,
    shardId: 3,
    elapsedMs: 420,
    comments: 1000,
    hasMore: true,
  });
  logger.request({
    phase: "failure",
    lane: "proxy-2",
    operation: "comment-page",
    songId: "186016",
    page: 3,
    shardId: 7,
    elapsedMs: 180,
    status: 429,
    rateLimited: true,
    error: "cooldown",
  });
  logger.scheduler({
    type: "adaptive-split",
    originalShardId: 3,
    newShardId: 8,
    splitAt: 100,
    remainingStart: 0,
    remainingEnd: 200,
    waitingWorkers: 2,
  });
  await logger.write("info", "task_finished", "finished");

  const entries = await readTaskLog(logger.path, 20);
  assert.deepEqual(entries.map((entry) => entry.event), [
    "task_finished",
    "adaptive_split",
    "rate_limited",
    "page_success",
    "task_started",
  ]);
  assert.equal(entries[1].details?.waitingWorkers, 2);
  assert.equal(entries[2].level, "warn");
  assert.equal(entries[2].details?.status, 429);
  assert.equal(entries[3].details?.comments, 1000);
});
