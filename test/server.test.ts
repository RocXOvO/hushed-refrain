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

  const pooledEstimate = await fetch(`${base}/api/estimate?comments=100000&pageSize=100&minDelayMs=2500&jitterMs=800&networkMs=400&lanes=4&workersPerLane=1`);
  assert.equal(pooledEstimate.status, 200);
  const pooledValue = await pooledEstimate.json() as { expectedSeconds: number; totalWorkers: number };
  assert.equal(pooledValue.expectedSeconds, 725);
  assert.equal(pooledValue.totalWorkers, 4);
});

test("dashboard exposes the startup update check", async (context) => {
  const update = {
    currentVersion: "0.1.0",
    latestVersion: "0.2.0",
    updateAvailable: true,
    platform: "win32" as const,
    arch: "x64",
    releaseName: "云评检索台 v0.2.0",
    releaseUrl: "https://example.test/releases/v0.2.0",
    assetName: "NCM-Comment-Finder-Setup-0.2.0.exe",
    downloadUrl: "https://example.test/download.exe",
    checkedAt: "2026-08-06T00:00:00.000Z",
  };
  const server = await startDashboard({
    host: "127.0.0.1",
    port: 0,
    currentVersion: "0.1.0",
    updateChecker: async () => update,
  });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/update`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), update);
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

test("dashboard validates an external proxy pool before importing it", async (context) => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "ncm-dashboard-proxy-"));
  const server = await startDashboard({ host: "127.0.0.1", port: 0, runtimeRoot });
  context.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/pool/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proxies: "" }),
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /代理地址/);
});
