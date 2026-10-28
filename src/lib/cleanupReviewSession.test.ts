import { describe, expect, it } from "vitest";
import { archiveBatch } from "./archiveBatches";
import {
  completeArchiveReviewGroup, keepArchiveReviewGroup, newArchiveReviewSession,
  reopenArchiveReviewGroup, selectedIdsInReviewGroup, setReviewCandidateSelected,
} from "./archiveReviewSession";

// Empty-note cleanup reuses the existing fixed-group reviewer. Its processed
// IDs are tracked in archivedIds internally, though actual rows are deleted.
const items = Array.from({ length: 45 }, (_, i) => ({ id: "note-" + i, noteCount: 1 }));

describe("empty-note review batches", () => {
  it("retains stable groups and unchecked decisions after partial deletion", () => {
    let session = newArchiveReviewSession(items);
    session = setReviewCandidateSelected(session, 0, "note-1", false);
    session = completeArchiveReviewGroup(session, 0,
      selectedIdsInReviewGroup(session, 0),
      selectedIdsInReviewGroup(session, 0).filter((id) => id !== "note-2"));
    expect(archiveBatch(session.candidates, 0).candidates.map((c) => c.id))
      .toEqual(items.slice(0, 20).map((c) => c.id));
    expect(archiveBatch(session.candidates, 1).candidates.map((c) => c.id))
      .toEqual(items.slice(20, 40).map((c) => c.id));
    expect(session.archivedIds.has("note-0")).toBe(true);
    expect(session.unavailableIds.has("note-2")).toBe(true);
    expect(session.archivedIds.has("note-1")).toBe(false);
    session = reopenArchiveReviewGroup(session, 0);
    expect(selectedIdsInReviewGroup(session, 0)).toEqual([]);
    session = setReviewCandidateSelected(session, 0, "note-1", true);
    expect(selectedIdsInReviewGroup(session, 0)).toEqual(["note-1"]);
  });

  it("keeps an entire group without creating any deletion request", () => {
    const session = keepArchiveReviewGroup(newArchiveReviewSession(items), 2);
    expect(session.reviewedGroups.has(2)).toBe(true);
    expect(selectedIdsInReviewGroup(session, 2)).toEqual([]);
    expect(session.archivedIds.size).toBe(0);
  });
});
