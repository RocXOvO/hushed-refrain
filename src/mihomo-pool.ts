import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { parse, stringify } from "yaml";
import { EnhancedNcmClient } from "./api";
import {
  inlineProxyDefinitions,
  selectProxyCandidates,
  type ProxyDefinition,
} from "./clash-profile-merge";
import { ProxyTransportGate } from "./proxy-transport-gate";
import { readAtomicJson, writeAtomicJson } from "./atomic-file";
import { RunCancelled } from "./errors";

const execFileAsync = promisify(execFile);
const POOL_RECHECK_CONCURRENCY = 4;
export const START_POOL_VERIFICATION_MAX_AGE_MS = 90_000;

type YamlObject = Record<string, unknown>;

export interface MihomoPoolOptions {
  sourceConfigPaths: string[];
  mihomoPath: string;
  workDirectory: string;
  poolPath: string;
  basePort: number;
  size: number;
  candidateCount: number;
  controllerPort: number;
}

export interface ProxyPoolEntry {
  name: string;
  endpoint: string;
  egressIp: string;
  latencyMs: number;
  ncmLatencyMs: number;
  ncmVerified: boolean;
}

export type ProxyPoolSource = "clash-verge" | "external";

export interface ProxyPoolFile {
  version: 1;
  generatedAt: string;
  lastCheckedAt?: string;
  source: ProxyPoolSource;
  active: boolean;
  sourceConfigPath?: string;
  sourceConfigPaths?: string[];
  mihomoConfigPath?: string;
  mihomoExecutablePath?: string;
  generationId?: string;
  listenerPorts?: number[];
  controllerPort?: number;
  controllerSecret?: string;
  pid?: number;
  managementNotice?: string;
  entries: ProxyPoolEntry[];
}

export type ManagedMihomoProcessIdentity = "not-running" | "verified" | "mismatch" | "unavailable";

export interface ManagedPortPlan {
  basePort: number;
  listenerPorts: number[];
  controllerPort: number;
}

export interface ClashVergeDiscovery {
  platform: NodeJS.Platform;
  installed: boolean;
  configPath?: string;
  mihomoPath?: string;
  configCandidates: string[];
  mihomoCandidates: string[];
  profiles: ClashVergeProfile[];
}

export interface ClashVergeProfile {
  uid: string;
  name: string;
  path: string;
  type: "remote" | "local";
  active: boolean;
}

export async function startMihomoPool(
  options: MihomoPoolOptions,
): Promise<ProxyPoolFile> {
  await mkdir(options.workDirectory, { recursive: true });
  return withPoolBuildLock(options.poolPath, () => startMihomoPoolGeneration(options));
}

