import assert from "node:assert/strict";
import { test } from "node:test";
import { selectFastestDistinct } from "../src/mihomo-pool";
import type { ProxyPoolEntry } from "../src/mihomo-pool";

function entry(
  name: string,
  egressIp: string,
  latencyMs: number,
  ncmLatencyMs: number,
  ncmVerified = true,
): ProxyPoolEntry {
  return {
    name,
    endpoint: `http://127.0.0.1:${17_891 + latencyMs}`,
    egressIp,
    latencyMs,
    ncmLatencyMs,
    ncmVerified,
  };
}

test("selects the fastest verified entries with distinct egress IPs", () => {
  const selected = selectFastestDistinct([
    entry("slow-a", "1.1.1.1", 300, 300),
    entry("fast-a", "1.1.1.1", 50, 50),
    entry("fast-b", "2.2.2.2", 60, 60),
    entry("unverified", "3.3.3.3", 10, 10, false),
    entry("fast-c", "4.4.4.4", 70, 70),
  ], 3);

  assert.deepEqual(selected.map((value) => value.name), [
    "fast-a",
    "fast-b",
    "fast-c",
  ]);
  assert.equal(new Set(selected.map((value) => value.egressIp)).size, 3);
});
