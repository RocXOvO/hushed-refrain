import assert from "node:assert/strict";
import { test } from "node:test";
import { LaneAllocator } from "../src/lane-allocator";

test("round-robins every healthy lane without exceeding its permit limit", async () => {
  const lanes = Array.from({ length: 8 }, (_, index) => `lane-${index + 1}`);
  const allocator = new LaneAllocator(lanes, 3);
  const permits = await Promise.all(Array.from({ length: 18 }, () => allocator.acquire()));
  const counts = new Map<string, number>();
  for (const permit of permits) {
    assert.ok(permit);
    counts.set(permit.lane, (counts.get(permit.lane) ?? 0) + 1);
  }
  assert.deepEqual(new Set(counts.keys()), new Set(lanes));
  assert.ok([...counts.values()].every((count) => count <= 3));
  for (const permit of permits) permit?.release();
});

test("waits for a temporarily recovering lane instead of terminating the worker", async () => {
  let ready = false;
  const allocator = new LaneAllocator(["lane-1"], 1, () => true, () => ready);
  let settled = false;
  const pending = allocator.acquire().then((permit) => { settled = true; return permit; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false);
  ready = true;
  allocator.notify();
  const permit = await pending;
  assert.equal(permit?.lane, "lane-1");
  permit?.release();
});

test("moves capacity to remaining healthy lanes and cancel wakes waiters", async () => {
  const available = new Set(["lane-1", "lane-2", "lane-3"]);
  const allocator = new LaneAllocator(["lane-1", "lane-2", "lane-3"], 2, (lane) => available.has(lane));
  const first = await Promise.all(Array.from({ length: 6 }, () => allocator.acquire()));
  for (const permit of first) permit?.release();
  available.delete("lane-1");
  allocator.notify();
  const reassigned = await Promise.all(Array.from({ length: 4 }, () => allocator.acquire()));
  assert.ok(reassigned.every((permit) => permit && permit.lane !== "lane-1"));
  const waiting = allocator.acquire();
  allocator.cancel();
  assert.equal(await waiting, undefined);
  for (const permit of reassigned) permit?.release();
});

test("keeps a worker alive while an in-flight request may restore an unavailable lane", async () => {
  let available = false;
  let inFlightMayRestore = true;
  const allocator = new LaneAllocator(
    ["lane-1"],
    1,
    () => available,
    () => true,
    () => inFlightMayRestore,
  );
  let settled = false;
  const pending = allocator.acquire().then((permit) => { settled = true; return permit; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(settled, false);
  available = true;
  inFlightMayRestore = false;
  allocator.notify();
  const permit = await pending;
  assert.equal(permit?.lane, "lane-1");
  permit?.release();
});