async function startMihomoPoolGeneration(
  options: MihomoPoolOptions,
): Promise<ProxyPoolFile> {
  const sourceConfigPaths = [...new Set(options.sourceConfigPaths)];
  if (sourceConfigPaths.length === 0) throw new Error("At least one Clash Verge config is required.");
  const lastCandidatePort = options.basePort + options.candidateCount - 1;
  if (lastCandidatePort > 65_535) throw new Error("The proxy listener port range exceeds 65535.");
  if (options.controllerPort >= options.basePort && options.controllerPort <= lastCandidatePort) {
    throw new Error("The Mihomo controller port overlaps the proxy listener range.");
  }
  for (const sourceConfigPath of sourceConfigPaths) {
    if (!existsSync(sourceConfigPath)) {
      throw new Error(`Clash Verge config was not found: ${sourceConfigPath}`);
    }
  }
  if (!existsSync(options.mihomoPath) && !isCommandName(options.mihomoPath)) {
    throw new Error(`Mihomo executable was not found: ${options.mihomoPath}`);
  }

  const proxyGroups: ProxyDefinition[][] = [];
  for (const sourceConfigPath of sourceConfigPaths) {
    try {
      const source = parse(await readFile(sourceConfigPath, "utf8")) as YamlObject;
      proxyGroups.push(inlineProxyDefinitions(source));
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} 配置：${sourceConfigPath}`);
    }
  }
  const candidates = selectProxyCandidates(proxyGroups, options.candidateCount);
  if (candidates.length < options.size) {
    throw new Error(`Only ${candidates.length} proxy candidates are available.`);
  }

  const previous = await readProxyPool(options.poolPath);
  const previousIdentity = previous?.pid
    ? await managedMihomoProcessIdentityAsync(previous)
    : "not-running";
  // A new generation always starts beside the old one on a free port range.
  // Only after the new listeners and exits pass verification is the pool file
  // switched atomically. An uninspectable or reused old PID is never killed.
  const portPlan = await selectManagedPortPlan(options, candidates.length);
  const generationId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const generationDirectory = join(options.workDirectory, "generations", generationId);
  const configPath = join(generationDirectory, "config.yaml");
  const logPath = join(generationDirectory, "mihomo.log");
  const controllerSecret = randomUUID();
  await mkdir(generationDirectory, { recursive: true });
  const config = {
    "log-level": "warning",
    "allow-lan": false,
    ipv6: false,
    mode: "rule",
    "external-controller": `127.0.0.1:${portPlan.controllerPort}`,
    secret: controllerSecret,
    tun: { enable: false },
    dns: { enable: false },
    proxies: candidates,
    listeners: candidates.map((proxy, index) => ({
      name: `ncm-pool-${index + 1}`,
      type: "mixed",
      listen: "127.0.0.1",
      port: portPlan.listenerPorts[index],
      proxy: String(proxy.name),
      users: [],
    })),
    rules: ["MATCH,DIRECT"],
  };
  const serializedConfig = stringify(config, { lineWidth: 0 });
  await writeFile(configPath, serializedConfig, "utf8");
  if (process.platform !== "win32") await chmod(configPath, 0o600);
  await execFileAsync(options.mihomoPath, [
    "-t",
    "-d",
    generationDirectory,
    "-f",
    configPath,
  ], { windowsHide: true, timeout: 30_000 });

  const output = openSync(logPath, "a");
  const child = spawn(options.mihomoPath, [
    "-d",
    generationDirectory,
    "-f",
    configPath,
  ], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", output, output],
  });
  closeSync(output);
  child.unref();
  if (!child.pid) throw new Error("Mihomo pool process did not return a PID.");
  const verificationGate = poolVerificationGate();

  try {
    await waitForPorts(
      portPlan.listenerPorts,
      15_000,
      16,
    );
    const checks = await mapLimit(candidates, 6, async (proxy, index) => {
      const endpoint = `http://127.0.0.1:${portPlan.listenerPorts[index]}`;
      const startedAt = Date.now();
      try {
        const egressIp = await verificationGate.run(() => fetchEgressIp(endpoint, 12_000));
        return {
          name: String(proxy.name),
          endpoint,
          egressIp,
          latencyMs: Date.now() - startedAt,
        };
      } catch {
        return undefined;
      }
    });

    const distinctChecks: Array<Omit<ProxyPoolEntry, "ncmLatencyMs" | "ncmVerified">> = [];
    const seenIps = new Set<string>();
    for (const check of checks) {
      if (!check || seenIps.has(check.egressIp)) continue;
      seenIps.add(check.egressIp);
      distinctChecks.push(check);
    }

    const verifiedChecks = await mapLimit<
      (typeof distinctChecks)[number],
      ProxyPoolEntry | undefined
    >(distinctChecks, 4, async (check) => {
      const startedAt = Date.now();
      try {
        const page = await verificationGate.run(() =>
          new EnhancedNcmClient({ proxy: check.endpoint })
            .getSongCommentsByCursor("186016", 20, 2, String(Date.now()))
        );
        if (page.comments.length === 0) return undefined;
        return {
          ...check,
          ncmLatencyMs: Date.now() - startedAt,
          ncmVerified: true,
        };
      } catch {
        return undefined;
      }
    });
    const distinct = selectFastestDistinct(
      verifiedChecks.filter((entry): entry is ProxyPoolEntry => entry !== undefined),
      options.size,
    );

    if (distinct.length < options.size) {
      throw new Error(
        `仅验证到 ${distinct.length} 个不同网段的网易云可用出口，需要 ${options.size} 个。` +
        "为避免同网段出口集中触发风控，已取消构建；请增加来自不同地区或服务商的节点。",
      );
    }
    if (!isProcessAlive(child.pid)) {
      throw new Error("新代理池进程在验证完成后意外退出，未切换当前代理池。");
    }
    const newIdentity = await managedMihomoProcessIdentityAsync({
      version: 1,
      generatedAt: new Date().toISOString(),
      source: "clash-verge",
      active: true,
      mihomoConfigPath: configPath,
      mihomoExecutablePath: options.mihomoPath,
      pid: child.pid,
      entries: distinct,
    });
    if (newIdentity === "not-running" || newIdentity === "mismatch") {
      throw new Error("新代理池进程身份验证失败，未切换当前代理池。");
    }
    const generatedAt = new Date().toISOString();
    const pool: ProxyPoolFile = {
      version: 1,
      generatedAt,
      lastCheckedAt: generatedAt,
      source: "clash-verge",
      active: true,
      sourceConfigPath: sourceConfigPaths[0],
      sourceConfigPaths,
      mihomoConfigPath: configPath,
      mihomoExecutablePath: options.mihomoPath,
      generationId,
      listenerPorts: portPlan.listenerPorts,
      controllerPort: portPlan.controllerPort,
      controllerSecret,
      pid: child.pid,
      managementNotice: previousIdentity === "unavailable"
        ? "旧代理池进程身份暂时不可读取；新一代已在独立端口完成验证并接管，旧进程未被结束。"
        : previousIdentity === "mismatch"
        ? "检测到已复用或不匹配的旧 PID；未结束该进程，新一代代理池已安全接管。"
        : undefined,
      entries: distinct,
    };
    await writeProxyPool(options.poolPath, pool);
    if (previous?.pid && previous.pid !== child.pid) {
      // The build and network checks above can take tens of seconds. Re-read
      // ownership immediately before signalling so a reused PID is never
      // killed based on a stale decision made at build start.
      const cleanupIdentity = await managedMihomoProcessIdentityAsync(previous);
      const selectedListenerPorts = distinct.map((entry) => Number(new URL(entry.endpoint).port));
      if (!await managedGenerationHealthy(child.pid, selectedListenerPorts)) {
        // The old generation has not been signalled yet and remains the safest
        // authority. Restore its descriptor before surfacing the failed
        // handover so a late new-process exit never takes both generations
        // offline.
        await writeProxyPool(options.poolPath, previous);
        throw new Error("新代理池在接管确认期间失去响应；旧代理池已保留并恢复为当前代理池。");
      }
      if (cleanupIdentity === "verified") {
        delete pool.managementNotice;
        try {
          process.kill(previous.pid);
          if (!await waitForProcessExit(previous.pid, 5_000)) {
            pool.managementNotice = "新一代代理池已接管；旧代理池进程未能及时退出，已保留且不会阻塞当前任务。";
          }
        } catch {
          pool.managementNotice = "新一代代理池已接管；旧代理池进程清理失败，已保留且不会阻塞当前任务。";
        }
      } else if (cleanupIdentity === "unavailable") {
        pool.managementNotice = "旧代理池进程身份暂时不可读取；新一代已在独立端口完成验证并接管，旧进程未被结束。";
      } else if (cleanupIdentity === "mismatch") {
        pool.managementNotice = "检测到已复用或不匹配的旧 PID；未结束该进程，新一代代理池已安全接管。";
      } else {
        delete pool.managementNotice;
      }
      await writeProxyPool(options.poolPath, pool).catch(() => {});
    }
    return pool;
  } catch (error) {
    if (isProcessAlive(child.pid)) {
      try {
        process.kill(child.pid);
        await waitForProcessExit(child.pid, 2_000).catch(() => false);
      } catch {
        // Preserve the build/verification error; cleanup failure is secondary.
      }
    }
    throw error;
  }
}

