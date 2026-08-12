export type WindowsUpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "downloading"
  | "downloaded"
  | "error";

export interface WindowsUpdateState {
  supported: boolean;
  phase: WindowsUpdatePhase;
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseDate?: string;
  releaseNotes?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  error?: string;
}

export interface WindowsUpdaterBackend {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

interface UpdateInfoLike {
  version?: unknown;
  releaseName?: unknown;
  releaseDate?: unknown;
  releaseNotes?: unknown;
}

interface ProgressInfoLike {
  percent?: unknown;
  transferred?: unknown;
  total?: unknown;
  bytesPerSecond?: unknown;
}

export function isWindowsAutoUpdateSupported(platform: NodeJS.Platform, packaged: boolean): boolean {
  return platform === "win32" && packaged;
}

export function unsupportedWindowsUpdateState(currentVersion: string): WindowsUpdateState {
  return { supported: false, phase: "unsupported", currentVersion };
}

export class WindowsUpdateController {
  private state: WindowsUpdateState;

  constructor(
    private readonly updater: WindowsUpdaterBackend,
    currentVersion: string,
    private readonly publishState: (state: WindowsUpdateState) => void,
  ) {
    this.state = { supported: true, phase: "idle", currentVersion };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    this.bindEvents();
  }

  getState(): WindowsUpdateState {
    return { ...this.state };
  }

  async check(): Promise<WindowsUpdateState> {
    if (["checking", "downloading", "downloaded"].includes(this.state.phase)) return this.getState();
    this.setState({
      ...this.state,
      supported: true,
      phase: "checking",
      error: undefined,
      percent: undefined,
      transferred: undefined,
      total: undefined,
      bytesPerSecond: undefined,
    });
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.fail(error);
    }
    return this.getState();
  }

  async download(): Promise<WindowsUpdateState> {
    if (this.state.phase === "downloading" || this.state.phase === "downloaded") return this.getState();
    if (this.state.phase !== "available") throw new Error("当前没有可下载的 Windows 更新。");
    this.setState({ ...this.state, phase: "downloading", percent: 0, transferred: 0 });
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.fail(error);
    }
    return this.getState();
  }

  install(): void {
    if (this.state.phase !== "downloaded") throw new Error("更新尚未下载完成。");
    this.updater.quitAndInstall(true, true);
  }

  private bindEvents(): void {
    this.updater.on("checking-for-update", () => {
      this.setState({
        ...this.state,
        supported: true,
        phase: "checking",
        error: undefined,
        percent: undefined,
        transferred: undefined,
        total: undefined,
        bytesPerSecond: undefined,
      });
    });
    this.updater.on("update-available", (info: UpdateInfoLike) => {
      this.setState({
        supported: true,
        phase: "available",
        currentVersion: this.state.currentVersion,
        ...releaseFields(info),
      });
    });
    this.updater.on("update-not-available", () => {
      this.setState({
        supported: true,
        phase: "up-to-date",
        currentVersion: this.state.currentVersion,
      });
    });
    this.updater.on("download-progress", (progress: ProgressInfoLike) => {
      this.setState({
        ...this.state,
        phase: "downloading",
        percent: clampPercent(progress.percent),
        transferred: finiteNumber(progress.transferred),
        total: finiteNumber(progress.total),
        bytesPerSecond: finiteNumber(progress.bytesPerSecond),
      });
    });
    this.updater.on("update-downloaded", (info: UpdateInfoLike) => {
      this.setState({
        ...this.state,
        phase: "downloaded",
        ...releaseFields(info),
        percent: 100,
      });
    });
    this.updater.on("error", (error: unknown) => this.fail(error));
  }

  private fail(error: unknown): void {
    this.setState({
      ...this.state,
      phase: "error",
      error: safeErrorMessage(error),
    });
  }

  private setState(state: WindowsUpdateState): void {
    this.state = state;
    this.publishState(this.getState());
  }
}

function releaseFields(info: UpdateInfoLike = {}): Partial<Pick<WindowsUpdateState, "latestVersion" | "releaseName" | "releaseDate" | "releaseNotes">> {
  const fields: Partial<Pick<WindowsUpdateState, "latestVersion" | "releaseName" | "releaseDate" | "releaseNotes">> = {};
  const latestVersion = textValue(info.version);
  const releaseName = textValue(info.releaseName);
  const releaseDate = textValue(info.releaseDate);
  const releaseNotes = normalizeReleaseNotes(info.releaseNotes);
  if (latestVersion) fields.latestVersion = latestVersion;
  if (releaseName) fields.releaseName = releaseName;
  if (releaseDate) fields.releaseDate = releaseDate;
  if (releaseNotes) fields.releaseNotes = releaseNotes;
  return fields;
}

function normalizeReleaseNotes(value: unknown): string | undefined {
  if (typeof value === "string") return plainReleaseNote(value) || undefined;
  if (!Array.isArray(value)) return undefined;
  const notes = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || !("note" in entry)) return [];
    const rawNote = (entry as { note?: unknown }).note;
    const note = typeof rawNote === "string" ? plainReleaseNote(rawNote) : undefined;
    return note ? [note] : [];
  });
  return notes.length > 0 ? notes.join("\n\n") : undefined;
}

function plainReleaseNote(value: string): string {
  const decoded = decodeHtmlEntities(value);
  return decoded
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*li\b[^>]*>/gi, "\n• ")
    .replace(/<\s*\/\s*(?:p|div|li|h[1-6]|ul|ol|blockquote|pre|section|article)\s*>/gi, "\n")
    .replace(/<(?:"[^"]*"|'[^']*'|[^'">])*>/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    bull: "•",
    gt: ">",
    hellip: "…",
    lt: "<",
    mdash: "—",
    middot: "·",
    nbsp: " ",
    ndash: "–",
    quot: "\"",
  };
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    decoded = decoded.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, reference: string) => {
      if (!reference.startsWith("#")) return named[reference.toLowerCase()] ?? entity;
      const hexadecimal = reference[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(reference.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return entity;
      }
      return String.fromCodePoint(codePoint);
    });
  }
  return decoded;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function clampPercent(value: unknown): number {
  const number = finiteNumber(value) ?? 0;
  return Math.max(0, Math.min(100, number));
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").trim().slice(0, 500) || "Windows 更新失败。";
}
