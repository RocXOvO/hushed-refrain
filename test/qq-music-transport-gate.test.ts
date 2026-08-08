import assert from "node:assert/strict";
import test from "node:test";
import { RunCancelled } from "../src/errors";
import { QQMusicTransportGate } from "../src/qq-music/transport-gate";

test("QQ transport gate caps aggregate in-flight work", async () => {
  const gate = new QQMusicTransportGate({ maxConcurrent: 2, minStartDelayMs: 0 });
  let active = 0;
  let maximum = 0;
  let release = (): void => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const tasks = Array.from({ length: 4 }, () => gate.run(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await blocked;
    active -= 1;
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 2);
  release();
  await Promise.all(tasks);
});

test("QQ transport gate spaces starts through one shared clock", async () => {
  let now = 100;
  const sleeps: number[] = [];
  const gate = new QQMusicTransportGate(
    { maxConcurrent: 2, minStartDelayMs: 250 },
    {
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    },
  );
  const starts: number[] = [];
  await Promise.all([
    gate.run(async () => { starts.push(now); }),
    gate.run(async () => { starts.push(now); }),
  ]);
  assert.equal(starts.length, 2);
  assert.deepEqual(sleeps, [250]);
});

test("cancelling QQ transport wakes a request waiting for start spacing", async () => {
  const gate = new QQMusicTransportGate(
    { maxConcurrent: 2, minStartDelayMs: 250 },
    {
      now: () => 100,
      sleep: () => new Promise<void>(() => {}),
    },
  );
  await gate.run(async () => undefined);
  const waiting = gate.run(async () => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  gate.cancel();
  await assert.rejects(waiting, RunCancelled);
});
