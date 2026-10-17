import { describe, expect, it } from "vitest";
import { archiveBatch } from "./archiveBatches";
import {
  actionableArchiveGroup,
  completeArchiveReviewGroup,
  keepArchiveReviewGroup,
  newArchiveReviewSession,
  nextUnreviewedGroup,
  reopenArchiveReviewGroup,
  selectedIdsInReviewGroup,
  setReviewCandidateSelected,
  setReviewGroupSelection,
} from "./archiveReviewSession";

const branches = Array.from({ length: 200 }, (_, i) => ({
  id: "branch-" + (i + 1),
  noteCount: i % 3 + 1,
}));

describe("fixed archive review groups", () => {
  it("keeps the original 20 members of group one after partial archiving", () => {
    let state = newArchiveReviewSession(branches);
    state = setReviewCandidateSelected(state, 0, "branch-4", false);
    state = setReviewCandidateSelected(state, 0, "branch-9", false);
    const requested = selectedIdsInReviewGroup(state, 0);
    expect(requested).toHaveLength(18);
    state = completeArchiveReviewGroup(state, 0, requested, requested);
    expect(archiveBatch(state.candidates, 0).candidates.map((c) => c.id))
      .toEqual(branches.slice(0, 20).map((c) => c.id));
    expect(state.archivedIds.size).toBe(18);
    expect(state.selectedIds.has("branch-4")).toBe(false);
    expect(state.selectedIds.has("branch-9")).toBe(false);
    expect(actionableArchiveGroup(state, 0).map((c) => c.id))
      .toEqual(["branch-4", "branch-9"]);
    expect(actionableArchiveGroup(state, 1)).toEqual(branches.slice(20, 40));
    expect(nextUnreviewedGroup(state.reviewedGroups, 0, 10)).toBe(1);
  });

  it("does not introduce newly eligible branches into an ongoing session", () => {
    let state = newArchiveReviewSession(branches);
    state = completeArchiveReviewGroup(
      state,
      0,
      selectedIdsInReviewGroup(state, 0),
      branches.slice(0, 20).map((b) => b.id),
    );
    expect(state.candidates).toHaveLength(200);
    expect(state.candidates.some((b) => b.id === "new-eligible")).toBe(false);
    // An explicit new review (not a post-archive automatic scan) can include it.
    expect(newArchiveReviewSession([{ id: "new-eligible", noteCount: 1 }]).candidates).toHaveLength(1);
  });

  it("marks candidates that became ineligible as unavailable", () => {
    const start = newArchiveReviewSession(branches);
    const requested = selectedIdsInReviewGroup(start, 0);
    const done = completeArchiveReviewGroup(start, 0, requested, requested.slice(0, 15));
    expect(done.archivedIds.size).toBe(15);
    expect(done.unavailableIds.size).toBe(5);
    expect(actionableArchiveGroup(done, 0)).toHaveLength(0);
    expect(done.reviewedGroups.has(0)).toBe(true);
  });

  it("allows keeping a complete group and reopening it to change a decision", () => {
    let state = newArchiveReviewSession(branches);
    state = keepArchiveReviewGroup(state, 0);
    expect(selectedIdsInReviewGroup(state, 0)).toEqual([]);
    expect(actionableArchiveGroup(state, 0)).toHaveLength(20);
    state = reopenArchiveReviewGroup(state, 0);
    state = setReviewCandidateSelected(state, 0, "branch-3", true);
    expect(selectedIdsInReviewGroup(state, 0)).toEqual(["branch-3"]);
    expect(state.selectedIds.has("branch-25")).toBe(true);
  });

  it("select all/none applies only to current actionable group", () => {
    let state = newArchiveReviewSession(branches);
    state = setReviewGroupSelection(state, 3, false);
    expect(selectedIdsInReviewGroup(state, 3)).toEqual([]);
    expect(selectedIdsInReviewGroup(state, 4)).toHaveLength(20);
    state = setReviewGroupSelection(state, 3, true);
    expect(selectedIdsInReviewGroup(state, 3)).toHaveLength(20);
  });

  it("never processes IDs outside the selected group", () => {
    const state = newArchiveReviewSession(branches);
    const requested = selectedIdsInReviewGroup(state, 0);
    expect(() => completeArchiveReviewGroup(state, 0, [...requested, "branch-45"], requested))
      .toThrow("group boundaries");
    expect(() => completeArchiveReviewGroup(state, 0, requested, ["branch-45"]))
      .toThrow("unexpected");
  });

  it("wraps to an earlier unreviewed group and detects completion", () => {
    expect(nextUnreviewedGroup(new Set([1, 2, 3]), 3, 5)).toBe(4);
    expect(nextUnreviewedGroup(new Set([0, 2, 3, 4]), 4, 5)).toBe(1);
    expect(nextUnreviewedGroup(new Set([0, 1, 2, 3]), 3, 4)).toBe(null);
  });
});