export async function stopMihomoPool(
  poolPath: string,
  processIdentity: (pool: ProxyPoolFile) => Promise<ManagedMihomoProcessIdentity> = managedMihomoProcessIdentityAsync,
): Promise<boolean> {
  return withPoolBuildLock(poolPath, () => stopMihomoPoolUnlocked(poolPath, processIdentity));
}

async function stopMihomoPoolUnlocked(
  poolPath: string,
  processIdentity: (pool: ProxyPoolFile) => Promise<ManagedMihomoProcessIdentity>,
): Promise<boolean> {
  const pool = await readProxyPool(poolPath);
  if (!pool || !pool.active) return false;
  const identity = await processIdentity(pool);
  if (identity === "verified" && pool.pid) {
    process.kill(pool.pid);
    if (!await waitForProcessExit(pool.pid, 5_000)) {
      throw new Error("代理池进程未能在 5 秒内退出，状态保持为运行中。");
    }
  } else if (identity === "unavailable") {
    throw new Error("Windows 暂时无法读取代理池进程命令行，未结束进程也未修改运行状态。");
  }
  pool.active = false;
  delete pool.pid;
  delete pool.managementNotice;
  await writeProxyPool(poolPath, pool);
  return true;
}

export async function readProxyPool(path: string): Promise<ProxyPoolFile | undefined> {
  return readAtomicJson(path, (value) => {
    const parsed = value as ProxyPoolFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error("Unsupported proxy pool file.");
    }
    parsed.sourceConfigPaths ??= parsed.sourceConfigPath ? [parsed.sourceConfigPath] : undefined;
    parsed.sourceConfigPath ??= parsed.sourceConfigPaths?.[0];
    parsed.source ??= parsed.sourceConfigPaths?.length ? "clash-verge" : "external";
    parsed.active ??= true;
    return parsed;
  });
}

export function proxyPoolRunning(pool: ProxyPoolFile | undefined): boolean {
  if (!pool?.active || pool.entries.length === 0) return false;
  return pool.source === "external" || managedMihomoProcessAlive(pool);
}

