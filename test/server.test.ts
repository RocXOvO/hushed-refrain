import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDashboard } from "../src/server";

test("dashboard serves UI assets and estimate API", async (context) => {
  const server = await startDashboard({ host: "127.0.0.1", port: 0 });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /云评检索台/);

  const icon = await fetch(`${base}/icons/search.svg`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type") ?? "", /image\/svg\+xml/);

  const estimate = await fetch(`${base}/api/estimate?comments=500000`);
  assert.equal(estimate.status, 200);
  const value = await estimate.json() as { pages: number; expectedSeconds: number };
  assert.equal(value.pages, 5_000);
  assert.equal(value.expectedSeconds, 14_500);
});

test("dashboard validates UID before starting a job", async (context) => {
  const server = await startDashboard({ host: "127.0.0.1", port: 0 });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: "abc", source: "record", recordScope: "all" }),
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /UID/);

  const lookup = await fetch(`http://127.0.0.1:${address.port}/api/user?uid=abc`);
  assert.equal(lookup.status, 400);
  assert.match(await lookup.text(), /UID/);
});

test("dashboard keeps proxy-pool state under the configured runtime root", async (context) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "ncm-dashboard-"));
  const server = await startDashboard({ host: "127.0.0.1", port: 0, runtimeRoot });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/pool`);
  assert.equal(response.status, 200);
  const pool = await response.json() as { status: string; poolPath: string; entries: unknown[] };
  assert.equal(pool.status, "not-running");
  assert.equal(pool.poolPath, join(runtimeRoot, ".ncm", "proxy-pool.json"));
  assert.deepEqual(pool.entries, []);
});
