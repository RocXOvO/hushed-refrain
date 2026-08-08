import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AuthenticationRequired,
  CooldownRequired,
  RequestBudgetExhausted,
  RequestExecutionError,
  RunCancelled,
  errorStatus,
} from "../src/errors";
import { RequestGovernor } from "../src/governor";

function fakeRuntime() {
  let now = 1_000;
  const sleeps: number[] = [];
  return {
    runtime: {
      now: () => now,
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      random: () => 0,
    },
    sleeps,
  };
}

test("serializes requests with a minimum delay", async () => {
  const fake = fakeRuntime();
  const governor = new RequestGovernor({
    minDelayMs: 1_000,
    jitterMs: 0,
    maxRetries: 0,
    forbiddenCooldownMs: 60_000,
    requestBudget: 10,
  }, fake.runtime);

  await governor.execute("one", async () => 1);
  await governor.execute("two", async () => 2);

  assert.deepEqual(fake.sleeps, [1_000]);
  assert.equal(governor.requestsUsed, 2);
});

test("shares one lane's start spacing across configured workers", async () => {
  const fake = fakeRuntime();
  const governor = new RequestGovernor({
    minDelayMs: 1_000,
    jitterMs: 0,
    concurrency: 4,
    maxRetries: 0,
    forbiddenCooldownMs: 60_000,
    requestBudget: 10,
  }, fake.runtime);

  await governor.execute("one", async () => 1);
  await governor.execute("two", async () => 2);

  assert.deepEqual(fake.sleeps, [250]);
  assert.equal(governor.requestsUsed, 2);
  assert.equal(governor.pacingConcurrency, 4);
});

test("rejects an invalid worker concurrency", () => {
  assert.throws(() => new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    concurrency: 0,
    maxRetries: 0,
    forbiddenCooldownMs: 60_000,
    requestBudget: 10,
  }), /concurrency/);
});

test("retries transient failures with exponential backoff", async () => {
  const fake = fakeRuntime();
  const governor = new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 2,
    forbiddenCooldownMs: 60_000,
    requestBudget: 10,
    retryBaseMs: 50,
  }, fake.runtime);
  let calls = 0;

  const value = await governor.execute("transient", async () => {
    calls += 1;
    if (calls < 3) throw { status: 502, body: { code: 502 } };
    return "ok";
  });

  assert.equal(value, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(fake.sleeps, [50, 100]);
});

test("turns 403 into a persistent cooldown signal without retry", async () => {
  const fake = fakeRuntime();
  const governor = new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 9,
    forbiddenCooldownMs: 123_000,
    requestBudget: 10,
  }, fake.runtime);
  let calls = 0;

  await assert.rejects(
    governor.execute("blocked", async () => {
      calls += 1;
      throw { status: 403 };
    }),
    (error: unknown) =>
      error instanceof CooldownRequired && error.retryAfterMs === 123_000,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    governor.execute("still-blocked", async () => { calls += 1; }),
    CooldownRequired,
  );
  assert.equal(calls, 1);
});

test("preserves a terminal upstream status for higher-level error handling", async () => {
  const fake = fakeRuntime();
  const governor = new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 3,
    forbiddenCooldownMs: 60_000,
    requestBudget: 10,
  }, fake.runtime);
  let calls = 0;
  await assert.rejects(
    governor.execute("user_detail", async () => { calls += 1; throw { status: 404 }; }),
    (error: unknown) => error instanceof RequestExecutionError && error.status === 404,
  );
  assert.equal(calls, 1);
});

test("does not latch an optional request cooldown onto later required work", async () => {
  const fake = fakeRuntime();
  const governor = new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 0,
    forbiddenCooldownMs: 60_000,
    requestBudget: 10,
  }, fake.runtime);

  await assert.rejects(
    governor.executeBestEffort("optional-metadata", async () => { throw { status: 403 }; }),
    CooldownRequired,
  );
  assert.equal(await governor.execute("required-comment", async () => "ok"), "ok");
  assert.equal(governor.requestsUsed, 2);
});

test("does not latch an optional 429 cooldown onto later required work", async () => {
  const fake = fakeRuntime();
  const governor = new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 0,
    forbiddenCooldownMs: 60_000,
    requestBudget: 10,
  }, fake.runtime);

  await assert.rejects(
    governor.executeBestEffort("optional-metadata", async () => { throw { status: 429 }; }),
    CooldownRequired,
  );
  assert.equal(await governor.execute("required-comment", async () => "ok"), "ok");
});

