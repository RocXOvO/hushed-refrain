import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  discoverClashVerge,
  proxyPoolRunning,
  readClashVergeProfiles,
  selectFastestDistinct,
} from "../src/mihomo-pool";
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
