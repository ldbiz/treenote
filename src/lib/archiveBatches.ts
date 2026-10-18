/** Deterministic, fixed-size groups for a single archive-review session. */
export const ARCHIVE_BATCH_SIZE = 20;

export function archiveBatch<T>(
  candidates: readonly T[],
  requestedPage: number,
  batchSize = ARCHIVE_BATCH_SIZE,
): {
  pageIndex: number;
  pageCount: number;
  firstItem: number;
  lastItem: number;
  candidates: T[];
} {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("Archive batch size must be a positive integer");
  }
  const pageCount = Math.max(1, Math.ceil(candidates.length / batchSize));
  const safeRequested = Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0;
  const pageIndex = Math.max(0, Math.min(safeRequested, pageCount - 1));
  const offset = pageIndex * batchSize;
  const end = Math.min(offset + batchSize, candidates.length);
  return {
    pageIndex,
    pageCount,
    firstItem: candidates.length > 0 ? offset + 1 : 0,
    lastItem: end,
    candidates: candidates.slice(offset, end),
  };
}
