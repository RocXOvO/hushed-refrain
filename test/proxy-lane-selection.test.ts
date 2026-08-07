import assert from "node:assert/strict";
import { test } from "node:test";
import { selectProxyLanes } from "../src/proxy-lane-selection";

test("auto-selects only enough exits to fill the host concurrency gate", () => {
  const pool = Array.from({ length: 12 }, (_, index) => `proxy-${index + 1}`);
  const result = selectProxyLanes(pool, 0, 3, 8);
  assert.deepEqual(result.entries, ["proxy-1", "proxy-2", "proxy-3"]);
  assert.deepEqual(result.selection, {
    mode: "auto",
    available: 12,
    selected: 3,
    requested: 0,
  });
});

test("honors a manual exit cap without exceeding verified availability", () => {
  const pool = ["a", "b", "c"];
  assert.deepEqual(selectProxyLanes(pool, 2, 1, 8).entries, ["a", "b"]);
  assert.deepEqual(selectProxyLanes(pool, 9, 1, 8).entries, pool);
});

test("auto selection follows custom host concurrency across supported bounds", () => {
  const pool = Array.from({ length: 32 }, (_, index) => `proxy-${index + 1}`);
  assert.equal(selectProxyLanes(pool, 0, 3, 1).entries.length, 1);
  assert.equal(selectProxyLanes(pool, 0, 3, 8).entries.length, 3);
  assert.equal(selectProxyLanes(pool, 0, 3, 12).entries.length, 4);
  assert.equal(selectProxyLanes(pool, 0, 3, 32).entries.length, 11);
});
