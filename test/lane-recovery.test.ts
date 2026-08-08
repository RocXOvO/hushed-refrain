import assert from "node:assert/strict";
import { test } from "node:test";
import { RunCancelled } from "../src/errors";
import { LaneRecovery, type LaneRecoveryRuntime } from "../src/lane-recovery";

test("temporarily backs off a failed lane and fully restores it after success", async () => {
  let now = 1_000;
  const waits: number[] = [];
  const runtime: LaneRecoveryRuntime = {
    now: () => now,
    sleep: async (milliseconds) => { waits.push(milliseconds); now += milliseconds; },
  };
  const recovery = new LaneRecovery(100, 1_000, runtime);

  assert.equal(recovery.recordFailure(), 100);
  await recovery.waitUntilReady();
  assert.equal(recovery.recordFailure(), 200);
  await recovery.waitUntilReady();
  recovery.recordSuccess();
  await recovery.waitUntilReady();

  assert.deepEqual(waits, [100, 200]);
  assert.equal(recovery.recordFailure(), 100);
});

test("cancellation immediately wakes a lane waiting in backoff", async () => {
  let resolveSleep!: () => void;
  const recovery = new LaneRecovery(30_000, 30_000, {
    now: () => 1_000,
    sleep: () => new Promise<void>((resolve) => { resolveSleep = resolve; }),
  });
  recovery.recordFailure();
  let settled = false;
  const waiting = recovery.waitUntilReady().then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));

  recovery.cancel();
  await waiting;
  assert.equal(settled, true);
  resolveSleep();
});

test("a concurrent success wakes workers waiting on an obsolete backoff", async () => {
  let resolveSleep!: () => void;
  const sleeping = new Promise<void>((resolve) => { resolveSleep = resolve; });
  const recovery = new LaneRecovery(1_000, 30_000, {
    now: () => 0,
    sleep: () => sleeping,
  });
  recovery.recordFailure();
  let ready = false;
  const wait = recovery.waitUntilReady().then(() => { ready = true; });

  recovery.recordSuccess();
  await wait;
  assert.equal(ready, true);
  resolveSleep();
});

test("an AbortSignal cancels a recovery wait without cancelling the reusable lane", async () => {
  let resolveSleep!: () => void;
  const recovery = new LaneRecovery(30_000, 30_000, {
    now: () => 1_000,
    sleep: () => new Promise<void>((resolve) => { resolveSleep = resolve; }),
  });
  recovery.recordFailure();
  const controller = new AbortController();
  const waiting = recovery.waitUntilReady(controller.signal);
  controller.abort();

  await assert.rejects(waiting, RunCancelled);
  assert.equal(recovery.ready, false);
  recovery.recordSuccess();
  assert.equal(recovery.ready, true);
  resolveSleep();
});

test("a pre-aborted signal never starts a recovery timer", async () => {
  let sleeps = 0;
  const recovery = new LaneRecovery(30_000, 30_000, {
    now: () => 1_000,
    sleep: async () => { sleeps += 1; },
  });
  recovery.recordFailure();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(recovery.waitUntilReady(controller.signal), RunCancelled);
  assert.equal(sleeps, 0);
});

test("aborting a default-runtime wait clears its long timer", async () => {
  const recovery = new LaneRecovery(60_000, 60_000);
  recovery.recordFailure();
  const controller = new AbortController();
  const waiting = recovery.waitUntilReady(controller.signal);
  controller.abort();
  await assert.rejects(waiting, RunCancelled);
});
