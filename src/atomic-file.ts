import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const RETRYABLE_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const DEFAULT_RENAME_RETRY_DELAYS_MS = [20, 50, 100, 200, 400, 800, 1_600] as const;

type RenameFile = (source: string, destination: string) => Promise<void>;

export interface AtomicWriteOptions {
  renameFile?: RenameFile;
  retryDelaysMs?: readonly number[];
  randomId?: () => string;
  pid?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class AtomicWriteError extends Error {
  readonly code?: string;
  readonly recoverable: boolean;

  constructor(code?: string, recoverable = true) {
    super(
      recoverable
        ? `原子保存失败${code ? `（${code}）` : ""}：文件可能被其他客户端或安全软件短暂占用；`
          + "正式检查点未被删除，最新内容已保留为可恢复临时文件。请关闭重复客户端后重试。"
        : `检查点写入失败${code ? `（${code}）` : ""}：正式文件未被修改，本次未完整的临时文件已清理。`,
    );
    this.name = "AtomicWriteError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export async function writeAtomicJson(
  path: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await writeAtomicText(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function writeAtomicText(
  path: string,
  contents: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = dirname(path);
  try {
    await mkdir(directory, { recursive: true });
  } catch (error) {
    throw new AtomicWriteError((error as NodeJS.ErrnoException).code, false);
  }
  const temporary = join(
    directory,
    `${basename(path)}.tmp-${options.pid ?? process.pid}-${(options.randomId ?? randomUUID)()}`,
  );
  let file;
  let completedWrite = false;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(contents, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    completedWrite = true;
    await renameWithRetry(temporary, path, options);
  } catch (error) {
    await file?.close().catch(() => {});
    if (!completedWrite) await unlink(temporary).catch(() => {});
    if (error instanceof AtomicWriteError) throw error;
    throw new AtomicWriteError((error as NodeJS.ErrnoException).code, completedWrite);
  }
}

export async function readAtomicJson<T>(
  path: string,
  decode: (value: unknown) => T,
): Promise<T | undefined> {
  const candidates = await atomicCandidates(path);
  let primaryError: unknown;
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(candidate.path, "utf8")) as unknown;
    } catch (error) {
      if (candidate.primary && !isMissing(error)) primaryError = error;
      continue;
    }
    // The newest syntactically complete JSON document is authoritative.
    // Falling back after a schema/decode failure would silently roll state
    // back and could overwrite a future-version checkpoint.
    return decode(parsed);
  }
  if (primaryError) throw primaryError;
  return undefined;
}

async function atomicCandidates(path: string): Promise<Array<{ path: string; mtimeMs: number; primary: boolean }>> {
  const directory = dirname(path);
  const targetName = basename(path);
  const legacyName = `${targetName}.tmp`;
  const prefix = `${targetName}.tmp-`;
  const candidates: Array<{ path: string; mtimeMs: number; primary: boolean }> = [];

  try {
    const targetStat = await stat(path);
    if (targetStat.isFile()) candidates.push({ path, mtimeMs: targetStat.mtimeMs, primary: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  try {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && (entry.name === legacyName || entry.name.startsWith(prefix)))
      .map(async (entry) => {
        const candidatePath = join(directory, entry.name);
        try {
          const candidateStat = await stat(candidatePath);
          candidates.push({ path: candidatePath, mtimeMs: candidateStat.mtimeMs, primary: false });
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  return candidates.sort((left, right) =>
    right.mtimeMs - left.mtimeMs || Number(right.primary) - Number(left.primary)
  );
}

async function renameWithRetry(
  source: string,
  destination: string,
  options: AtomicWriteOptions,
): Promise<void> {
  const renameFile = options.renameFile ?? rename;
  const delays = options.retryDelaysMs ?? DEFAULT_RENAME_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? delay;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_RENAME_CODES.has(code) || attempt >= delays.length) {
        throw new AtomicWriteError(code);
      }
      await sleep(delays[attempt]);
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
