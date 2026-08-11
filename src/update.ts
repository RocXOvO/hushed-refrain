export const DEFAULT_UPDATE_REPOSITORY = "RocXOvO/hushed-refrain";

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

interface GitHubRelease {
  tag_name: string;
  name?: string;
  html_url: string;
  body?: string | null;
  published_at?: string | null;
  assets?: GitHubReleaseAsset[];
}

export interface UpdateSnapshot {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  platform: NodeJS.Platform;
  arch: string;
  releaseName: string;
  releaseUrl: string;
  publishedAt?: string;
  notes?: string;
  assetName?: string;
  assetSize?: number;
  downloadUrl?: string;
  checkedAt: string;
}

export interface CheckForUpdateOptions {
  currentVersion: string;
  platform?: NodeJS.Platform;
  arch?: string;
  repository?: string;
  timeoutMs?: number;
  token?: string;
  fetchImpl?: typeof fetch;
}

export async function checkForUpdate(options: CheckForUpdateOptions): Promise<UpdateSnapshot> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const repository = options.repository ?? DEFAULT_UPDATE_REPOSITORY;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);

  try {
    const token = options.token ?? process.env.NCM_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": `${repository.replace("/", "-")}-update-checker`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers,
      signal: controller.signal,
    });
    let release: GitHubRelease;
    if (response.ok) {
      release = await response.json() as GitHubRelease;
    } else {
      try {
        release = await releaseFromPublicPage(repository, fetchImpl, controller.signal);
      } catch {
        throw new Error(`GitHub Release 检查失败（HTTP ${response.status}）。私有仓库需配置 NCM_GITHUB_TOKEN。`);
      }
    }
    if (!release.tag_name || !release.html_url) throw new Error("GitHub Release 返回的数据不完整。");

    const currentVersion = normalizeVersion(options.currentVersion);
    const latestVersion = normalizeVersion(release.tag_name);
    const asset = selectReleaseAsset(release.assets ?? [], platform, arch);
    return {
      currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      platform,
      arch,
      releaseName: release.name?.trim() || `v${latestVersion}`,
      releaseUrl: release.html_url,
      publishedAt: release.published_at ?? undefined,
      notes: release.body?.trim() || undefined,
      assetName: asset?.name,
      assetSize: asset?.size,
      downloadUrl: asset?.browser_download_url,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function releaseFromPublicPage(
  repository: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<GitHubRelease> {
  const headers = { "User-Agent": `${repository.replace("/", "-")}-update-checker` };
  const latest = await fetchImpl(`https://github.com/${repository}/releases/latest`, { headers, signal });
  if (!latest.ok) throw new Error(`GitHub Release 页面检查失败（HTTP ${latest.status}）。`);
  const tagMatch = latest.url.match(/\/releases\/tag\/([^/?#]+)/);
  if (!tagMatch) throw new Error("GitHub Release 页面未返回最新版本标签。");
  const tag = decodeURIComponent(tagMatch[1]);
  const releaseUrl = `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`;
  const expanded = await fetchImpl(`https://github.com/${repository}/releases/expanded_assets/${encodeURIComponent(tag)}`, { headers, signal });
  const assets = expanded.ok ? releaseAssetsFromHtml(await expanded.text()) : [];
  return { tag_name: tag, name: tag, html_url: releaseUrl, assets };
}

function releaseAssetsFromHtml(html: string): GitHubReleaseAsset[] {
  const seen = new Set<string>();
  return [...html.matchAll(/href="([^"]*\/releases\/download\/[^"]+)"/g)].flatMap((match) => {
    try {
      const url = new URL(match[1].replaceAll("&amp;", "&"), "https://github.com").toString();
      if (seen.has(url)) return [];
      seen.add(url);
      const name = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
      return name ? [{ name, browser_download_url: url }] : [];
    } catch {
      return [];
    }
  });
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function selectReleaseAsset(
  assets: GitHubReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
): GitHubReleaseAsset | undefined {
  const candidates = assets.filter((asset) => !/\.(?:blockmap|ya?ml)$/i.test(asset.name));
  if (platform === "darwin") {
    const images = candidates.filter((asset) => asset.name.toLowerCase().endsWith(".dmg"));
    if (arch === "arm64") return images.find((asset) => /(?:arm64|aarch64)/i.test(asset.name));
    if (arch === "x64") {
      return images.find((asset) => /(?:x64|x86[_-]?64|amd64)/i.test(asset.name))
        ?? images.find((asset) => !/(?:arm64|aarch64)/i.test(asset.name));
    }
    return undefined;
  }
  if (platform === "win32") {
    const installers = candidates.filter((asset) => /\.(?:exe|msi)$/i.test(asset.name));
    if (arch === "arm64") return installers.find((asset) => /(?:arm64|aarch64)/i.test(asset.name));
    if (arch === "x64") {
      return installers.find((asset) => /(?:x64|x86[_-]?64|amd64)/i.test(asset.name))
        ?? installers.find((asset) => !/(?:arm64|aarch64)/i.test(asset.name));
    }
  }
  return undefined;
}

function normalizeVersion(value: string): string {
  const match = value.trim().match(/^v?(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)/);
  if (!match) throw new Error(`无法识别版本号：${value}`);
  return match[1];
}

function parseVersion(value: string): { numbers: [number, number, number]; prerelease?: string } {
  const normalized = normalizeVersion(value);
  const [core, prerelease] = normalized.split("-", 2);
  const values = core.split(".").map(Number);
  return { numbers: [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0], prerelease };
}

function comparePrerelease(left: string, right: string): number {
  const a = left.split(".");
  const b = right.split(".");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    if (a[index] === b[index]) continue;
    const aNumber = /^\d+$/.test(a[index]) ? Number(a[index]) : undefined;
    const bNumber = /^\d+$/.test(b[index]) ? Number(b[index]) : undefined;
    if (aNumber !== undefined && bNumber !== undefined) return aNumber > bNumber ? 1 : -1;
    if (aNumber !== undefined) return -1;
    if (bNumber !== undefined) return 1;
    return a[index].localeCompare(b[index]);
  }
  return 0;
}
