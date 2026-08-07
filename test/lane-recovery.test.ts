import assert from "node:assert/strict";
import { test } from "node:test";
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
