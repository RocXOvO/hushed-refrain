import { closeSync, existsSync, openSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { EnhancedNcmClient } from "./api";

const execFileAsync = promisify(execFile);

type YamlObject = Record<string, unknown>;

export interface MihomoPoolOptions {
  sourceConfigPath: string;
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
  source: ProxyPoolSource;
  active: boolean;
  sourceConfigPath?: string;
  mihomoConfigPath?: string;
  pid?: number;
  entries: ProxyPoolEntry[];
}

export interface ClashVergeDiscovery {
  platform: NodeJS.Platform;
  installed: boolean;
  configPath?: string;
  mihomoPath?: string;
  configCandidates: string[];
  mihomoCandidates: string[];
}

export async function startMihomoPool(
  options: MihomoPoolOptions,
): Promise<ProxyPoolFile> {
  const previous = await readProxyPool(options.poolPath);
  if (previous?.pid && isProcessAlive(previous.pid)) {
    process.kill(previous.pid);
    await waitForProcessExit(previous.pid, 5_000);
  }

  if (!existsSync(options.sourceConfigPath)) {
    throw new Error(`Clash Verge config was not found: ${options.sourceConfigPath}`);
  }
  if (!existsSync(options.mihomoPath) && !isCommandName(options.mihomoPath)) {
    throw new Error(`Mihomo executable was not found: ${options.mihomoPath}`);
  }

  const source = parse(await readFile(options.sourceConfigPath, "utf8")) as YamlObject;
  const proxies = Array.isArray(source.proxies)
    ? source.proxies.filter(isProxyDefinition)
    : [];
  const candidates = diverseCandidates(proxies, options.candidateCount);
  if (candidates.length < options.size) {
    throw new Error(`Only ${candidates.length} proxy candidates are available.`);
  }

  await mkdir(options.workDirectory, { recursive: true });
  const configPath = join(options.workDirectory, "config.yaml");
  const logPath = join(options.workDirectory, "mihomo.log");
  const config = {
    "log-level": "warning",
    "allow-lan": false,
    ipv6: false,
    mode: "rule",
    "external-controller": `127.0.0.1:${options.controllerPort}`,
    secret: "ncm-pool-local",
    tun: { enable: false },
    dns: { enable: false },
    proxies: candidates,
    listeners: candidates.map((proxy, index) => ({
      name: `ncm-pool-${index + 1}`,
      type: "mixed",
      listen: "127.0.0.1",
      port: options.basePort + index,
      proxy: String(proxy.name),
      users: [],
    })),
    rules: ["MATCH,DIRECT"],
  };
  await writeFile(configPath, stringify(config, { lineWidth: 0 }), "utf8");
  if (process.platform !== "win32") await chmod(configPath, 0o600);
  await execFileAsync(options.mihomoPath, [
    "-t",
    "-d",
    options.workDirectory,
    "-f",
    configPath,
  ], { windowsHide: true, timeout: 30_000 });

  const output = openSync(logPath, "a");
  const child = spawn(options.mihomoPath, [
    "-d",
    options.workDirectory,
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

  try {
    await Promise.all(candidates.map((_, index) =>
      waitForPort(options.basePort + index, 15_000)
    ));
    const checks = await mapLimit(candidates, 6, async (proxy, index) => {
      const endpoint = `http://127.0.0.1:${options.basePort + index}`;
      const startedAt = Date.now();
      try {
        const egressIp = await fetchEgressIp(endpoint, 12_000);
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
        const page = await new EnhancedNcmClient({ proxy: check.endpoint })
          .getSongCommentsByCursor("186016", 20, 2, String(Date.now()));
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
        `Verified ${distinct.length} distinct NetEase-capable egress IPs; requested ${options.size}.`,
      );
    }
    const pool: ProxyPoolFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      source: "clash-verge",
      active: true,
      sourceConfigPath: options.sourceConfigPath,
      mihomoConfigPath: configPath,
      pid: child.pid,
      entries: distinct,
    };
    await writeProxyPool(options.poolPath, pool);
    return pool;
  } catch (error) {
    if (isProcessAlive(child.pid)) process.kill(child.pid);
    throw error;
  }
}

export async function stopMihomoPool(poolPath: string): Promise<boolean> {
  const pool = await readProxyPool(poolPath);
  if (!pool || !pool.active) return false;
  if (pool.pid && isProcessAlive(pool.pid)) {
    process.kill(pool.pid);
    await waitForProcessExit(pool.pid, 5_000);
  }
  pool.active = false;
  await writeProxyPool(poolPath, pool);
  return true;
}

export async function readProxyPool(path: string): Promise<ProxyPoolFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ProxyPoolFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error("Unsupported proxy pool file.");
    }
    parsed.source ??= parsed.sourceConfigPath ? "clash-verge" : "external";
    parsed.active ??= true;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function proxyPoolRunning(pool: ProxyPoolFile | undefined): boolean {
  if (!pool?.active || pool.entries.length === 0) return false;
  return pool.source === "external" || Boolean(pool.pid && isProcessAlive(pool.pid));
}

export async function importExternalProxyPool(
  endpoints: string[],
  poolPath: string,
  size = 0,
): Promise<ProxyPoolFile> {
  const normalized = [...new Set(endpoints.map(normalizeProxyEndpoint))];
  if (normalized.length === 0) {
    throw new Error("At least one HTTP/HTTPS proxy endpoint is required.");
  }
  const checked = await mapLimit(normalized, Math.min(6, normalized.length), async (endpoint, index) => {
    try {
      return await verifyProxyEndpoint(`external-${index + 1}`, endpoint);
    } catch {
      return undefined;
    }
  });
  const verified = checked.filter((entry): entry is ProxyPoolEntry => entry !== undefined);
  const selected = selectFastestDistinct(verified, size > 0 ? size : verified.length);
  if (selected.length === 0) {
    throw new Error("None of the supplied proxies could reach both the IP service and NetEase comments.");
  }
  const pool: ProxyPoolFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "external",
    active: true,
    entries: selected,
  };
  await writeProxyPool(poolPath, pool);
  return pool;
}

export async function verifyProxyPool(pool: ProxyPoolFile): Promise<ProxyPoolEntry[]> {
  if (!proxyPoolRunning(pool)) throw new Error("The proxy pool is not active.");
  const checked = await mapLimit(pool.entries, pool.entries.length, (entry) =>
    verifyProxyEndpoint(entry.name, entry.endpoint)
  );
  const distinct = selectFastestDistinct(checked, pool.entries.length);
  if (distinct.length !== pool.entries.length) {
    throw new Error("The proxy pool no longer has distinct egress IPs.");
  }
  return distinct;
}

export function selectFastestDistinct(
  entries: ProxyPoolEntry[],
  size: number,
): ProxyPoolEntry[] {
  const fastestFirst = [...entries].sort((left, right) =>
    (left.ncmLatencyMs + left.latencyMs) - (right.ncmLatencyMs + right.latencyMs)
  );
  const selected: ProxyPoolEntry[] = [];
  const seenIps = new Set<string>();
  for (const entry of fastestFirst) {
    if (!entry.ncmVerified || seenIps.has(entry.egressIp)) continue;
    seenIps.add(entry.egressIp);
    selected.push(entry);
    if (selected.length >= size) break;
  }
  return selected;
}

function diverseCandidates(proxies: YamlObject[], limit: number): YamlObject[] {
  const groups = new Map<string, YamlObject[]>();
  for (const proxy of proxies) {
    const name = String(proxy.name);
    if (/剩余|流量|到期|官网|套餐|更新|订阅/i.test(name)) continue;
    const region = name.trim().split(/\s+/)[0] || "other";
    const group = groups.get(region) ?? [];
    group.push(proxy);
    groups.set(region, group);
  }
  const selected: YamlObject[] = [];
  let depth = 0;
  while (selected.length < limit) {
    let added = false;
    for (const group of groups.values()) {
      const proxy = group[depth];
      if (!proxy) continue;
      selected.push(proxy);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
    depth += 1;
  }
  return selected;
}

function isProxyDefinition(value: unknown): value is YamlObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proxy = value as YamlObject;
  return typeof proxy.name === "string" && typeof proxy.type === "string";
}

function fetchEgressIp(proxyEndpoint: string, timeoutMs: number): Promise<string> {
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
          if (response.statusCode !== 200 || typeof value.ip !== "string") {
            throw new Error(`IP check returned ${response.statusCode}.`);
          }
          resolveIp(value.ip);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("IP check timed out.")));
    request.on("error", reject);
    request.end();
  });
}

