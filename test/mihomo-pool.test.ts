import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  discoverClashVerge,
  defaultMihomoPoolOptions,
  egressNetworkKey,
  managedMihomoCommandMatches,
  mergeProxyDefinitions,
  proxyPoolRunning,
  proxyPoolStatusRunning,
  recentlyVerifiedProxyPoolEntries,
  readClashVergeProfiles,
  readProxyPool,
  refreshProxyPool,
  selectFastestDistinct,
  stopMihomoPool,
  verifyProxyPool,
} from "../src/mihomo-pool";
import type { ProxyPoolEntry, ProxyPoolFile } from "../src/mihomo-pool";

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

test("defaults to eight exits selected from forty-eight candidates", () => {
  const options = defaultMihomoPoolOptions("/tmp/ncm-pool-defaults");
  assert.equal(options.size, 8);
  assert.equal(options.candidateCount, 48);
  assert.equal(options.sourceConfigPaths.length, 1);
});

test("merges selected Clash configs while de-duplicating nodes and renaming conflicts", () => {
  const merged = mergeProxyDefinitions([
    [
      { name: "Hong Kong 01", type: "ss", server: "one.example", port: 443, password: "a" },
      { name: "Shared Name", type: "ss", server: "two.example", port: 443, password: "b" },
    ],
    [
      { name: "Same Endpoint Label", type: "ss", server: "one.example", port: 443, password: "a" },
      { name: "Shared Name", type: "ss", server: "three.example", port: 443, password: "c" },
    ],
  ]);

  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((proxy) => proxy.name), [
    "Hong Kong 01",
    "Shared Name",
    "Shared Name · 配置 2",
  ]);
  assert.equal((merged[0] as { name: string }).name, "Hong Kong 01");
});

test("migrates a legacy single-config pool file to the multi-config shape", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-pool-config-migration-"));
  const poolPath = join(directory, "proxy-pool.json");
  await writeFile(poolPath, JSON.stringify({
    version: 1,
    generatedAt: new Date(0).toISOString(),
    active: false,
    sourceConfigPath: "/profiles/legacy.yaml",
    entries: [],
  }));

  const pool = await readProxyPool(poolPath);
  assert.equal(pool?.source, "clash-verge");
  assert.deepEqual(pool?.sourceConfigPaths, ["/profiles/legacy.yaml"]);
});

test("selects the fastest verified entries from distinct egress networks", () => {
  const selected = selectFastestDistinct([
    entry("slow-a", "1.1.1.1", 300, 300),
    entry("fast-a", "1.1.1.2", 50, 50),
    entry("same-subnet", "1.1.1.3", 55, 55),
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
  assert.equal(new Set(selected.map((value) => egressNetworkKey(value.egressIp))).size, 3);
});

test("does not fill a requested pool with addresses from the same subnet", () => {
  const selected = selectFastestDistinct([
    entry("subnet-a", "103.151.17.10", 20, 20),
    entry("subnet-b", "103.151.17.20", 30, 30),
    entry("subnet-c", "103.151.17.30", 40, 40),
  ], 3);

  assert.deepEqual(selected.map((value) => value.name), ["subnet-a"]);
});

test("groups IPv4 by /24 and IPv6 by /48", () => {
  assert.equal(egressNetworkKey("103.151.17.10"), "103.151.17.0/24");
  assert.equal(egressNetworkKey("103.151.17.200"), "103.151.17.0/24");
  assert.equal(egressNetworkKey("2001:db8:abcd:1::1"), "2001:db8:abcd::/48");
  assert.equal(egressNetworkKey("2001:db8:abcd:ffff::2"), "2001:db8:abcd::/48");
  assert.equal(egressNetworkKey("2001:db8:abce::1"), "2001:db8:abce::/48");
});

test("refreshes and persists current proxy latency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-pool-refresh-"));
  const poolPath = join(directory, "proxy-pool.json");
  const entries = [
    entry("lane-a", "103.151.17.10", 20, 30),
    entry("lane-b", "2.2.2.2", 25, 35),
  ];
  const pool: ProxyPoolFile = {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    lastCheckedAt: new Date(0).toISOString(),
    source: "external",
    active: true,
    entries,
  };
  await writeFile(poolPath, JSON.stringify(pool));

  const refreshed = await refreshProxyPool(poolPath, async (name, endpoint) => {
    const previous = entries.find((value) => value.name === name)!;
    return { ...previous, endpoint, latencyMs: 80, ncmLatencyMs: 120 };
  });

  assert.deepEqual(refreshed.entries.map((value) => value.ncmLatencyMs), [120, 120]);
  assert.notEqual(refreshed.lastCheckedAt, pool.lastCheckedAt);
  assert.deepEqual((await readProxyPool(poolPath))?.entries, refreshed.entries);
});

