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
  const gate = new ProxyTransportGate({ maxConcurrent: 2, minStartDelayMs: 0 });
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

test("governor retries reacquire the shared transport gate", async () => {
  class CountingGate extends ProxyTransportGate {
    entries = 0;
    override async run<T>(request: () => Promise<T>): Promise<T> {
      this.entries += 1;
      return super.run(request);
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
