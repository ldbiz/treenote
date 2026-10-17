/** Small, deterministic batches for reviewing manual archive candidates. */
export const ARCHIVE_BATCH_SIZE = 20;

export type ArchiveCandidateId = { id: string };

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

/** Only selected IDs on the visible page are submitted for execution. */
export function selectedArchiveBatchIds<T extends ArchiveCandidateId>(
  batchCandidates: readonly T[],
  selected: ReadonlySet<string>,
): string[] {
  return batchCandidates
    .filter((candidate) => selected.has(candidate.id))
    .map((candidate) => candidate.id);
}

/** Select all/none only affects candidates in the visible batch. */
export function setArchiveBatchSelection<T extends ArchiveCandidateId>(
  selected: ReadonlySet<string>,
  batchCandidates: readonly T[],
  shouldSelect: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const candidate of batchCandidates) {
    if (shouldSelect) next.add(candidate.id);
    else next.delete(candidate.id);
  }
  return next;
}

/** After archiving one batch, keep other pages' deliberate exclusions.
 *  Any genuinely new candidate starts selected by default. */
export function reconcileArchiveSelection<T extends ArchiveCandidateId>(
  previousCandidates: readonly T[],
  previousSelection: ReadonlySet<string>,
  refreshedCandidates: readonly T[],
): Set<string> {
  const previousIds = new Set(previousCandidates.map((candidate) => candidate.id));
  return new Set(
    refreshedCandidates
      .filter((candidate) => !previousIds.has(candidate.id) || previousSelection.has(candidate.id))
      .map((candidate) => candidate.id),
  );
}