test("treats an active external pool as running without a managed PID", () => {
  assert.equal(proxyPoolRunning({
    version: 1,
    generatedAt: new Date(0).toISOString(),
    source: "external",
    active: true,
    entries: [entry("external", "8.8.8.8", 20, 30)],
  }), true);
  assert.equal(proxyPoolRunning({
    version: 1,
    generatedAt: new Date(0).toISOString(),
    source: "external",
    active: false,
    entries: [entry("external", "8.8.8.8", 20, 30)],
  }), false);
});

test("reuses only fresh verified distinct pool entries when a task starts", () => {
  const now = Date.now();
  const entries = [
    entry("lane-a", "1.1.1.1", 20, 30),
    entry("lane-b", "2.2.2.2", 25, 35),
  ];
  const pool: ProxyPoolFile = {
    version: 1,
    generatedAt: new Date(now - 30_000).toISOString(),
    lastCheckedAt: new Date(now - 30_000).toISOString(),
    source: "external",
    active: true,
    entries,
  };

  assert.deepEqual(recentlyVerifiedProxyPoolEntries(pool, now), entries);
  assert.equal(recentlyVerifiedProxyPoolEntries({
    ...pool,
    lastCheckedAt: new Date(now - 120_000).toISOString(),
  }, now), undefined);
  assert.equal(recentlyVerifiedProxyPoolEntries({
    ...pool,
    entries: [entry("a", "103.151.17.10", 20, 30), entry("b", "103.151.17.20", 25, 35)],
  }, now), undefined);
  assert.equal(recentlyVerifiedProxyPoolEntries({
    ...pool,
    entries: [{ ...entries[0], ncmVerified: false }, entries[1]],
  }, now), undefined);
});

test("uses a cheap PID liveness hint for frequently polled managed-pool status", () => {
  const pool: ProxyPoolFile = {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    source: "clash-verge",
    active: true,
    mihomoConfigPath: "/not/the/current/process/config.yaml",
    mihomoExecutablePath: "/not/the/current/process/mihomo",
    pid: process.pid,
    entries: [entry("managed", "8.8.8.8", 20, 30)],
  };

  assert.equal(proxyPoolStatusRunning(pool), true);
  assert.equal(proxyPoolRunning(pool), false);
  assert.equal(proxyPoolStatusRunning({ ...pool, active: false }), false);
});

test("verifies live managed listeners even when command identity lookup is unavailable", async () => {
  const expected = entry("managed", "8.8.8.8", 20, 30);
  const pool: ProxyPoolFile = {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    source: "clash-verge",
    active: true,
    mihomoConfigPath: "/not/the/current/process/config.yaml",
    mihomoExecutablePath: "/not/the/current/process/mihomo",
    pid: process.pid,
    entries: [expected],
  };

  assert.equal(proxyPoolRunning(pool), false);
  const verified = await verifyProxyPool(pool, async (name, endpoint) => ({
    ...expected,
    name,
    endpoint,
  }));
  assert.deepEqual(verified, [expected]);
});