/**
 * Cheap health hint for the frequently-polled dashboard status route.
 *
 * A full managed-process identity check shells out to `ps` on Unix and
 * PowerShell on Windows. Doing that on every dashboard poll blocks Electron's
 * main process and makes the window visibly stutter. Callers that only need
 * to use the already-verified listeners can combine this hint with
 * `verifyProxyPool`, which probes every actual exit. Process lifecycle paths
 * still use `proxyPoolRunning` before they signal a PID.
 */
export function proxyPoolStatusRunning(pool: ProxyPoolFile | undefined): boolean {
  if (!pool?.active || pool.entries.length === 0) return false;
  return pool.source === "external" || Boolean(pool.pid && isProcessAlive(pool.pid));
}

export async function importExternalProxyPool(
  endpoints: string[],
  poolPath: string,
  size = 0,
): Promise<ProxyPoolFile> {
  return withPoolBuildLock(poolPath, () => importExternalProxyPoolUnlocked(endpoints, poolPath, size));
}

async function importExternalProxyPoolUnlocked(
  endpoints: string[],
  poolPath: string,
  size: number,
): Promise<ProxyPoolFile> {
  const normalized = [...new Set(endpoints.map(normalizeProxyEndpoint))];
  if (normalized.length === 0) {
    throw new Error("At least one HTTP/HTTPS proxy endpoint is required.");
  }
  const verificationGate = poolVerificationGate();
  const checked = await mapLimit(normalized, Math.min(POOL_RECHECK_CONCURRENCY, normalized.length), async (endpoint, index) => {
    try {
      return await verificationGate.run(() => verifyProxyEndpoint(`external-${index + 1}`, endpoint));
    } catch {
      return undefined;
    }
  });
  const verified = checked.filter((entry): entry is ProxyPoolEntry => entry !== undefined);
  const selected = selectFastestDistinct(verified, size > 0 ? size : verified.length);
  if (selected.length === 0) {
    throw new Error("None of the supplied proxies could reach both the IP service and NetEase comments.");
  }
  const generatedAt = new Date().toISOString();
  const pool: ProxyPoolFile = {
    version: 1,
    generatedAt,
    lastCheckedAt: generatedAt,
    source: "external",
    active: true,
    generationId: `external-${Date.now()}-${randomUUID().slice(0, 8)}`,
    entries: selected,
  };
  await writeProxyPool(poolPath, pool);
  return pool;
}

export async function verifyProxyPool(
  pool: ProxyPoolFile,
  verifier: (name: string, endpoint: string, signal?: AbortSignal) => Promise<ProxyPoolEntry> = verifyProxyEndpoint,
  signal?: AbortSignal,
): Promise<ProxyPoolEntry[]> {
  throwIfPoolVerificationAborted(signal);
  const processIdentityVerified = proxyPoolRunning(pool);
  if (!processIdentityVerified && !proxyPoolStatusRunning(pool)) {
    throw new Error("The proxy pool is not active.");
  }
  const verificationGate = poolVerificationGate();
  const cancelGate = (): void => verificationGate.cancel();
  signal?.addEventListener("abort", cancelGate, { once: true });
  let checked: ProxyPoolEntry[];
  try {
    checked = await mapLimit(pool.entries, Math.min(POOL_RECHECK_CONCURRENCY, pool.entries.length), (entry) => {
      throwIfPoolVerificationAborted(signal);
      return verificationGate.run(async () => {
        throwIfPoolVerificationAborted(signal);
        const verified = await verifier(entry.name, entry.endpoint, signal);
        throwIfPoolVerificationAborted(signal);
        return verified;
      });
    });
  } finally {
    signal?.removeEventListener("abort", cancelGate);
  }
  assertStableFallbackExits(pool, checked, processIdentityVerified);
  const distinct = selectFastestDistinct(checked, pool.entries.length);
  if (distinct.length !== pool.entries.length) {
    throw new Error(
      "代理池不再满足独立网段要求；请重新构建，确保 IPv4 /24 或 IPv6 /48 网段不重复。",
    );
  }
  return distinct;
}

export function recentlyVerifiedProxyPoolEntries(
  pool: ProxyPoolFile,
  now = Date.now(),
  maximumAgeMs = START_POOL_VERIFICATION_MAX_AGE_MS,
): ProxyPoolEntry[] | undefined {
  const running = pool.source === "external" ? proxyPoolStatusRunning(pool) : proxyPoolRunning(pool);
  if (!running || pool.entries.length === 0) return undefined;
  const checkedAt = Date.parse(pool.lastCheckedAt ?? pool.generatedAt);
  const age = now - checkedAt;
  if (!Number.isFinite(checkedAt) || age < 0 || age > maximumAgeMs) return undefined;
  if (pool.entries.some((entry) => !entry.ncmVerified)) return undefined;
  const distinct = selectFastestDistinct(pool.entries, pool.entries.length);
  return distinct.length === pool.entries.length ? distinct : undefined;
}

