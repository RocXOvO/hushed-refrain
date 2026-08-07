export interface TimeProgressShard {
  startTime: number;
  endTime: number;
  cursor?: string;
  done: boolean;
}

export function mergeCommentTotal(
  current: number | undefined,
  reported: number | undefined,
  processed: number,
): number | undefined {
  const values = [current, reported, processed]
    .filter((value): value is number => Number.isFinite(value) && value! >= 0);
  return values.length > 0 ? Math.max(...values) : undefined;
}

/** Uses remaining time coverage so adaptive shard splits cannot fake a regression. */
export function timeCoveragePercent(
  startTime: number,
  endTime: number,
  shards: TimeProgressShard[],
): number {
  const total = Math.max(0, endTime - startTime);
  if (total === 0) return shards.every((shard) => shard.done) ? 100 : 0;
  const remaining = shards.reduce((sum, shard) => {
    if (shard.done) return sum;
    const cursor = Number(shard.cursor);
    const remainingEnd = Number.isFinite(cursor)
      ? Math.max(shard.startTime, Math.min(shard.endTime, cursor))
      : shard.endTime;
    return sum + Math.max(0, remainingEnd - shard.startTime);
  }, 0);
  return Math.max(0, Math.min(100, Math.round((1 - remaining / total) * 100)));
}
