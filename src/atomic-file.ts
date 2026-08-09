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
  signal?: AbortSignal;
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
  await writeAtomicContents(path, contents, options);
}

export async function writeAtomicBuffer(
  path: string,
  contents: Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await writeAtomicContents(path, contents, options);
}

async function writeAtomicContents(
  path: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions,
): Promise<void> {
  options.signal?.throwIfAborted();
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
  let completedRename = false;
  try {
    options.signal?.throwIfAborted();
    file = await open(temporary, "wx", 0o600);
    options.signal?.throwIfAborted();
    if (typeof contents === "string") await file.writeFile(contents, "utf8");
    else await file.writeFile(contents);
    options.signal?.throwIfAborted();
    await file.sync();
    options.signal?.throwIfAborted();
    await file.close();
    file = undefined;
    completedWrite = true;
    options.signal?.throwIfAborted();
    await renameWithRetry(temporary, path, options);
    completedRename = true;
  } catch (error) {
    await file?.close().catch(() => {});
    if (!completedRename && (!completedWrite || options.signal?.aborted)) {
      await unlink(temporary).catch(() => {});
    }
    if (options.signal?.aborted) throw error;
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

/** Removes one atomic document and only the recovery files owned by that document. */
export async function removeAtomicFile(path: string): Promise<void> {
  const directory = dirname(path);
  const targetName = basename(path);
  const legacyName = `${targetName}.tmp`;
  const prefix = `${targetName}.tmp-`;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => entry.isFile() && (
      entry.name === targetName || entry.name === legacyName || entry.name.startsWith(prefix)
    ))
    .map((entry) => unlink(join(directory, entry.name)).catch((error) => {
      if (!isMissing(error)) throw error;
    })));
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
    options.signal?.throwIfAborted();
    try {
      await renameFile(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_RENAME_CODES.has(code) || attempt >= delays.length) {
        throw new AtomicWriteError(code);
      }
      await abortableSleep(delays[attempt], options.signal, sleep);
    }
  }
}

function abortableSleep(
  milliseconds: number,
  signal: AbortSignal | undefined,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  if (!signal) return sleep(milliseconds);
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(milliseconds).then(
      () => { signal.removeEventListener("abort", onAbort); resolve(); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
