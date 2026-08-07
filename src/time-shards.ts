import type { CommentTimeShard } from "./types";

export const SOURCE_SCAN_START_TIME = Date.UTC(2000, 0, 1);

export interface TimeShardSplit {
  current: CommentTimeShard;
  sibling: CommentTimeShard;
  splitAt: number;
  remainingStart: number;
  remainingEnd: number;
}

export function createTimeShards(
  startTime: number,
  endTime: number,
  shardCount: number,
): CommentTimeShard[] {
  if (!Number.isInteger(startTime) || !Number.isInteger(endTime) || endTime <= startTime) {
    throw new Error("The scan time range is invalid.");
  }
  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new Error("shardCount must be a positive integer.");
  }
  const width = Math.ceil((endTime - startTime) / shardCount);
  return Array.from({ length: shardCount }, (_, id) => {
    const shardStart = startTime + id * width;
    const shardEnd = Math.min(endTime, shardStart + width);
    return {
      id,
      startTime: shardStart,
      endTime: shardEnd,
      cursor: String(shardEnd),
      pageNo: 2,
      pagesProcessed: 0,
      done: false,
    };
  }).filter((shard) => shard.startTime < shard.endTime);
}

export function splitRemainingTimeShard(
  shard: CommentTimeShard,
  siblingId: number,
): TimeShardSplit | undefined {
  const remainingEnd = Number(shard.cursor);
  const splitAt = Math.floor((shard.startTime + remainingEnd) / 2);
  if (!Number.isInteger(remainingEnd) || splitAt <= shard.startTime || splitAt >= remainingEnd) {
    return undefined;
  }
  const remainingStart = shard.startTime;
  return {
    current: {
      ...shard,
      startTime: splitAt,
      endTime: remainingEnd,
      cursor: String(remainingEnd),
      pageNo: 2,
    },
    sibling: {
      id: siblingId,
      startTime: remainingStart,
      endTime: splitAt,
      cursor: String(splitAt),
      pageNo: 2,
      pagesProcessed: 0,
      done: false,
    },
    splitAt,
    remainingStart,
    remainingEnd,
  };
}
