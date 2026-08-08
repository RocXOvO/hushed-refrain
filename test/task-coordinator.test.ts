import assert from "node:assert/strict";
import { test } from "node:test";
import { taskElapsedMs, TaskCoordinator } from "../src/task-coordinator";

test("allows only one scan task lease at a time and releases idempotently", () => {
  const coordinator = new TaskCoordinator();
  const source = coordinator.acquire("source");
  assert.ok(source);
  assert.equal(coordinator.isBusy(), true);
  assert.equal(coordinator.activeMode(), "source");
  assert.equal(coordinator.acquire("parallel"), undefined);

  source.release();
  source.release();
  const parallel = coordinator.acquire("parallel");
  assert.ok(parallel);
  assert.equal(coordinator.activeMode(), "parallel");
  parallel.release();
  const qq = coordinator.acquire("qq");
  assert.ok(qq);
  assert.equal(coordinator.activeMode(), "qq");
  qq.release();
  assert.equal(coordinator.isBusy(), false);

  const block = coordinator.blockNewTasks();
  assert.equal(coordinator.acceptsNewTasks(), false);
  assert.equal(coordinator.acquire("source"), undefined);
  block.release();
  block.release();
  assert.equal(coordinator.acceptsNewTasks(), true);
  const resumed = coordinator.acquire("source");
  assert.ok(resumed);
  resumed.release();
});

test("freezes elapsed time at the terminal timestamp", () => {
  const startedAt = "2026-08-07T00:00:00.000Z";
  const finishedAt = "2026-08-07T00:01:30.000Z";
  assert.equal(taskElapsedMs(startedAt, undefined, Date.parse("2026-08-07T00:00:12.000Z")), 12_000);
  assert.equal(taskElapsedMs(startedAt, finishedAt, Date.parse("2026-08-08T00:00:00.000Z")), 90_000);
});
