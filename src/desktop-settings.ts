import { readAtomicJson, writeAtomicJson } from "./atomic-file";

export type DesktopCloseBehavior = "ask" | "background" | "exit";

export interface DesktopSettings {
  version: 1;
  closeBehavior: DesktopCloseBehavior;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = Object.freeze({
  version: 1,
  closeBehavior: "ask",
});

export function decodeDesktopSettings(value: unknown): DesktopSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_DESKTOP_SETTINGS };
  }
  const candidate = value as Record<string, unknown>;
  const closeBehavior = candidate.closeBehavior;
  return {
    version: 1,
    closeBehavior: closeBehavior === "background" || closeBehavior === "exit" ? closeBehavior : "ask",
  };
}

export function parseDesktopSettingsPatch(value: unknown): Pick<DesktopSettings, "closeBehavior"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("全局设置格式错误。");
  }
  const input = value as Record<string, unknown>;
  if (input.closeBehavior !== "ask" && input.closeBehavior !== "background" && input.closeBehavior !== "exit") {
    throw new Error("关闭窗口行为无效。");
  }
  return { closeBehavior: input.closeBehavior };
}

export class DesktopSettingsStore {
  private value: DesktopSettings = { ...DEFAULT_DESKTOP_SETTINGS };
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly onLoadError?: (error: unknown) => void,
  ) {}

  async load(): Promise<DesktopSettings> {
    return this.enqueue(async () => {
      try {
        this.value = await readAtomicJson(this.path, decodeDesktopSettings) ?? { ...DEFAULT_DESKTOP_SETTINGS };
      } catch (error) {
        this.onLoadError?.(error);
        this.value = { ...DEFAULT_DESKTOP_SETTINGS };
      }
      return this.get();
    });
  }

  get(): DesktopSettings {
    return { ...this.value };
  }

  async update(patch: unknown): Promise<DesktopSettings> {
    const parsed = parseDesktopSettingsPatch(patch);
    return this.enqueue(async () => {
      const next = { ...this.value, ...parsed, version: 1 } as DesktopSettings;
      await writeAtomicJson(this.path, next);
      this.value = next;
      return this.get();
    });
  }

  async reset(): Promise<DesktopSettings> {
    return this.enqueue(async () => {
      const next = { ...DEFAULT_DESKTOP_SETTINGS };
      await writeAtomicJson(this.path, next);
      this.value = next;
      return this.get();
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
