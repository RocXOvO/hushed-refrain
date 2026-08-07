export type ProxyDefinition = Record<string, unknown>;

export function inlineProxyDefinitions(config: unknown): ProxyDefinition[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Clash Verge 配置格式错误。");
  }
  const source = config as Record<string, unknown>;
  if (hasEntries(source["proxy-providers"])) {
    throw new Error("暂不支持合并 proxy-providers；请选择 Clash Verge 已物化节点的合并配置。");
  }
  const proxies = Array.isArray(source.proxies)
    ? source.proxies.filter(isProxyDefinition)
    : [];
  if (proxies.length === 0) {
    throw new Error("Clash Verge 配置未包含内联代理节点。");
  }
  if (proxies.some((proxy) => typeof proxy["dialer-proxy"] === "string" || typeof proxy["underlying-proxy"] === "string")) {
    throw new Error("暂不支持合并链式代理节点；请选择不依赖 dialer-proxy 的配置。");
  }
  return proxies;
}

export function selectProxyCandidates(proxyGroups: unknown[][], limit: number): ProxyDefinition[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  return mergeProxyDefinitions(proxyGroups).slice(0, limit);
}

export function mergeProxyDefinitions(proxyGroups: unknown[][]): ProxyDefinition[] {
  const orderedGroups = proxyGroups.map((values) => diverseOrder(values.filter(isProxyDefinition)));
  const merged: ProxyDefinition[] = [];
  const seenConnections = new Set<string>();
  const usedNames = new Set<string>();
  const maximumDepth = orderedGroups.reduce((maximum, group) => Math.max(maximum, group.length), 0);

  for (let depth = 0; depth < maximumDepth; depth += 1) {
    for (const [groupIndex, group] of orderedGroups.entries()) {
      const value = group[depth];
      if (!value) continue;
      const proxy = structuredClone(value);
      const connection = { ...proxy };
      delete connection.name;
      const signature = stableValue(connection);
      if (seenConnections.has(signature)) continue;
      seenConnections.add(signature);

      const originalName = String(proxy.name).trim();
      let name = originalName;
      if (usedNames.has(name)) {
        const suffix = ` · 配置 ${groupIndex + 1}`;
        name = `${originalName}${suffix}`;
        let duplicate = 2;
        while (usedNames.has(name)) {
          name = `${originalName}${suffix} (${duplicate})`;
          duplicate += 1;
        }
      }
      proxy.name = name;
      usedNames.add(name);
      merged.push(proxy);
    }
  }
  return merged;
}

function diverseOrder(proxies: ProxyDefinition[]): ProxyDefinition[] {
  const groups = new Map<string, ProxyDefinition[]>();
  for (const proxy of proxies) {
    const name = String(proxy.name);
    if (/剩余|流量|到期|官网|套餐|更新|订阅/i.test(name)) continue;
    const region = name.trim().split(/\s+/)[0] || "other";
    const group = groups.get(region) ?? [];
    group.push(proxy);
    groups.set(region, group);
  }
  const ordered: ProxyDefinition[] = [];
  let depth = 0;
  while (true) {
    let added = false;
    for (const group of groups.values()) {
      const proxy = group[depth];
      if (!proxy) continue;
      ordered.push(proxy);
      added = true;
    }
    if (!added) return ordered;
    depth += 1;
  }
}

function isProxyDefinition(value: unknown): value is ProxyDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proxy = value as ProxyDefinition;
  return typeof proxy.name === "string" && proxy.name.trim().length > 0 && typeof proxy.type === "string";
}

function hasEntries(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