async function verifyProxyEndpoint(
  name: string,
  endpoint: string,
): Promise<ProxyPoolEntry> {
  const startedAt = Date.now();
  const egressIp = await fetchEgressIp(endpoint, 12_000);
  const latencyMs = Date.now() - startedAt;
  const ncmStartedAt = Date.now();
  const page = await new EnhancedNcmClient({ proxy: endpoint })
    .getSongCommentsByCursor("186016", 20, 2, String(Date.now()));
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

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePort, reject) => {
    const attempt = (): void => {
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

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(pool, null, 2)}\n`, "utf8");
  if (process.platform !== "win32") await chmod(path, 0o600);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

export function defaultMihomoPoolOptions(projectRoot: string): MihomoPoolOptions {
  const discovery = discoverClashVerge();
  return {
    sourceConfigPath: discovery.configPath ?? discovery.configCandidates[0],
    mihomoPath: discovery.mihomoPath ?? discovery.mihomoCandidates[0],
    workDirectory: resolve(projectRoot, ".ncm", "mihomo-pool"),
    poolPath: resolve(projectRoot, ".ncm", "proxy-pool.json"),
    basePort: 17_891,
    size: 4,
    candidateCount: 24,
    controllerPort: 19_097,
  };
}

export function discoverClashVerge(): ClashVergeDiscovery {
  const userHome = homedir();
  const configCandidates = process.platform === "darwin"
    ? [
      join(userHome, "Library", "Application Support", "io.github.clash-verge-rev.clash-verge-rev", "clash-verge.yaml"),
      join(userHome, "Library", "Application Support", "io.github.clash-verge-rev.clash-verge-rev", "clash-verge-check.yaml"),
    ]
    : process.platform === "win32"
    ? [
      join(process.env.APPDATA ?? join(userHome, "AppData", "Roaming"), "io.github.clash-verge-rev.clash-verge-rev", "clash-verge.yaml"),
    ]
    : [
      join(process.env.XDG_CONFIG_HOME ?? join(userHome, ".config"), "io.github.clash-verge-rev.clash-verge-rev", "clash-verge.yaml"),
      join(userHome, ".local", "share", "io.github.clash-verge-rev.clash-verge-rev", "clash-verge.yaml"),
    ];
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
  const configPath = configCandidates.find(existsSync);
  const mihomoPath = mihomoCandidates.find(existsSync);
  return {
    platform: process.platform,
    installed: Boolean(configPath && mihomoPath),
    configPath,
    mihomoPath,
    configCandidates: [...new Set(configCandidates)],
    mihomoCandidates: [...new Set(mihomoCandidates)],
  };
}
