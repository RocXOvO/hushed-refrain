import assert from "node:assert/strict";
import { test } from "node:test";
import { RunCancelled } from "../src/errors";
import { RequestGovernor } from "../src/governor";
import {
  executeProxyRequest,
  ProxyTransportGate,
  type ProxyTransportGateRuntime,
} from "../src/proxy-transport-gate";

test("caps aggregate in-flight proxy requests across lanes", async () => {
  const gate = new ProxyTransportGate({ maxConcurrent: 2, minStartDelayMs: 0, startJitterMs: 0 });
  let active = 0;
  let peak = 0;
  const requests = Array.from({ length: 8 }, () => gate.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  }));

  await Promise.all(requests);
  assert.equal(peak, 2);
});

test("serializes aggregate request starts with the configured spacing", async () => {
  let now = 1_000;
  const sleeps: number[] = [];
  const runtime: ProxyTransportGateRuntime = {
    now: () => now,
    random: () => 0,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
  };
  const gate = new ProxyTransportGate({ maxConcurrent: 3, minStartDelayMs: 80 }, runtime);
  const started: number[] = [];

  await Promise.all(Array.from({ length: 3 }, () => gate.run(async () => {
    started.push(now);
  })));

  assert.equal(started.length, 3);
  assert.deepEqual(sleeps, [80, 80]);
  assert.equal(now, 1_160);
});

test("adds deterministic bounded jitter between aggregate starts", async () => {
  let now = 1_000;
  const sleeps: number[] = [];
  const randomValues = [0.5, 1];
  const runtime: ProxyTransportGateRuntime = {
    now: () => now,
    random: () => randomValues.shift() ?? 0,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
  };
  const gate = new ProxyTransportGate({
    maxConcurrent: 3,
    minStartDelayMs: 80,
    startJitterMs: 120,
  }, runtime);

  await Promise.all(Array.from({ length: 3 }, () => gate.run(async () => undefined)));

  assert.deepEqual(sleeps, [140, 200]);
});

test("clamps invalid and upper-bound random samples", async () => {
  let now = 1_000;
  const sleeps: number[] = [];
  const randomValues = [Number.NaN, 1];
  const gate = new ProxyTransportGate({ maxConcurrent: 3, minStartDelayMs: 80, startJitterMs: 120 }, {
    now: () => now,
    random: () => randomValues.shift() ?? 0,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
  });

  await Promise.all(Array.from({ length: 3 }, () => gate.run(async () => undefined)));
  assert.deepEqual(sleeps, [80, 200]);
});

test("releases capacity after a failed request", async () => {
  const gate = new ProxyTransportGate({ maxConcurrent: 1, minStartDelayMs: 0 });
  await assert.rejects(gate.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await gate.run(async () => "recovered"), "recovered");
});

