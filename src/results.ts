import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { FoundComment } from "./types";

export class JsonlResultWriter {
  private readonly existingIds = new Set<string>();
  private initialized = false;
  private appendTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly onAppend?: (record: FoundComment) => void,
    private readonly initializationYield: () => Promise<void> = yieldToEventLoop,
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
          const item = JSON.parse(line) as { commentId?: unknown };
          if (item.commentId !== undefined) this.existingIds.add(String(item.commentId));
        } catch {
          // Preserve a partially written line and continue; new records remain valid JSONL.
        }
        processed += 1;
        if (processed % 1_000 === 0) await this.initializationYield();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.initialized = true;
  }

  has(commentId: string): boolean {
    return this.existingIds.has(commentId);
  }

  async append(record: FoundComment): Promise<boolean> {
    await this.initialize();
    let added = false;
    const write = this.appendTail.then(async () => {
      if (this.existingIds.has(record.commentId)) return;
      const stored = {
        ...record,
        commentUrl: record.commentUrl ?? neteaseCommentUrl(record.songId, record.commentId),
      };
      await appendFile(this.path, `${JSON.stringify(stored)}\n`, "utf8");
      this.existingIds.add(record.commentId);
      added = true;
      try { this.onAppend?.(stored); } catch { /* UI delivery must not interrupt persistence. */ }
    });
    this.appendTail = write.catch(() => {});
    await write;
    return added;
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function neteaseCommentUrl(songId: string | undefined, commentId: string): string | undefined {
  if (!songId || !/^\d+$/.test(songId) || !/^\d+$/.test(commentId)) return undefined;
  return `https://music.163.com/#/song?id=${encodeURIComponent(songId)}&commentId=${encodeURIComponent(commentId)}`;
}