test("best-effort work keeps retry, budget, and cancellation semantics", async () => {
  const fake = fakeRuntime();
  const governor = new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 1,
    forbiddenCooldownMs: 60_000,
    requestBudget: 2,
    retryBaseMs: 25,
  }, fake.runtime);
  let calls = 0;

  assert.equal(await governor.executeBestEffort("optional-retry", async () => {
    calls += 1;
    if (calls === 1) throw { status: 500 };
    return "ok";
  }), "ok");
  assert.equal(calls, 2);
  assert.deepEqual(fake.sleeps, [25]);
  await assert.rejects(
    governor.execute("required-over-budget", async () => "never"),
    RequestBudgetExhausted,
  );

  const cancelled = new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 0,
    forbiddenCooldownMs: 60_000,
    requestBudget: 10,
  }, fake.runtime);
  cancelled.cancel();
  let cancelledCalls = 0;
  await assert.rejects(
    cancelled.executeBestEffort("cancelled-optional", async () => { cancelledCalls += 1; }),
    RunCancelled,
  );
  assert.equal(cancelledCalls, 0);
});

test("turns 301 into a login requirement without retrying", async () => {
  const fake = fakeRuntime();
  const governor = new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 9,
    forbiddenCooldownMs: 60_000,
    requestBudget: 10,
  }, fake.runtime);
  let calls = 0;

  await assert.rejects(
    governor.execute("likelist", async () => {
      calls += 1;
      throw { status: 301, body: { code: 301 } };
    }),
    AuthenticationRequired,
  );
  assert.equal(calls, 1);
  assert.deepEqual(fake.sleeps, []);
});

test("keeps QQ status 301 out of the NetEase authentication policy", async () => {
  const fake = fakeRuntime();
  const upstream = { status: 301, body: { code: 301 } };
  const governor = new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 9,
    forbiddenCooldownMs: 60_000,
    requestBudget: 10,
    platformPolicy: "qq",
  }, fake.runtime);

  await assert.rejects(
    governor.execute("qq-profile", async () => { throw upstream; }),
    (error: unknown) => error instanceof RequestExecutionError
      && error.status === 301
      && error.cause === upstream,
  );
  assert.deepEqual(fake.sleeps, []);
});

test("preserves nested statuses through execution errors without looping on cyclic causes", async () => {
  const fake = fakeRuntime();
  const upstream = { status: "407" };
  const wrapped = new Error("proxy CONNECT failed", { cause: upstream });
  const governor = new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 0,
    forbiddenCooldownMs: 60_000,
    requestBudget: 10,
    platformPolicy: "qq",
  }, fake.runtime);

  await assert.rejects(
    governor.execute("qq-comment", async () => { throw wrapped; }),
    (error: unknown) => error instanceof RequestExecutionError
      && error.status === 407
      && error.cause === wrapped
      && errorStatus(error) === 407,
  );

  const first: { cause?: unknown } = {};
  const second: { cause?: unknown } = { cause: first };
  first.cause = second;
  assert.equal(errorStatus(first), undefined);
  assert.equal(errorStatus({ status: null }), undefined);
});

test("enforces the per-run request budget", async () => {
  const fake = fakeRuntime();
  const governor = new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 0,
    forbiddenCooldownMs: 60_000,
    requestBudget: 1,
  }, fake.runtime);

  await governor.execute("one", async () => 1);
  await assert.rejects(
    governor.execute("two", async () => 2),
    RequestBudgetExhausted,
  );
});

test("stops before starting another remote request", async () => {
  const fake = fakeRuntime();
  const governor = new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 0,
    forbiddenCooldownMs: 60_000,
    requestBudget: 10,
  }, fake.runtime);
  governor.cancel();

  await assert.rejects(
    governor.execute("cancelled", async () => "unexpected"),
    RunCancelled,
  );
  assert.equal(governor.requestsUsed, 0);
});

test("cancellation wakes a request waiting for its start slot", async () => {
  let sleepStarted!: () => void;
  const sleeping = new Promise<void>((resolve) => { sleepStarted = resolve; });
  const governor = new RequestGovernor({
    minDelayMs: 600_000,
    jitterMs: 0,
    maxRetries: 0,
    forbiddenCooldownMs: 60_000,
    requestBudget: 10,
  }, {
    now: () => 1_000,
    sleep: async () => { sleepStarted(); await new Promise(() => {}); },
    random: () => 0,
  });
  await governor.execute("first", async () => "ok");
  const waiting = governor.execute("waiting", async () => "unexpected");
  await sleeping;

  governor.cancel();
  await assert.rejects(waiting, RunCancelled);
  assert.equal(governor.requestsUsed, 1);
});

test("allows requests to overlap while serializing their start slots", async () => {
  const governor = new RequestGovernor({
    minDelayMs: 5,
    jitterMs: 0,
    maxRetries: 0,
    forbiddenCooldownMs: 60_000,
    requestBudget: 10,
  });
  let active = 0;
  let maxActive = 0;
  const request = async (): Promise<void> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active -= 1;
  };

  await Promise.all([
    governor.execute("one", request),
    governor.execute("two", request),
  ]);

  assert.equal(maxActive, 2);
  assert.equal(governor.requestsUsed, 2);
});
