export function nextDescendingCursor(
  hasMore: boolean,
  rawNextCursor: string | undefined,
  requestedCursor: string,
  resource: string,
): string | undefined {
  if (!hasMore) return undefined;
  const current = Number(requestedCursor);
  const next = Number(rawNextCursor);
  if (!Number.isFinite(current) || !Number.isFinite(next) || next >= current) {
    throw new Error(
      `Comment cursor did not advance for ${resource}; the checkpoint remains resumable.`,
    );
  }
  return String(next);
}