export async function refreshProxyPool(
  poolPath: string,
  verifier: (name: string, endpoint: string) => Promise<ProxyPoolEntry> = verifyProxyEndpoint,
): Promise<ProxyPoolFile> {
  const pool = await readProxyPool(poolPath);
  if (!pool) throw new Error("The proxy pool is not active.");
  if (!proxyPoolStatusRunning(pool)) {
    throw new Error("The proxy pool is not active.");
  }
  const verificationGate = poolVerificationGate();
  const checked = await mapLimit(pool.entries, Math.min(POOL_RECHECK_CONCURRENCY, pool.entries.length), (entry) =>
    verificationGate.run(() => verifier(entry.name, entry.endpoint))
  );
  // Background refresh must not synchronously query Windows CIM every minute.
  // Stable live exits are the authority here; lifecycle code retains the only
  // permission to signal a PID after its full identity check.
  assertStableFallbackExits(pool, checked, false);
  const distinct = selectFastestDistinct(checked, pool.entries.length);
  if (distinct.length !== pool.entries.length) {
    throw new Error(
      "代理池复测后不再满足独立网段要求；保留上次结果，并将在下个周期重试。",
    );
  }

  // Do not let a slow refresh resurrect a stopped pool or overwrite a rebuild.
  return withPoolBuildLock(poolPath, async () => {
    const current = await readProxyPool(poolPath);
    if (!current || !proxyPoolStatusRunning(current)) {
      throw new Error("代理池已在复测期间停止。");
    }
    if (proxyPoolGenerationKey(current) !== proxyPoolGenerationKey(pool)) return current;
    const refreshed: ProxyPoolFile = {
      ...current,
      lastCheckedAt: new Date().toISOString(),
      entries: distinct,
    };
    await writeProxyPool(poolPath, refreshed);
    return refreshed;
  });
}

function proxyPoolGenerationKey(pool: ProxyPoolFile): string {
  return pool.generationId ?? [
    pool.source,
    pool.generatedAt,
    pool.pid ?? "external",
    pool.mihomoConfigPath ?? "",
  ].join("\u0000");
}

function assertStableFallbackExits(
  pool: ProxyPoolFile,
  checked: ProxyPoolEntry[],
  processIdentityVerified: boolean,
): void {
  if (pool.source !== "clash-verge" || processIdentityVerified) return;
  const changed = checked.some((entry, index) => entry.egressIp !== pool.entries[index]?.egressIp);
  if (changed) {
    throw new Error(
      "代理池进程身份暂时无法复核，且实际出口 IP 已变化；为防止误用本机出口，请重新自动优选。",
    );
  }
}

/**
 * Select the lowest-latency verified exit from each independent network.
 * Treating every address as independent is misleading when several exits are
 * allocated from the same provider subnet, so IPv4 uses /24 and IPv6 uses /48.
 */
export function selectFastestDistinct(
  entries: ProxyPoolEntry[],
  size: number,
): ProxyPoolEntry[] {
  const fastestFirst = [...entries].sort((left, right) =>
    (left.ncmLatencyMs + left.latencyMs) - (right.ncmLatencyMs + right.latencyMs)
  );
  const selected: ProxyPoolEntry[] = [];
  const seenIps = new Set<string>();
  const seenNetworks = new Set<string>();
  for (const entry of fastestFirst) {
    const network = egressNetworkKey(entry.egressIp);
    if (
      !entry.ncmVerified ||
      seenIps.has(entry.egressIp) ||
      seenNetworks.has(network)
    ) continue;
    seenIps.add(entry.egressIp);
    seenNetworks.add(network);
    selected.push(entry);
    if (selected.length >= size) break;
  }
  return selected;
}

export function egressNetworkKey(value: string): string {
  const ip = value.trim().toLowerCase();
  const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
  if (mappedIpv4 && net.isIP(mappedIpv4) === 4) return ipv4NetworkKey(mappedIpv4);
  if (net.isIP(ip) === 4) return ipv4NetworkKey(ip);
  if (net.isIP(ip) === 6) {
    const hextets = expandIpv6(ip);
    return `${hextets.slice(0, 3).map((part) => Number.parseInt(part, 16).toString(16)).join(":")}::/48`;
  }
  return `invalid:${ip}`;
}