test("cancellation rejects queued work without interrupting an in-flight request", async () => {
  const gate = new ProxyTransportGate({ maxConcurrent: 1, minStartDelayMs: 0 });
  let finish!: () => void;
  const first = gate.run(() => new Promise<void>((resolve) => { finish = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const queued = gate.run(async () => "never");

  gate.cancel();
  await assert.rejects(queued, RunCancelled);
  finish();
  await first;
});

test("cancellation wakes work waiting for aggregate start spacing", async () => {
  let resolveSleep!: () => void;
  const runtime: ProxyTransportGateRuntime = {
    now: () => 1_000,
    random: () => 0,
    sleep: () => new Promise<void>((resolve) => { resolveSleep = resolve; }),
  };
  const gate = new ProxyTransportGate({ maxConcurrent: 2, minStartDelayMs: 10_000, startJitterMs: 0 }, runtime);
  await gate.run(async () => undefined);
  const waiting = gate.run(async () => "never");
  await new Promise((resolve) => setImmediate(resolve));

  gate.cancel();
  await assert.rejects(waiting, RunCancelled);
  resolveSleep();
});

test("governor retries reacquire the shared transport gate", async () => {
  class CountingGate extends ProxyTransportGate {
    entries = 0;
    override async runScheduled<T>(beforeStart: () => Promise<void>, request: () => Promise<T>): Promise<T> {
      this.entries += 1;
      return super.runScheduled(beforeStart, request);
    }
  }
  const gate = new CountingGate({ maxConcurrent: 1, minStartDelayMs: 0 });
  const governor = new RequestGovernor({
    requestBudget: 10,
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 1,
    retryBaseMs: 0,
    retryCapMs: 0,
    forbiddenCooldownMs: 1_000,
  });
  let attempts = 0;
  const lane = { governor, transportGate: gate };

  const result = await executeProxyRequest(lane, "retry", async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary");
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
  assert.equal(gate.entries, 2);
});

test("records lane and task spacing at the same actual request boundary", async () => {
  let now = 1_000;
  const runtime = {
    now: () => now,
    random: () => 0,
    sleep: async (milliseconds: number) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      now += milliseconds;
    },
  };
  const gate = new ProxyTransportGate({ maxConcurrent: 4, minStartDelayMs: 50 }, runtime);
  const governor = new RequestGovernor({
    requestBudget: 10,
    minDelayMs: 300,
    jitterMs: 0,
    maxRetries: 0,
    forbiddenCooldownMs: 1_000,
  }, runtime);
  const starts: number[] = [];
  const lane = { governor, transportGate: gate };

  await Promise.all([
    executeProxyRequest(lane, "one", async () => { starts.push(now); }),
    executeProxyRequest(lane, "two", async () => { starts.push(now); }),
  ]);

  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 300);
});

test("automatically reduces aggregate concurrency and start rate after clustered transport failures", async () => {
  let now = 1_000;
  const gate = new ProxyTransportGate({
    maxConcurrent: 18,
    minStartDelayMs: 80,
    startJitterMs: 0,
    adaptiveFailureThreshold: 3,
    minimumAdaptiveConcurrent: 4,
  }, {
    now: () => now,
    random: () => 0,
    sleep: async (milliseconds) => { now += milliseconds; },
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(gate.run(async () => { throw { status: 502 }; }));
  }

  assert.equal(gate.currentMaxConcurrent, 9);
  assert.equal(gate.currentMinStartDelayMs, 160);
});

test("slowly restores adaptive concurrency after a stable success streak", async () => {
  let now = 1_000;
  const gate = new ProxyTransportGate({
    maxConcurrent: 8,
    minStartDelayMs: 0,
    adaptiveFailureThreshold: 2,
    adaptiveRecoverySuccesses: 2,
    adaptiveRecoveryIntervalMs: 5_000,
    minimumAdaptiveConcurrent: 2,
  }, {
    now: () => now,
    random: () => 0,
    sleep: async () => undefined,
  });
  await assert.rejects(gate.run(async () => { throw { status: 502 }; }));
  await assert.rejects(gate.run(async () => { throw { status: 502 }; }));
  assert.equal(gate.currentMaxConcurrent, 4);

  now += 5_000;
  await gate.run(async () => undefined);
  await gate.run(async () => undefined);
  assert.equal(gate.currentMaxConcurrent, 5);
});

test("an eighteen-request burst completes after automatic load shedding", async () => {
  const gate = new ProxyTransportGate({
    maxConcurrent: 18,
    minStartDelayMs: 0,
    startJitterMs: 0,
    adaptiveFailureThreshold: 3,
    minimumAdaptiveConcurrent: 4,
  });
  let active = 0;
  let peak = 0;
  let truncated = 0;
  const values = await Promise.all(Array.from({ length: 18 }, async (_, id) => {
    while (true) {
      try {
        return await gate.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setImmediate(resolve));
          if (active > 6) {
            active -= 1;
            truncated += 1;
            throw { status: 502, body: { code: 502 } };
          }
          active -= 1;
          return id;
        });
      } catch (error) {
        assert.equal((error as { status?: number }).status, 502);
      }
    }
  }));

  assert.equal(peak, 18);
  assert.ok(truncated >= 3);
  assert.deepEqual(values, Array.from({ length: 18 }, (_, id) => id));
  assert.ok(gate.currentMaxConcurrent < 18);
});
