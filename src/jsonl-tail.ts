import { open } from "node:fs/promises";

const READ_BLOCK_BYTES = 64 * 1024;

/** Reads only enough blocks from the end of an append-only JSONL file. */
export async function readJsonlTail<T>(path: string, limit: number): Promise<T[]> {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const { size } = await file.stat();
    let position = size;
    let partial: Buffer = Buffer.alloc(0);
    let lines: string[] = [];
    while (position > 0 && lines.length < limit) {
      const length = Math.min(READ_BLOCK_BYTES, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      const combined = Buffer.concat([buffer.subarray(0, bytesRead), partial]);
      const pieces: Buffer[] = [];
      let start = 0;
      for (let index = 0; index < combined.length; index += 1) {
        if (combined[index] !== 0x0a) continue;
        pieces.push(combined.subarray(start, index));
        start = index + 1;
      }
      pieces.push(combined.subarray(start));
      partial = pieces.shift() ?? Buffer.alloc(0);
      lines = [
        ...pieces.map((line) => line.toString("utf8").replace(/\r$/, "")).filter(Boolean),
        ...lines,
      ].slice(-limit);
    }
    const firstLine = partial.toString("utf8").replace(/\r$/, "");
    if (position === 0 && firstLine.trim()) lines = [firstLine, ...lines].slice(-limit);
    return lines.slice(-limit).flatMap((line) => {
      try { return [JSON.parse(line) as T]; } catch { return []; }
    }).reverse();
  } finally {
    await file.close();
  }
}