function ipv4NetworkKey(ip: string): string {
  const octets = ip.split(".");
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

function expandIpv6(ip: string): string[] {
  const [left = "", right = ""] = ip.split("::");
  const leftParts = left ? left.split(":") : [];
  const rightParts = right ? right.split(":") : [];
  const zeroCount = Math.max(0, 8 - leftParts.length - rightParts.length);
  return [...leftParts, ...Array<string>(zeroCount).fill("0"), ...rightParts];
}

export { mergeProxyDefinitions } from "./clash-profile-merge";

function fetchEgressIp(proxyEndpoint: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  throwIfPoolVerificationAborted(signal);
  const proxy = new URL(proxyEndpoint);
  return new Promise((resolveIp, reject) => {
    const transport = proxy.protocol === "https:" ? https : http;
    const authorization = proxy.username
      ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`
      : undefined;
    const request = transport.request({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: "GET",
      path: "http://api.ipify.org?format=json",
      headers: {
        Host: "api.ipify.org",
        Connection: "close",
        ...(authorization ? { "Proxy-Authorization": authorization } : {}),
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          const value = JSON.parse(body) as { ip?: unknown };
          if (
            response.statusCode !== 200 ||
            typeof value.ip !== "string" ||
            net.isIP(value.ip) === 0
          ) {
            throw new Error(`IP check returned ${response.statusCode}.`);
          }
          resolveIp(value.ip);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("IP check timed out.")));
    const abortRequest = (): void => { request.destroy(new RunCancelled()); };
    signal?.addEventListener("abort", abortRequest, { once: true });
    request.once("close", () => signal?.removeEventListener("abort", abortRequest));
    request.on("error", reject);
    request.end();
  });
}

async function verifyProxyEndpoint(
  name: string,
  endpoint: string,
  signal?: AbortSignal,
): Promise<ProxyPoolEntry> {
  throwIfPoolVerificationAborted(signal);
  const startedAt = Date.now();
  const egressIp = await fetchEgressIp(endpoint, 12_000, signal);
  throwIfPoolVerificationAborted(signal);
  const latencyMs = Date.now() - startedAt;
  const ncmStartedAt = Date.now();
  const page = await new EnhancedNcmClient({ proxy: endpoint })
    .getSongCommentsByCursor("186016", 20, 2, String(Date.now()));
  throwIfPoolVerificationAborted(signal);
  if (page.comments.length === 0) {
    throw new Error(`Proxy ${endpoint} returned no comments.`);
  }
  return {
    name,
    endpoint,
    egressIp,
    latencyMs,
    ncmLatencyMs: Date.now() - ncmStartedAt,
    ncmVerified: true,
  };
}

function throwIfPoolVerificationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RunCancelled();
}

function waitForPort(port: number, deadline: number): Promise<void> {
  return new Promise((resolvePort, reject) => {
    const attempt = (): void => {
      if (Date.now() >= deadline) {
        reject(new Error(`Listener ${port} did not start.`));
        return;
      }
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolvePort();
      });
      const retry = (): void => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Listener ${port} did not start.`));
        } else {
          setTimeout(attempt, 100);
        }
      };
      socket.once("error", retry);
      socket.once("timeout", retry);
    };
    attempt();
  });
}

export async function waitForPorts(
  ports: number[],
  timeoutMs: number,
  concurrency = 16,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await mapLimit(ports, Math.min(concurrency, ports.length), (port) =>
    waitForPort(port, deadline)
  );
}

