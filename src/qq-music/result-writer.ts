import { createReadStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { qqMusicCommentKey } from "./state";
import type { QQMusicFoundComment } from "./types";

export interface QQMusicAppendFile {
  write(contents: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface QQMusicResultWriterRuntime {
  openAppendFile: (path: string) => Promise<QQMusicAppendFile>;
}

const defaultRuntime: QQMusicResultWriterRuntime = {
  openAppendFile: async (path) => {
    const file = await open(path, "a", 0o600);
    return {
      write: async (contents) => {
        const buffer = Buffer.from(contents, "utf8");
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesWritten } = await file.write(
            buffer,
            offset,
            buffer.length - offset,
            null,
          );
          if (bytesWritten <= 0) throw new Error("QQ Music JSONL write made no progress.");
          offset += bytesWritten;
        }
      },
      sync: () => file.sync(),
      close: () => file.close(),
    };
  },
};

export class QQMusicResultPersistenceError extends Error {
  constructor(
    public readonly operation: "write" | "sync",
    public readonly cause: unknown,
  ) {
    super(`QQ Music result persistence failed during ${operation}: ${errorMessage(cause)}`);
    this.name = "QQMusicResultPersistenceError";
  }
}

export class QQMusicResultWriter {
  private readonly existingKeys = new Set<string>();
  private initialized = false;
  private appendTail: Promise<void> = Promise.resolve();
  private file?: QQMusicAppendFile;
  private closed = false;
  private persistenceError?: QQMusicResultPersistenceError;

  constructor(
    private readonly path: string,
    private readonly onAppend?: (record: QQMusicFoundComment) => void,
    private readonly runtime: QQMusicResultWriterRuntime = defaultRuntime,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const input = createReadStream(this.path, { encoding: "utf8", highWaterMark: 64 * 1024 });
      const lines = createInterface({ input, crlfDelay: Infinity });
      let processed = 0;
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line) as { songId?: unknown; commentId?: unknown };
          if (item.songId !== undefined && item.commentId !== undefined) {
            this.existingKeys.add(qqMusicCommentKey(String(item.songId), String(item.commentId)));
          }
        } catch {
          // Keep a partially written final line recoverable and continue loading valid records.
        }
        processed += 1;
        if (processed % 1_000 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await ensureTrailingNewline(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.file = await this.runtime.openAppendFile(this.path);
    this.initialized = true;
  }

  async append(record: QQMusicFoundComment): Promise<boolean> {
    return (await this.appendBatch([record])).length > 0;
  }

  /** Persists every new match from one logical comment page with one write and one fsync. */
  async appendBatch(records: readonly QQMusicFoundComment[]): Promise<QQMusicFoundComment[]> {
    await this.initialize();
    if (this.closed || !this.file) throw new Error("QQ Music result writer is closed.");
    if (this.persistenceError) throw this.persistenceError;
    let added: QQMusicFoundComment[] = [];
    const write = this.appendTail.then(async () => {
      if (this.persistenceError) throw this.persistenceError;
      const pending: QQMusicFoundComment[] = [];
      const pendingKeys = new Set<string>();
      for (const record of records) {
        const key = qqMusicCommentKey(record.songId, record.commentId);
        if (this.existingKeys.has(key) || pendingKeys.has(key)) continue;
        pendingKeys.add(key);
        pending.push({
          ...record,
          commentUrl: record.commentUrl ?? qqMusicCommentUrl(record.songMid, record.songId),
        });
      }
      if (pending.length === 0) return;
      try {
        await this.file!.write(pending.map((record) => `${JSON.stringify(record)}\n`).join(""));
      } catch (cause) {
        throw this.latchPersistenceError("write", cause);
      }
      try {
        await this.file!.sync();
      } catch (cause) {
        throw this.latchPersistenceError("sync", cause);
      }
      for (const record of pending) {
        this.existingKeys.add(qqMusicCommentKey(record.songId, record.commentId));
        try { this.onAppend?.(record); } catch { /* Presentation callbacks cannot block persistence. */ }
      }
      added = pending;
    });
    this.appendTail = write.catch(() => {});
    await write;
    return added;
  }

  has(songId: string, commentId: string): boolean {
    if (!this.initialized) throw new Error("QQ Music result writer must be initialized before lookup.");
    return this.existingKeys.has(qqMusicCommentKey(songId, commentId));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.appendTail;
    const file = this.file;
    this.file = undefined;
    await file?.close();
  }

  private latchPersistenceError(
    operation: "write" | "sync",
    cause: unknown,
  ): QQMusicResultPersistenceError {
    this.persistenceError ??= new QQMusicResultPersistenceError(operation, cause);
    return this.persistenceError;
  }
}

async function ensureTrailingNewline(path: string): Promise<void> {
  const file = await open(path, "r+");
  try {
    const stats = await file.stat();
    if (stats.size === 0) return;
    const tail = Buffer.allocUnsafe(1);
    await file.read(tail, 0, 1, stats.size - 1);
    if (tail[0] === 0x0a) return;
    await file.write(Buffer.from("\n"), 0, 1, stats.size);
    await file.sync();
  } finally {
    await file.close();
  }
}

export function qqMusicCommentUrl(songMid: string | undefined, songId: string): string {
  const resource = songMid?.trim() || songId;
  return `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(resource)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
