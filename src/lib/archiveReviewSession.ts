import { archiveBatch } from "./archiveBatches";

export type ReviewCandidate = { id: string; noteCount: number };

export type ArchiveReviewSession<T extends ReviewCandidate> = {
  /** Fixed candidates from the initial scan; NEVER replace during this review. */
  candidates: readonly T[];
  selectedIds: ReadonlySet<string>;
  archivedIds: ReadonlySet<string>;
  unavailableIds: ReadonlySet<string>;
  reviewedGroups: ReadonlySet<number>;
};

export function newArchiveReviewSession<T extends ReviewCandidate>(
  candidates: readonly T[],
): ArchiveReviewSession<T> {
  return {
    candidates: [...candidates],
    selectedIds: new Set(candidates.map((candidate) => candidate.id)),
    archivedIds: new Set(),
    unavailableIds: new Set(),
    reviewedGroups: new Set(),
  };
}

export function actionableArchiveGroup<T extends ReviewCandidate>(
  session: ArchiveReviewSession<T>,
  pageIndex: number,
): T[] {
  return archiveBatch(session.candidates, pageIndex).candidates.filter(
    (candidate) =>
      !session.archivedIds.has(candidate.id) && !session.unavailableIds.has(candidate.id),
  );
}

export function setReviewGroupSelection<T extends ReviewCandidate>(
  session: ArchiveReviewSession<T>,
  pageIndex: number,
  shouldSelect: boolean,
): ArchiveReviewSession<T> {
  if (session.reviewedGroups.has(pageIndex)) return session;
  const selected = new Set(session.selectedIds);
  for (const candidate of actionableArchiveGroup(session, pageIndex)) {
    if (shouldSelect) selected.add(candidate.id);
    else selected.delete(candidate.id);
  }
  return { ...session, selectedIds: selected };
}

export function setReviewCandidateSelected<T extends ReviewCandidate>(
  session: ArchiveReviewSession<T>,
  pageIndex: number,
  id: string,
  checked: boolean,
): ArchiveReviewSession<T> {
  if (session.reviewedGroups.has(pageIndex) ||
      !actionableArchiveGroup(session, pageIndex).some((candidate) => candidate.id === id)) {
    return session;
  }
  const selected = new Set(session.selectedIds);
  if (checked) selected.add(id);
  else selected.delete(id);
  return { ...session, selectedIds: selected };
}

export function selectedIdsInReviewGroup<T extends ReviewCandidate>(
  session: ArchiveReviewSession<T>,
  pageIndex: number,
): string[] {
  if (session.reviewedGroups.has(pageIndex)) return [];
  return actionableArchiveGroup(session, pageIndex)
    .filter((candidate) => session.selectedIds.has(candidate.id))
    .map((candidate) => candidate.id);
}

/** Archive success is authoritative; any requested ID not returned was skipped
 * by backend revalidation and is unavailable until the user starts a new scan.
 * Unchecked candidates are kept in their original groups rather than pulled
 * into another group's list. */
export function completeArchiveReviewGroup<T extends ReviewCandidate>(
  session: ArchiveReviewSession<T>,
  pageIndex: number,
  requestedIds: readonly string[],
  archivedIds: readonly string[],
): ArchiveReviewSession<T> {
  const requested = new Set(selectedIdsInReviewGroup(session, pageIndex));
  for (const id of requestedIds) {
    if (!requested.has(id)) throw new Error("Archive request crossed group boundaries");
  }
  const archived = new Set(archivedIds);
  for (const id of archived) {
    if (!requested.has(id)) throw new Error("Backend archived an unexpected branch");
  }
  const allArchived = new Set(session.archivedIds);
  const unavailable = new Set(session.unavailableIds);
  const selected = new Set(session.selectedIds);
  for (const id of requestedIds) {
    selected.delete(id);
    if (archived.has(id)) allArchived.add(id);
    else unavailable.add(id);
  }
  return {
    ...session,
    selectedIds: selected,
    archivedIds: allArchived,
    unavailableIds: unavailable,
    reviewedGroups: new Set(session.reviewedGroups).add(pageIndex),
  };
}

export function keepArchiveReviewGroup<T extends ReviewCandidate>(
  session: ArchiveReviewSession<T>,
  pageIndex: number,
): ArchiveReviewSession<T> {
  if (session.reviewedGroups.has(pageIndex)) return session;
  const selected = new Set(session.selectedIds);
  for (const candidate of actionableArchiveGroup(session, pageIndex)) {
    selected.delete(candidate.id);
  }
  return {
    ...session,
    selectedIds: selected,
    reviewedGroups: new Set(session.reviewedGroups).add(pageIndex),
  };
}

export function reopenArchiveReviewGroup<T extends ReviewCandidate>(
  session: ArchiveReviewSession<T>,
  pageIndex: number,
): ArchiveReviewSession<T> {
  const reviewed = new Set(session.reviewedGroups);
  reviewed.delete(pageIndex);
  return { ...session, reviewedGroups: reviewed };
}

export function nextUnreviewedGroup(
  reviewedGroups: ReadonlySet<number>,
  currentPage: number,
  pageCount: number,
): number | null {
  for (let offset = 1; offset <= pageCount; offset += 1) {
    const i = (currentPage + offset) % pageCount;
    if (!reviewedGroups.has(i)) return i;
  }
  return null;
}