async function mapLimit<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await operation(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function poolVerificationGate(): ProxyTransportGate {
  return new ProxyTransportGate({
    maxConcurrent: POOL_RECHECK_CONCURRENCY,
    minStartDelayMs: 80,
    startJitterMs: 0,
  });
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function managedMihomoProcessAlive(pool: ProxyPoolFile): boolean {
  return managedMihomoProcessIdentity(pool) === "verified";
}

export function managedMihomoProcessIdentity(
  pool: ProxyPoolFile,
): ManagedMihomoProcessIdentity {
  const alive = pool.pid ? isProcessAlive(pool.pid) : false;
  return classifyManagedMihomoProcess(
    pool,
    alive,
    pool.pid && alive ? processCommandLine(pool.pid) : undefined,
  );
}

async function managedMihomoProcessIdentityAsync(
  pool: ProxyPoolFile,
): Promise<ManagedMihomoProcessIdentity> {
  const alive = pool.pid ? isProcessAlive(pool.pid) : false;
  return classifyManagedMihomoProcess(
    pool,
    alive,
    pool.pid && alive ? await processCommandLineAsync(pool.pid) : undefined,
  );
}

export function classifyManagedMihomoProcess(
  pool: ProxyPoolFile,
  alive: boolean,
  commandLine: string | undefined,
): ManagedMihomoProcessIdentity {
  if (!pool.pid || !alive) return "not-running";
  if (commandLine === undefined) return "unavailable";
  if (!pool.mihomoConfigPath) return "mismatch";
  return managedMihomoCommandMatches(
    commandLine,
    pool.mihomoConfigPath,
    pool.mihomoExecutablePath,
  ) ? "verified" : "mismatch";
}

export function managedMihomoCommandMatches(
  commandLine: string,
  configPath: string,
  executablePath?: string,
): boolean {
  const normalizedCommand = normalizeCommandIdentity(commandLine);
  const normalizedConfig = normalizeCommandIdentity(configPath);
  const executable = normalizeCommandIdentity(executablePath ?? "mihomo").split("/").at(-1)!;
  const executableMatches = executablePath
    ? normalizedCommand.includes(executable)
    : /(?:^|[\s/\\])(?:verge-)?mihomo(?:\.exe)?(?:\s|$)/i.test(commandLine);
  return executableMatches && normalizedConfig.length > 0 && normalizedCommand.includes(normalizedConfig);
}

function normalizeCommandIdentity(value: string): string {
  return value.trim().replaceAll("\\", "/").replaceAll('"', "").toLowerCase();
}

function processCommandLine(pid: number): string | undefined {
  if (process.platform === "win32") {
    try {
      // Write the raw string instead of letting PowerShell format it. The
      // default formatter can wrap long AppData paths, making a valid managed
      // Mihomo command fail the exact config-path identity check. Synchronous
      // callers get only a short hint; lifecycle mutations use the async path.
      const script = `$managed = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; if ($null -ne $managed) { [Console]::Out.Write([string]$managed.CommandLine) }`;
      const output = execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ], { encoding: "utf8", timeout: 2_000, windowsHide: true });
      return output.trim() || undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function processCommandLineAsync(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") {
    const script = `$managed = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; if ($null -ne $managed) { [Console]::Out.Write([string]$managed.CommandLine) }`;
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ], { encoding: "utf8", timeout: 6_000, windowsHide: true });
      return stdout.trim() || undefined;
    } catch {
      try {
        const { stdout } = await execFileAsync("wmic.exe", [
          "process",
          "where",
          `ProcessId=${pid}`,
          "get",
          "CommandLine",
          "/value",
        ], { encoding: "utf8", timeout: 2_000, windowsHide: true });
        const line = stdout.split(/\r?\n/).find((value) => value.startsWith("CommandLine="));
        return line?.slice("CommandLine=".length).trim() || undefined;
      } catch {
        return undefined;
      }
    }
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function selectManagedPortPlan(
  options: Pick<MihomoPoolOptions, "basePort" | "controllerPort">,
  listenerCount: number,
  portOpen: (port: number) => Promise<boolean> = isLocalPortOpen,
): Promise<ManagedPortPlan> {
  if (!Number.isInteger(listenerCount) || listenerCount < 1) {
    throw new Error("At least one managed listener port is required.");
  }
  const stride = listenerCount + 17;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const basePort = options.basePort + attempt * stride;
    const listenerPorts = Array.from({ length: listenerCount }, (_, index) => basePort + index);
    const controllerPort = attempt === 0 ? options.controllerPort : basePort + listenerCount + 1;
    if (listenerPorts.at(-1)! > 65_535 || controllerPort > 65_535) break;
    if (controllerPort >= basePort && controllerPort <= listenerPorts.at(-1)!) continue;
    const occupied = await openPorts([...listenerPorts, controllerPort], portOpen);
    if (occupied.length === 0) return { basePort, listenerPorts, controllerPort };
  }
  throw new Error("没有找到可用的本地代理监听端口段；请关闭遗留代理进程后重试。");
}

async function openPorts(
  ports: readonly number[],
  portOpen: (port: number) => Promise<boolean> = isLocalPortOpen,
): Promise<number[]> {
  const checks = await Promise.all(ports.map(async (port) => ({
    port,
    open: await portOpen(port),
  })));
  return checks.filter((check) => check.open).map((check) => check.port);
}

export async function withPoolBuildLock<T>(
  poolPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(poolPath), { recursive: true });
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(poolPath, {
      realpath: false,
      retries: 0,
      stale: 120_000,
      update: 20_000,
    });
    return await operation();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new Error("另一个客户端正在构建或更新代理池，请等待该操作完成。");
    }
    throw error;
  } finally {
    await release?.().catch(() => {});
  }
}

function isLocalPortOpen(port: number): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const settle = (open: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveOpen(open);
    };
    socket.setTimeout(300);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

function normalizeProxyEndpoint(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Proxy endpoint cannot be empty.");
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Proxy endpoint must use http:// or https://: ${normalized}`);
  }
  return parsed.toString();
}

function isCommandName(path: string): boolean {
  return !path.includes("/") && !path.includes("\\");
}

async function writeProxyPool(path: string, pool: ProxyPoolFile): Promise<void> {
  await writeAtomicJson(path, pool);
}

export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return !isProcessAlive(pid);
}

