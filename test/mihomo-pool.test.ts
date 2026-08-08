import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  classifyManagedMihomoProcess,
  discoverClashVerge,
  defaultMihomoPoolOptions,
  egressNetworkKey,
  managedMihomoCommandMatches,
  managedGenerationHealthy,
  mergeProxyDefinitions,
  proxyPoolRunning,
  proxyPoolStatusRunning,
  recentlyVerifiedProxyPoolEntries,
  readClashVergeProfiles,
  readProxyPool,
  refreshProxyPool,
  selectFastestDistinct,
  selectManagedPortPlan,
  stopMihomoPool,
  verifyProxyPool,
  waitForProcessExit,
  waitForPorts,
  withPoolBuildLock,
} from "../src/mihomo-pool";
import type { ProxyPoolEntry, ProxyPoolFile } from "../src/mihomo-pool";
import { RunCancelled } from "../src/errors";

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

test("recovers a completed atomic proxy-pool temp after an interrupted rename", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-pool-atomic-recovery-"));
  const poolPath = join(directory, "proxy-pool.json");
  await writeFile(`${poolPath}.tmp-123-recovery`, JSON.stringify({
    version: 1,
    generatedAt: new Date(0).toISOString(),
    active: false,
    source: "external",
    entries: [],
  }));

  const pool = await readProxyPool(poolPath);
  assert.equal(pool?.source, "external");
  assert.equal(pool?.active, false);
});

test("listener probing shares one timeout across bounded batches", async () => {
  const servers = Array.from({ length: 8 }, () => createServer());
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  })));
  const ports = servers.map((server) => (server.address() as { port: number }).port);
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  const startedAt = Date.now();

  await assert.rejects(waitForPorts(ports, 100, 1), /did not start/);
  assert.ok(Date.now() - startedAt < 700, "later batches must not receive a fresh timeout");
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

test("does not let a slow refresh overwrite a newer proxy-pool generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-pool-refresh-generation-"));
  const poolPath = join(directory, "proxy-pool.json");
  const entries = [
    entry("lane-a", "1.1.1.1", 20, 30),
    entry("lane-b", "2.2.2.2", 25, 35),
  ];
  const original: ProxyPoolFile = {
    version: 1,
    generationId: "generation-a",
    generatedAt: new Date(0).toISOString(),
    source: "external",
    active: true,
    entries,
  };
  const replacement: ProxyPoolFile = {
    ...original,
    generationId: "generation-b",
    generatedAt: new Date(1).toISOString(),
    entries: entries.map((value) => ({ ...value, latencyMs: 7 })),
  };
  await writeFile(poolPath, JSON.stringify(original));
  let replaced = false;

  const refreshed = await refreshProxyPool(poolPath, async (name, endpoint) => {
    if (!replaced) {
      replaced = true;
      await writeFile(poolPath, JSON.stringify(replacement));
    }
    return { ...entries.find((value) => value.name === name)!, endpoint };
  });

  assert.equal(refreshed.generationId, "generation-b");
  assert.equal((await readProxyPool(poolPath))?.generationId, "generation-b");
  assert.deepEqual((await readProxyPool(poolPath))?.entries, replacement.entries);
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
  assert.equal(recentlyVerifiedProxyPoolEntries({
    ...pool,
    lastCheckedAt: new Date().toISOString(),
  }), undefined);
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

test("cancels queued pool verification without starting another endpoint probe", async () => {
  const controller = new AbortController();
  const entries = [
    entry("a", "8.8.8.8", 20, 30),
    entry("b", "9.9.9.9", 21, 31),
    entry("c", "1.1.1.1", 22, 32),
    entry("d", "208.67.222.222", 23, 33),
  ];
  const pool: ProxyPoolFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "external",
    active: true,
    entries,
  };
  const probes: string[] = [];
  await assert.rejects(
    verifyProxyPool(pool, async (name) => {
      probes.push(name);
      controller.abort();
      return entries.find((candidate) => candidate.name === name)!;
    }, controller.signal),
    RunCancelled,
  );
  assert.deepEqual(probes, ["a"]);
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

test("classifies managed process ownership without treating an unreadable command as foreign", () => {
  const pool: ProxyPoolFile = {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    source: "clash-verge",
    active: true,
    pid: 123,
    mihomoConfigPath: "C:\\Pool\\config.yaml",
    mihomoExecutablePath: "C:\\Apps\\verge-mihomo.exe",
    entries: [entry("managed", "8.8.8.8", 20, 30)],
  };
  assert.equal(classifyManagedMihomoProcess(pool, false, undefined), "not-running");
  assert.equal(classifyManagedMihomoProcess(pool, true, undefined), "unavailable");
  assert.equal(classifyManagedMihomoProcess(pool, true, "node unrelated.js"), "mismatch");
  assert.equal(classifyManagedMihomoProcess(
    pool,
    true,
    '"C:\\Apps\\verge-mihomo.exe" -f "C:\\Pool\\config.yaml"',
  ), "verified");
});

test("allocates a fallback generation port range when the preferred range is occupied", async () => {
  const occupied = new Set([17_891, 19_097]);
  const plan = await selectManagedPortPlan(
    { basePort: 17_891, controllerPort: 19_097 },
    4,
    async (port) => occupied.has(port),
  );
  assert.notEqual(plan.basePort, 17_891);
  assert.deepEqual(plan.listenerPorts, [17_912, 17_913, 17_914, 17_915]);
  assert.equal(plan.controllerPort, 17_917);
  assert.equal(new Set([...plan.listenerPorts, plan.controllerPort]).size, 5);
});

test("refuses to claim a process exited when the PID is still alive", async () => {
  assert.equal(await waitForProcessExit(process.pid, 0), false);
});

test("requires the new PID and every selected listener to stay healthy before retiring the old generation", async () => {
  assert.equal(await managedGenerationHealthy(process.pid, [17_891, 17_892], async () => true), true);
  let probes = 0;
  assert.equal(await managedGenerationHealthy(2_147_483_647, [17_891], async () => {
    probes += 1;
    return true;
  }), false);
  assert.equal(probes, 0);
  assert.equal(await managedGenerationHealthy(process.pid, [17_891, 17_892], async (port) => port === 17_891), false);
});

test("serializes proxy-pool mutations with an ownership-safe file lock", async () => {
  const workDirectory = await mkdtemp(join(tmpdir(), "ncm-pool-build-lock-"));
  let markEntered!: () => void;
  let releaseFirst!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const hold = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = withPoolBuildLock(workDirectory, async () => {
    markEntered();
    await hold;
    return "first";
  });
  await entered;

  await assert.rejects(
    withPoolBuildLock(workDirectory, async () => "second"),
    /另一个客户端正在构建或更新代理池/,
  );
  releaseFirst();
  assert.equal(await first, "first");
  assert.equal(await withPoolBuildLock(workDirectory, async () => "third"), "third");
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
