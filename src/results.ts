import { createReadStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { FoundComment } from "./types";

export interface JsonlAppendFile {
  write(contents: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface JsonlResultWriterRuntime {
  openAppendFile(path: string): Promise<JsonlAppendFile>;
}

export class JsonlResultPersistenceError extends Error {
  constructor(
    readonly operation: "write" | "sync",
    options: { cause: unknown },
  ) {
    super(`JSONL result ${operation} failed.`, options);
    this.name = "JsonlResultPersistenceError";
  }
}

const defaultRuntime: JsonlResultWriterRuntime = {
  async openAppendFile(path) {
    const file = await open(path, "a+", 0o600);
    return {
      async write(contents) {
        const buffer = Buffer.from(contents, "utf8");
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, null);
          if (bytesWritten <= 0) throw new Error("JSONL result write made no progress.");
          offset += bytesWritten;
        }
      },
      async sync() {
        await file.sync();
      },
      async close() {
        await file.close();
      },
    };
  },
};

export class JsonlResultWriter {
  private readonly existingIds = new Set<string>();
  private initialized = false;
  private initialization?: Promise<void>;
  private appendTail: Promise<void> = Promise.resolve();
  private file?: JsonlAppendFile;
  private persistenceError?: JsonlResultPersistenceError;
  private closing?: Promise<void>;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly onAppend?: (record: FoundComment) => void,
    private readonly initializationYield: () => Promise<void> = yieldToEventLoop,
    private readonly runtime: JsonlResultWriterRuntime = defaultRuntime,
  ) {}

  async initialize(): Promise<void> {
    if (this.closed) throw new Error("JSONL result writer is closed.");
    if (this.initialized) return;
    this.initialization ??= this.initializeInternal();
    await this.initialization;
  }

  private async initializeInternal(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    let needsTrailingNewline = false;
    try {
      const input = createReadStream(this.path, { encoding: "utf8", highWaterMark: 64 * 1024 });
      const lines = createInterface({ input, crlfDelay: Infinity });
      let processed = 0;
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line) as { commentId?: unknown };
          if (item.commentId !== undefined) this.existingIds.add(String(item.commentId));
        } catch {
          // Keep the damaged tail for diagnosis. A durable newline is inserted
          // before the next record so future valid JSONL rows remain readable.
        }
        processed += 1;
        if (processed % 1_000 === 0) await this.initializationYield();
      }
      needsTrailingNewline = await fileNeedsTrailingNewline(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    this.file = await this.runtime.openAppendFile(this.path);
    try {
      if (needsTrailingNewline) await this.persist("\n");
    } catch (error) {
      const file = this.file;
      this.file = undefined;
      try { await file.close(); } catch { /* Preserve the original persistence error. */ }
      throw error;
    }
    this.initialized = true;
  }

  has(commentId: string): boolean {
    return this.existingIds.has(commentId);
  }

  async append(record: FoundComment): Promise<boolean> {
    return (await this.appendBatch([record])).length > 0;
  }

  /** Persists one logical response page with one write and one fsync. */
  async appendBatch(records: readonly FoundComment[]): Promise<FoundComment[]> {
    await this.initialize();
    if (this.closing) throw new Error("JSONL result writer is closing.");
    this.assertWritable();
    let added: FoundComment[] = [];
    const write = this.appendTail.then(async () => {
      this.assertWritable();
      const batchIds = new Set<string>();
      added = records.filter((record) => {
        if (this.existingIds.has(record.commentId) || batchIds.has(record.commentId)) return false;
        batchIds.add(record.commentId);
        return true;
      }).map((record) => ({
        ...record,
        commentUrl: record.commentUrl ?? neteaseCommentUrl(record.songId, record.commentId),
      }));
      if (added.length === 0) return;
      await this.persist(added.map((record) => `${JSON.stringify(record)}\n`).join(""));
      for (const record of added) {
        this.existingIds.add(record.commentId);
        try { this.onAppend?.(record); } catch { /* UI delivery must not interrupt persistence. */ }
      }
    });
    this.appendTail = write.catch(() => {});
    await write;
    return added;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing ??= (async () => {
      try {
        // initialize() may already be reading a large existing JSONL file or
        // opening its append handle. Wait for that ownership transfer before
        // closing so a concurrent close cannot leave a late-opened handle
        // behind. Initialization failures already clean up their own handle.
        if (this.initialization) {
          try { await this.initialization; } catch { /* Preserve the initialize caller's error. */ }
        }
        await this.appendTail;
        const file = this.file;
        this.file = undefined;
        if (file) await file.close();
      } finally {
        this.closed = true;
      }
    })();
    await this.closing;
  }

  private assertWritable(): void {
    if (this.closed) throw new Error("JSONL result writer is closed.");
    if (this.persistenceError) throw this.persistenceError;
    if (!this.file) throw new Error("JSONL result writer is not initialized.");
  }

  private async persist(contents: string): Promise<void> {
    if (this.persistenceError) throw this.persistenceError;
    if (!this.file) throw new Error("JSONL result writer is not initialized.");
    try {
      await this.file.write(contents);
    } catch (error) {
      this.persistenceError = new JsonlResultPersistenceError("write", { cause: error });
      throw this.persistenceError;
    }
    try {
      await this.file.sync();
    } catch (error) {
      this.persistenceError = new JsonlResultPersistenceError("sync", { cause: error });
      throw this.persistenceError;
    }
  }
}

async function fileNeedsTrailingNewline(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    if (size === 0) return false;
    const lastByte = Buffer.allocUnsafe(1);
    const { bytesRead } = await file.read(lastByte, 0, 1, size - 1);
    return bytesRead === 1 && lastByte[0] !== 0x0a;
  } finally {
    await file.close();
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function neteaseCommentUrl(songId: string | undefined, commentId: string): string | undefined {
  if (!songId || !/^\d+$/.test(songId) || !/^\d+$/.test(commentId)) return undefined;
  return `https://music.163.com/#/song?id=${encodeURIComponent(songId)}&commentId=${encodeURIComponent(commentId)}`;
}