export async function managedGenerationHealthy(
  pid: number,
  listenerPorts: readonly number[],
  portOpen: (port: number) => Promise<boolean> = isLocalPortOpen,
): Promise<boolean> {
  if (!isProcessAlive(pid) || listenerPorts.length === 0) return false;
  const listening = await openPorts(listenerPorts, portOpen);
  return listening.length === listenerPorts.length && isProcessAlive(pid);
}

export function defaultMihomoPoolOptions(projectRoot: string): MihomoPoolOptions {
  const discovery = discoverClashVerge();
  return {
    sourceConfigPaths: [discovery.configPath ?? discovery.configCandidates[0]],
    mihomoPath: discovery.mihomoPath ?? discovery.mihomoCandidates[0],
    workDirectory: resolve(projectRoot, ".ncm", "mihomo-pool"),
    poolPath: resolve(projectRoot, ".ncm", "proxy-pool.json"),
    basePort: 17_891,
    size: 8,
    candidateCount: 48,
    controllerPort: 19_097,
  };
}

export function discoverClashVerge(): ClashVergeDiscovery {
  const userHome = homedir();
  const roots = process.platform === "darwin"
    ? [join(userHome, "Library", "Application Support", "io.github.clash-verge-rev.clash-verge-rev")]
    : process.platform === "win32"
    ? [join(process.env.APPDATA ?? join(userHome, "AppData", "Roaming"), "io.github.clash-verge-rev.clash-verge-rev")]
    : [
      join(process.env.XDG_CONFIG_HOME ?? join(userHome, ".config"), "io.github.clash-verge-rev.clash-verge-rev"),
      join(userHome, ".local", "share", "io.github.clash-verge-rev.clash-verge-rev"),
    ];
  const configCandidates = roots.flatMap((root) => [
    join(root, "clash-verge.yaml"),
    join(root, "clash-verge-check.yaml"),
  ]);
  const profiles = uniqueProfiles(roots.flatMap((root) => readClashVergeProfiles(join(root, "profiles.yaml"))));
  const mihomoCandidates = process.platform === "darwin"
    ? [
      "/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo",
      join(userHome, "Applications", "Clash Verge.app", "Contents", "MacOS", "verge-mihomo"),
    ]
    : process.platform === "win32"
    ? [
      "C:\\Program Files\\Clash Verge\\verge-mihomo.exe",
      join(process.env.LOCALAPPDATA ?? join(userHome, "AppData", "Local"), "Programs", "Clash Verge", "verge-mihomo.exe"),
    ]
    : ["/usr/bin/verge-mihomo", "/usr/bin/mihomo", "/usr/local/bin/mihomo"];
  const configuredConfig = process.env.NCM_CLASH_CONFIG?.trim();
  const configuredMihomo = process.env.NCM_MIHOMO_PATH?.trim();
  if (configuredConfig) configCandidates.unshift(resolve(configuredConfig));
  if (configuredMihomo) mihomoCandidates.unshift(resolve(configuredMihomo));
  const configPath = configCandidates.find(existsSync)
    ?? profiles.find((profile) => profile.active)?.path
    ?? profiles[0]?.path;
  const mihomoPath = mihomoCandidates.find(existsSync);
  return {
    platform: process.platform,
    installed: Boolean(configPath && mihomoPath),
    configPath,
    mihomoPath,
    configCandidates: [...new Set(configCandidates)],
    mihomoCandidates: [...new Set(mihomoCandidates)],
    profiles,
  };
}

export function readClashVergeProfiles(indexPath: string): ClashVergeProfile[] {
  if (!existsSync(indexPath)) return [];
  try {
    const document = parse(readFileSync(indexPath, "utf8")) as YamlObject;
    const current = typeof document.current === "string" ? document.current : undefined;
    const items = Array.isArray(document.items) ? document.items : [];
    const profileRoot = resolve(dirname(indexPath), "profiles");
    return items.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const item = value as YamlObject;
      if (item.type !== "remote" && item.type !== "local") return [];
      if (typeof item.uid !== "string" || typeof item.file !== "string") return [];
      if (!/\.ya?ml$/i.test(item.file)) return [];
      const path = resolve(profileRoot, item.file);
      if (path !== profileRoot && !path.startsWith(`${profileRoot}${sep}`)) return [];
      if (!existsSync(path)) return [];
      return [{
        uid: item.uid,
        name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : item.file,
        path,
        type: item.type,
        active: item.uid === current,
      }];
    });
  } catch {
    return [];
  }
}

function uniqueProfiles(profiles: ClashVergeProfile[]): ClashVergeProfile[] {
  const seen = new Set<string>();
  return profiles.filter((profile) => {
    if (seen.has(profile.path)) return false;
    seen.add(profile.path);
    return true;
  });
}
