import { open } from "node:fs/promises";
import { createInterface } from "node:readline";

export interface JsonlSnapshotOptions {
  maxBytes?: number;
  maxRecords?: number;
}

export interface JsonlSnapshot<T> {
  byteLimit: number;
  records: T[];
  skippedLines: number;
}

export class JsonlSnapshotLimitError extends Error {
  constructor(readonly limit: "bytes" | "records") {
    super(limit === "bytes"
      ? "结果文件过大，当前版本无法安全生成单份 PDF；请缩小任务范围后重试。"
      : "命中结果过多，当前版本无法安全生成单份 PDF；请缩小任务范围后重试。");
    this.name = "JsonlSnapshotLimitError";
  }
}

/** Reads the complete, append-only JSONL prefix visible when the file is opened. */
export async function readJsonlSnapshot<T>(
  path: string | undefined,
  options: JsonlSnapshotOptions = {},
): Promise<T[]> {
  return (await readJsonlSnapshotDetails<T>(path, options)).records;
}

export async function readJsonlSnapshotDetails<T>(
  path: string | undefined,
  options: JsonlSnapshotOptions = {},
): Promise<JsonlSnapshot<T>> {
  if (!path) return { byteLimit: 0, records: [], skippedLines: 0 };
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { byteLimit: 0, records: [], skippedLines: 0 };
    }
    throw error;
  }
  try {
    const { size } = await file.stat();
    if (options.maxBytes !== undefined && size > options.maxBytes) {
      throw new JsonlSnapshotLimitError("bytes");
    }
    if (size === 0) return { byteLimit: 0, records: [], skippedLines: 0 };
    const input = file.createReadStream({
      start: 0,
      end: size - 1,
      encoding: "utf8",
      autoClose: false,
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    const results: T[] = [];
    let skippedLines = 0;
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as T;
        if (options.maxRecords !== undefined && results.length >= options.maxRecords) {
          throw new JsonlSnapshotLimitError("records");
        }
        results.push(parsed);
      } catch (error) {
        if (error instanceof JsonlSnapshotLimitError) throw error;
        skippedLines += 1;
        // Ignore an incomplete trailing write; the next export can include it.
      }
    }
    return { byteLimit: size, records: results, skippedLines };
  } finally {
    await file.close();
  }
}
