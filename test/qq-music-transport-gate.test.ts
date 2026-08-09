import assert from "node:assert/strict";
import test from "node:test";
import { RunCancelled } from "../src/errors";
import { RequestGovernor } from "../src/governor";
import {
  QQMusicTransportGate,
  qqMusicTransportProfile,
} from "../src/qq-music/transport-gate";

test("QQ transport profile scales likes across independent exits within the host cap", () => {
  assert.deepEqual(qqMusicTransportProfile("likes", 2, 8), {
    maxConcurrent: 8,
    minStartDelayMs: 50,
    checkpointSlots: 8,
  });
  assert.deepEqual(qqMusicTransportProfile("likes", 8, 32), {
    maxConcurrent: 32,
    minStartDelayMs: 50,
    checkpointSlots: 32,
  });
  assert.deepEqual(qqMusicTransportProfile("likes", 32, 16), {
    maxConcurrent: 16,
    minStartDelayMs: 50,
    checkpointSlots: 16,
  });
  assert.deepEqual(qqMusicTransportProfile("song", 32, 32), {
    maxConcurrent: 1,
    minStartDelayMs: 50,
    checkpointSlots: 1,
  });
});

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

test("QQ transport gate spaces aggregate starts by 50 ms without a Worker burst", async () => {
  let now = 100;
  const sleeps: number[] = [];
  const gate = new QQMusicTransportGate(
    { maxConcurrent: 8, minStartDelayMs: 50 },
    {
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        await new Promise<void>((resolve) => setImmediate(resolve));
        now += milliseconds;
      },
    },
  );
  const starts: number[] = [];
  await Promise.all(Array.from({ length: 8 }, () => gate.run(async () => { starts.push(now); })));
  assert.equal(starts.length, 8);
  assert.deepEqual(sleeps, Array(7).fill(50));
  assert.deepEqual(starts, [100, 150, 200, 250, 300, 350, 400, 450]);
});

test("QQ scheduled starts preserve both aggregate and same-exit pacing at the real request boundary", async () => {
  let now = 100;
  const runtime = {
    now: () => now,
    sleep: async (milliseconds: number) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      now += milliseconds;
    },
    random: () => 0,
  };
  const gate = new QQMusicTransportGate({ maxConcurrent: 8, minStartDelayMs: 50 }, runtime);
  const governors = [0, 1].map(() => new RequestGovernor({
    minDelayMs: 300,
    jitterMs: 0,
    maxRetries: 0,
    forbiddenCooldownMs: 60_000,
    requestBudget: 10,
    platformPolicy: "qq" as const,
  }, runtime));
  const starts: Array<{ lane: number; at: number }> = [];
  await Promise.all(Array.from({ length: 6 }, (_unused, index) => {
    const lane = index % governors.length;
    return governors[lane].executeScheduled(
      `lane-${lane}`,
      (beforeStart, request) => gate.runWithPacing(beforeStart, request),
      async () => { starts.push({ lane, at: now }); },
    );
  }));
  const ordered = [...starts].sort((left, right) => left.at - right.at);
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(ordered[index].at - ordered[index - 1].at >= 50);
  }
  for (const lane of [0, 1]) {
    const laneStarts = starts.filter((item) => item.lane === lane).map((item) => item.at).sort((a, b) => a - b);
    for (let index = 1; index < laneStarts.length; index += 1) {
      assert.ok(laneStarts[index] - laneStarts[index - 1] >= 300);
    }
  }
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