test("rejects a changed exit when managed-process identity cannot be verified", async () => {
  const expected = entry("managed", "8.8.8.8", 20, 30);
  const pool: ProxyPoolFile = {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    source: "clash-verge",
    active: true,
    mihomoConfigPath: "/not/the/current/process/config.yaml",
    mihomoExecutablePath: "/not/the/current/process/mihomo",
    pid: process.pid,
    entries: [expected],
  };

  await assert.rejects(
    verifyProxyPool(pool, async (name, endpoint) => ({
      ...expected,
      name,
      endpoint,
      egressIp: "9.9.9.9",
    })),
    /出口 IP 已变化/,
  );
});

test("matches a managed Mihomo process by executable and config path", () => {
  assert.equal(managedMihomoCommandMatches(
    '"C:\\Apps\\verge-mihomo.exe" -d "C:\\Pool" -f "C:\\Pool\\config.yaml"',
    "C:\\Pool\\config.yaml",
    "C:\\Apps\\verge-mihomo.exe",
  ), true);
  assert.equal(managedMihomoCommandMatches(
    "node unrelated-service.js",
    "C:\\Pool\\config.yaml",
    "C:\\Apps\\verge-mihomo.exe",
  ), false);
});

test("does not kill a reused PID whose process identity is not Mihomo", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-pool-stale-pid-"));
  const poolPath = join(directory, "proxy-pool.json");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  assert.ok(child.pid);
  try {
    const pool: ProxyPoolFile = {
      version: 1,
      generatedAt: new Date(0).toISOString(),
      source: "clash-verge",
      active: true,
      mihomoConfigPath: join(directory, "config.yaml"),
      mihomoExecutablePath: join(directory, "mihomo"),
      pid: child.pid,
      entries: [entry("stale", "8.8.8.8", 20, 30)],
    };
    await writeFile(poolPath, JSON.stringify(pool));

    assert.equal(await stopMihomoPool(poolPath), true);
    assert.doesNotThrow(() => process.kill(child.pid!, 0));
    assert.equal((await readProxyPool(poolPath))?.active, false);
  } finally {
    child.kill();
  }
});

test("provides platform-specific Clash Verge discovery candidates", () => {
  const discovery = discoverClashVerge();
  assert.equal(discovery.platform, process.platform);
  assert.ok(discovery.configCandidates.length > 0);
  assert.ok(discovery.mihomoCandidates.length > 0);
  assert.ok(Array.isArray(discovery.profiles));
  if (discovery.installed) {
    assert.ok(discovery.configPath);
    assert.ok(discovery.mihomoPath);
  }
});

test("discovers selectable remote and local Clash Verge profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-clash-profiles-"));
  const profilesRoot = join(root, "profiles");
  await mkdir(profilesRoot);
  await Promise.all([
    writeFile(join(profilesRoot, "alpha.yaml"), "proxies: []\n"),
    writeFile(join(profilesRoot, "beta.yml"), "proxies: []\n"),
    writeFile(join(profilesRoot, "merge.yaml"), "prepend-rules: []\n"),
  ]);
  await writeFile(join(root, "profiles.yaml"), [
    "current: beta",
    "items:",
    "  - uid: alpha",
    "    type: remote",
    "    name: Alpha subscription",
    "    file: alpha.yaml",
    "  - uid: beta",
    "    type: local",
    "    name: Beta local",
    "    file: beta.yml",
    "  - uid: merge",
    "    type: merge",
    "    file: merge.yaml",
    "  - uid: escape",
    "    type: remote",
    "    file: ../outside.yaml",
  ].join("\n"));

  const profiles = readClashVergeProfiles(join(root, "profiles.yaml"));
  assert.deepEqual(profiles.map(({ uid, name, type, active }) => ({ uid, name, type, active })), [
    { uid: "alpha", name: "Alpha subscription", type: "remote", active: false },
    { uid: "beta", name: "Beta local", type: "local", active: true },
  ]);
});
