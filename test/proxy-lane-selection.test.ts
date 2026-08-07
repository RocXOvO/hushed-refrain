import assert from "node:assert/strict";
import { test } from "node:test";
import { selectProxyLanes } from "../src/proxy-lane-selection";

test("auto-selects every verified exit so work can rotate across the whole pool", () => {
  const pool = Array.from({ length: 12 }, (_, index) => `proxy-${index + 1}`);
  const result = selectProxyLanes(pool, 0, 3, 8);
  assert.deepEqual(result.entries, pool);
  assert.deepEqual(result.selection, {
    mode: "auto",
    available: 12,
    selected: 12,
    requested: 0,
  });
});

test("honors a manual exit cap without exceeding verified availability", () => {
  const pool = ["a", "b", "c"];
  assert.deepEqual(selectProxyLanes(pool, 2, 1, 8).entries, ["a", "b"]);
  assert.deepEqual(selectProxyLanes(pool, 9, 1, 8).entries, pool);
});

test("auto selection keeps the full pool across supported host concurrency values", () => {
  const pool = Array.from({ length: 32 }, (_, index) => `proxy-${index + 1}`);
  assert.equal(selectProxyLanes(pool, 0, 3, 1).entries.length, 32);
  assert.equal(selectProxyLanes(pool, 0, 3, 8).entries.length, 32);
  assert.equal(selectProxyLanes(pool, 0, 3, 12).entries.length, 32);
  assert.equal(selectProxyLanes(pool, 0, 3, 32).entries.length, 32);
});
