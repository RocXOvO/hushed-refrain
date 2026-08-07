import type { JsonlResultWriter } from "./results";
import type { FoundComment } from "./types";

export interface ResultCheckpoint {
  seenCommentIds: string[];
  matchCount: number;
}

export interface ResultRecordOutcome {
  counted: boolean;
  persisted: boolean;
}

/**
 * Keeps checkpoint-local match accounting consistent with the append-only result file.
 * Existing JSONL rows are counted once when rediscovered by a fresh checkpoint, but are
 * never appended again. A checkpoint-owned ID remains authoritative for that checkpoint.
 */
export class ResultAccumulator {
  private readonly seen: Set<string>;

  constructor(
    private readonly writer: Pick<JsonlResultWriter, "append">,
    private readonly checkpoint: ResultCheckpoint,
  ) {
    this.seen = new Set(checkpoint.seenCommentIds);
  }

  async record(record: FoundComment): Promise<ResultRecordOutcome> {
    if (this.seen.has(record.commentId)) return { counted: false, persisted: false };

    const persisted = await this.writer.append(record);
    // Another Worker may have completed the same record while this append was queued.
    if (this.seen.has(record.commentId)) return { counted: false, persisted };

    this.seen.add(record.commentId);
    this.checkpoint.seenCommentIds.push(record.commentId);
    this.checkpoint.matchCount += 1;
    return { counted: true, persisted };
  }

  async recordMany(records: readonly FoundComment[]): Promise<number> {
    let counted = 0;
    for (const record of records) {
      if ((await this.record(record)).counted) counted += 1;
    }
    return counted;
  }
}
