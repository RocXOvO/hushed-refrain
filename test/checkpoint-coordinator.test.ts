import assert from "node:assert/strict";
import test from "node:test";
import { CheckpointCoordinator } from "../src/checkpoint-coordinator";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("trailing-publishes the latest state without another checkpoint opportunity", async () => {
  const state = { value: 1 };
  const published: number[] = [];
  const persisted: number[] = [];
  const coordinator = new CheckpointCoordinator({
    state: () => state,
    publish: () => published.push(state.value),
    persist: async (snapshot) => {
      persisted.push(snapshot.value);
    },
    liveIntervalMs: 25,
    persistIntervalMs: 1_000,
  });

  await coordinator.checkpoint();
  state.value = 2;
  await coordinator.checkpoint();

  assert.deepEqual(published, [1]);
  await delay(40);
  assert.deepEqual(published, [1, 2]);
  assert.deepEqual(persisted, [1]);
  coordinator.dispose();
});

test("force cancels a pending trailing publish and persists the final snapshot", async () => {
  const state = { value: 1 };
  const published: number[] = [];
  const persisted: number[] = [];
  const coordinator = new CheckpointCoordinator({
    state: () => state,
    publish: () => published.push(state.value),
    persist: async (snapshot) => {
      persisted.push(snapshot.value);
    },
    liveIntervalMs: 25,
    persistIntervalMs: 1_000,
  });

  await coordinator.checkpoint();
  state.value = 2;
  await coordinator.checkpoint();
  state.value = 3;
  await coordinator.checkpoint(true);

  assert.deepEqual(published, [1, 3]);
  assert.deepEqual(persisted, [1, 3]);
  await delay(40);
  assert.deepEqual(published, [1, 3]);
  coordinator.dispose();
});

test("serializes immutable persistence snapshots in capture order", async () => {
  const state = { nested: { value: 1 } };
  const persisted: number[] = [];
  let active = 0;
  let maximumActive = 0;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const coordinator = new CheckpointCoordinator({
    state: () => state,
    publish: () => undefined,
    persist: async (snapshot) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      persisted.push(snapshot.nested.value);
      if (persisted.length === 1) await firstBlocked;
      active -= 1;
    },
    liveIntervalMs: 0,
    persistIntervalMs: 0,
  });

  const first = coordinator.checkpoint(true);
  state.nested.value = 2;
  const second = coordinator.checkpoint(true);
  await delay(5);

  assert.deepEqual(persisted, [1]);
  assert.equal(maximumActive, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(persisted, [1, 2]);
  assert.equal(maximumActive, 1);
  coordinator.dispose();
});

test("rejects a failed write without poisoning later persistence", async () => {
  const state = { value: 1 };
  const attempts: number[] = [];
  const coordinator = new CheckpointCoordinator({
    state: () => state,
    publish: () => undefined,
    persist: async (snapshot) => {
      attempts.push(snapshot.value);
      if (attempts.length === 1) throw new Error("temporary write failure");
    },
    liveIntervalMs: 0,
    persistIntervalMs: 1_000,
  });

  await assert.rejects(coordinator.checkpoint(true), /temporary write failure/);
  state.value = 2;
  await coordinator.checkpoint(true);

  assert.deepEqual(attempts, [1, 2]);
  coordinator.dispose();
});

test("dispose cancels a pending trailing timer and ignores later checkpoints", async () => {
  const state = { value: 1 };
  const published: number[] = [];
  const persisted: number[] = [];
  const coordinator = new CheckpointCoordinator({
    state: () => state,
    publish: () => published.push(state.value),
    persist: async (snapshot) => {
      persisted.push(snapshot.value);
    },
    liveIntervalMs: 25,
    persistIntervalMs: 1_000,
  });

  await coordinator.checkpoint();
  state.value = 2;
  await coordinator.checkpoint();
  coordinator.dispose();
  state.value = 3;
  await coordinator.checkpoint(true);
  await delay(40);

  assert.deepEqual(published, [1]);
  assert.deepEqual(persisted, [1]);
});
