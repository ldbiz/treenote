import { useCallback, useEffect, useRef, useState } from "react";
import { FluentProvider, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "./hooks/useTheme";
import { useUiZoom } from "./hooks/useUiZoom";
import {
  createFlushRequestId,
  waitForFlushResult,
  writeFlushRequest,
} from "./lib/editorFlushBridge";
import {
  archiveBatch,
  ARCHIVE_BATCH_SIZE,
} from "./lib/archiveBatches";
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
  type ArchiveReviewSession,
} from "./lib/archiveReviewSession";
import "./styles/theme.css";
import "./styles/housekeeping.css";

type ArchiveCandidate = {
  id: string;
  label: string;
  noteCount: number;
};

type ArchivePreview = {
  days: number;
  notebookPath: string;
  totalNotes: number;
  candidates: ArchiveCandidate[];
};

type ArchiveSweepResult = {
  archivedBranches: number;
  archivedNotes: number;
  skippedBranches: number;
  archivedIds: string[];
};

type Review = {
  source: ArchivePreview;
  session: ArchiveReviewSession<ArchiveCandidate>;
};

type ReviewNotice = {
  kind: "success" | "info" | "error";
  message: string;
};

type Contents = {
  branchId: string;
  status: "loading" | "ready" | "error";
  text: string;
};

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}

function notebookName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

async function confirmRestart(): Promise<boolean> {
  const message =
    "Start a new scan? This clears the current review groups, choices and progress. " +
    "Previously archived notes will remain archived.";
  try {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    return await confirm(message, { title: "Start a new archive review?", kind: "warning" });
  } catch {
    return window.confirm(message);
  }
}

async function closeReviewWindow(): Promise<void> {
  try {
    await getCurrentWindow().close();
  } catch {
    window.close();
  }
}

export default function HousekeepingReviewApp() {
  const { resolvedTheme } = useTheme();
  useUiZoom();

  const [review, setReview] = useState<Review | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [contents, setContents] = useState<Contents | null>(null);
  const [busy, setBusy] = useState<"scan" | "archive" | null>(null);
  const [notice, setNotice] = useState<ReviewNotice | null>(null);
  const initialScanStarted = useRef(false);

  const startScan = useCallback(async (confirmDiscard = false) => {
    if (busy) return;
    if (confirmDiscard && review &&
        (review.session.reviewedGroups.size > 0 ||
         review.session.selectedIds.size !== review.session.candidates.length)) {
      const proceed = await confirmRestart();
      if (!proceed) return;
    }
    setBusy("scan");
    setNotice(null);
    try {
      const requestId = createFlushRequestId();
      writeFlushRequest(requestId);
      await waitForFlushResult(requestId);
      const source = await invoke<ArchivePreview>("preview_inactive_archive");
      setReview({ source, session: newArchiveReviewSession(source.candidates) });
      setPageIndex(0);
      setFocusedId(source.candidates[0]?.id ?? null);
      setContents(null);
      if (source.candidates.length === 0) {
        setNotice({ kind: "info", message: "No inactive branches currently qualify for archiving." });
      }
    } catch (error) {
      // Keep any existing session if a rescan fails; it has not been changed.
      setNotice({ kind: "error", message: "Unable to scan notebook: " + errorText(error) });
    } finally {
      setBusy(null);
    }
  }, [busy, review]);

  useEffect(() => {
    if (initialScanStarted.current) return;
    initialScanStarted.current = true;
    void startScan(false);
  }, [startScan]);

  const candidateBatch = archiveBatch(review?.session.candidates ?? [], pageIndex);
  const currentPage = candidateBatch.pageIndex;
  const pageCount = candidateBatch.pageCount;
  const groupReviewed = review?.session.reviewedGroups.has(currentPage) ?? false;
  const actionable = review ? actionableArchiveGroup(review.session, currentPage) : [];
  const selectedIds = review ? selectedIdsInReviewGroup(review.session, currentPage) : [];
  const selectedNoteCount = candidateBatch.candidates
    .filter((candidate) => selectedIds.includes(candidate.id))
    .reduce((sum, candidate) => sum + candidate.noteCount, 0);
  const archivedCount = review?.session.archivedIds.size ?? 0;
  const unavailableCount = review?.session.unavailableIds.size ?? 0;
  const reviewedCount = review?.session.reviewedGroups.size ?? 0;
  const isFinished = review !== null && pageCount === reviewedCount;

  let keptCount = 0;
  if (review) {
    for (const reviewedPage of review.session.reviewedGroups) {
      for (const candidate of archiveBatch(review.session.candidates, reviewedPage).candidates) {
        if (!review.session.archivedIds.has(candidate.id) &&
            !review.session.unavailableIds.has(candidate.id)) {
          keptCount += 1;
        }
      }
    }
  }

  const moveToPage = (requested: number) => {
    if (!review) return;
    const next = archiveBatch(review.session.candidates, requested);
    setPageIndex(next.pageIndex);
    const first = next.candidates.find(
      (candidate) => !review.session.archivedIds.has(candidate.id) &&
        !review.session.unavailableIds.has(candidate.id),
    ) ?? next.candidates[0];
    setFocusedId(first?.id ?? null);
  };

  const focusedCandidate = candidateBatch.candidates.find((candidate) => candidate.id === focusedId);
  const focusedArchived = focusedId !== null && (review?.session.archivedIds.has(focusedId) ?? false);
  const focusedUnavailable = focusedId !== null && (review?.session.unavailableIds.has(focusedId) ?? false);

  useEffect(() => {
    if (!focusedId || !review || focusedArchived || focusedUnavailable) {
      setContents(null);
      return;
    }
    const branchId = focusedId;
    let cancelled = false;
    setContents({ branchId, status: "loading", text: "" });
    void invoke<string>("preview_inactive_branch_contents", {
      rootId: branchId,
      expectedNotebookPath: review.source.notebookPath,
      expectedDays: review.source.days,
    }).then((text) => {
      if (!cancelled) setContents({ branchId, status: "ready", text });
    }).catch((error: unknown) => {
      if (!cancelled) setContents({ branchId, status: "error", text: errorText(error) });
    });
    return () => { cancelled = true; };
  }, [focusedId, review?.source.notebookPath, review?.source.days, focusedArchived, focusedUnavailable]);

  const changeSelection = (id: string, checked: boolean) => {
    setReview((current) => current ? {
      ...current,
      session: setReviewCandidateSelected(current.session, pageIndex, id, checked),
    } : null);
  };

  const selectAllOnPage = (checked: boolean) => {
    setReview((current) => current ? {
      ...current,
      session: setReviewGroupSelection(current.session, pageIndex, checked),
    } : null);
  };

  const moveAfterReview = (nextSession: ArchiveReviewSession<ArchiveCandidate>, source: ArchivePreview) => {
    const nextPage = nextUnreviewedGroup(
      nextSession.reviewedGroups, currentPage, archiveBatch(source.candidates, 0).pageCount,
    );
    if (nextPage === null) {
      setPageIndex(currentPage);
      setFocusedId(null);
      return;
    }
    setPageIndex(nextPage);
    setFocusedId(archiveBatch(source.candidates, nextPage).candidates[0]?.id ?? null);
  };

  const keepGroup = () => {
    if (!review || groupReviewed || busy) return;
    const nextSession = keepArchiveReviewGroup(review.session, currentPage);
    setReview({ ...review, session: nextSession });
    setNotice({ kind: "info", message: "Group " + (currentPage + 1) + " kept. Its membership and choices remain recorded for this review." });
    moveAfterReview(nextSession, review.source);
  };

  const archiveGroup = async () => {
    if (!review || groupReviewed || busy || selectedIds.length === 0) return;
    const submitted = [...selectedIds];
    setBusy("archive");
    setNotice(null);

    let result: ArchiveSweepResult;
    try {
      const requestId = createFlushRequestId();
      writeFlushRequest(requestId);
      await waitForFlushResult(requestId);
      result = await invoke<ArchiveSweepResult>("execute_inactive_archive", {
        previewedIds: submitted,
        expectedNotebookPath: review.source.notebookPath,
        expectedDays: review.source.days,
      });
    } catch (error) {
      setNotice({ kind: "error", message: "Archive did not complete: " + errorText(error) });
      setBusy(null);
      return;
    }

    // Do not refresh the candidate list here. Re-querying and re-batching
    // would mix kept notes and newly eligible candidates into the current group.
    const nextSession = completeArchiveReviewGroup(
      review.session, currentPage, submitted, result.archivedIds,
    );
    setReview({ ...review, session: nextSession });
    moveAfterReview(nextSession, review.source);

    if (result.archivedIds.length > 0) {
      try {
        localStorage.setItem("treenote-housekeeping-archive-result", JSON.stringify({
          ...result, at: Date.now(),
        }));
      } catch (error) {
        console.error("Archive succeeded, but the main tree could not be notified:", error);
      }
    }

    setNotice({
      kind: result.skippedBranches ? "info" : "success",
      message: "Archived " + result.archivedBranches + " branches (" + result.archivedNotes +
        " notes) in group " + (currentPage + 1) + "." +
        (result.skippedBranches ? " " + result.skippedBranches +
          " changed since scanning and were not archived." : "") +
        " No new candidates have been added to this review.",
    });
    setBusy(null);
  };

  const reopenGroup = () => {
    if (!review || busy) return;
    setReview({ ...review, session: reopenArchiveReviewGroup(review.session, currentPage) });
    setNotice({ kind: "info", message: "Group " + (currentPage + 1) + " reopened. Archived branches remain archived; you can revise the kept items." });
  };

  const disableControls = busy !== null;

  return (
    <FluentProvider theme={resolvedTheme === "dark" ? webDarkTheme : webLightTheme}>
      <div className="housekeeping-root">
        <header className="housekeeping-header">
          <div className="housekeeping-heading">
            <h1>Archive review</h1>
            <p>Inspect inactive branches, decide what to keep, then archive in manageable groups.</p>
            {review && <div className="housekeeping-notebook">
              {notebookName(review.source.notebookPath)} · Inactive {review.source.days}+ days
            </div>}
          </div>
          <div className="housekeeping-header-actions">
            <button
              type="button"
              className="options-btn options-btn-secondary"
              onClick={() => void startScan(true)}
              disabled={disableControls}
              title="Start a fresh review using current notebook activity"
            >
              {busy === "scan" ? "Scanning…" : "New scan"}
            </button>
            <button
              type="button"
              className="options-btn options-btn-secondary"
              onClick={() => void closeReviewWindow()}
              disabled={disableControls}
            >
              Close
            </button>
          </div>
        </header>

        {review && review.source.candidates.length > 0 && (
          <div className="housekeeping-progress" aria-label="Review progress">
            <span>{reviewedCount} of {pageCount} groups reviewed</span>
            <span>{archivedCount} archived · {keptCount} kept
              {unavailableCount > 0 ? " · " + unavailableCount + " changed" : ""}
            </span>
            <div
              className="housekeeping-progress-track"
              role="progressbar"
              aria-label="Groups reviewed"
              aria-valuemin={0}
              aria-valuemax={pageCount}
              aria-valuenow={reviewedCount}
            >
              <div style={{ width: (reviewedCount / pageCount * 100) + "%" }} />
            </div>
          </div>
        )}

        {notice && <div className={"housekeeping-notice housekeeping-notice-" + notice.kind}
          role={notice.kind === "error" ? "alert" : "status"}>
          {notice.message}
        </div>}

        {!review && <div className="housekeeping-empty" role="status">
          {busy === "scan" ? "Scanning notebook for inactive branches…" : "No review is loaded. Use New scan to begin."}
        </div>}

        {review && review.source.candidates.length === 0 &&
          <div className="housekeeping-empty">
            <h2>Nothing to archive</h2>
            <p>No inactive branches currently qualify. You can close this window or run another scan later.</p>
          </div>}

        {review && review.source.candidates.length > 0 && <>
          <nav className="housekeeping-group-bar" aria-label="Review group navigation">
            <span className="housekeeping-group-heading">
              Group {currentPage + 1} of {pageCount}
            </span>
            <span className="housekeeping-group-range">
              Branches {candidateBatch.firstItem}–{candidateBatch.lastItem} of {review.source.candidates.length}
            </span>
            <div className="housekeeping-group-controls">
              <button type="button" className="options-btn options-btn-secondary options-btn-compact"
                disabled={disableControls || currentPage === 0}
                onClick={() => moveToPage(currentPage - 1)}>Previous</button>
              <label className="housekeeping-group-jump">
                <span>Group</span>
                <select className="options-control" value={currentPage} disabled={disableControls}
                  onChange={(event) => moveToPage(Number(event.target.value))}
                  aria-label="Go to review group">
                  {Array.from({ length: pageCount }, (_, i) =>
                    <option key={i} value={i}>{i + 1}{review.session.reviewedGroups.has(i) ? " (reviewed)" : ""}</option>)}
                </select>
              </label>
              <button type="button" className="options-btn options-btn-secondary options-btn-compact"
                disabled={disableControls || currentPage === pageCount - 1}
                onClick={() => moveToPage(currentPage + 1)}>Next</button>
            </div>
          </nav>

          <main className="housekeeping-workspace">
            <section className="housekeeping-branches" aria-label="Branches in current review group">
              <div className="housekeeping-pane-header">
                <div>
                  <h2>Branches</h2>
                  <p>{ARCHIVE_BATCH_SIZE} per group · {actionable.length} available</p>
                </div>
                {!groupReviewed && <div className="housekeeping-select-actions">
                  <button type="button" disabled={disableControls || selectedIds.length === actionable.length}
                    onClick={() => selectAllOnPage(true)}>Select all</button>
                  <button type="button" disabled={disableControls || selectedIds.length === 0}
                    onClick={() => selectAllOnPage(false)}>Select none</button>
                </div>}
              </div>
              <p className="housekeeping-pane-help">
                {groupReviewed
                  ? "This group has been reviewed. Reopen it to change kept items."
                  : "Check branches to archive. Click a title to read its contents."}
              </p>
              <ul className="housekeeping-branch-list" key={currentPage}>
                {candidateBatch.candidates.map((candidate) => {
                  const archived = review.session.archivedIds.has(candidate.id);
                  const unavailable = review.session.unavailableIds.has(candidate.id);
                  const selected = review.session.selectedIds.has(candidate.id);
                  const status = archived ? "Archived" : unavailable ? "Changed" :
                    groupReviewed ? "Kept" : selected ? "Archive" : "Keep";
                  return (
                    <li className={"housekeeping-branch-row" +
                      (candidate.id === focusedId ? " housekeeping-branch-row-focused" : "")}
                      key={candidate.id}>
                      <input
                        type="checkbox"
                        className="options-checkbox"
                        aria-label={"Archive " + candidate.label}
                        checked={!archived && !unavailable && selected}
                        disabled={disableControls || groupReviewed || archived || unavailable}
                        onFocus={() => setFocusedId(candidate.id)}
                        onChange={(event) => changeSelection(candidate.id, event.target.checked)}
                      />
                      <button
                        className="housekeeping-branch-title"
                        type="button"
                        aria-pressed={focusedId === candidate.id}
                        onFocus={() => setFocusedId(candidate.id)}
                        onClick={() => setFocusedId(candidate.id)}
                      >
                        <span className="housekeeping-branch-label">{candidate.label}</span>
                        <span className="housekeeping-branch-meta">
                          {candidate.noteCount} {candidate.noteCount === 1 ? "note" : "notes"} · {status}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="housekeeping-contents" aria-label="Focused branch note contents">
              <div className="housekeeping-pane-header">
                <div>
                  <h2>Note contents</h2>
                  <p>Read-only · Nested notes are shown with hyphens</p>
                </div>
              </div>
              <div className="housekeeping-contents-body" aria-live="off">
                {!focusedCandidate && <p className="housekeeping-placeholder">
                  {isFinished ? "Review complete. Start a new scan to find any new candidates." :
                    "Select a branch on the left to inspect its text."}
                </p>}
                {focusedCandidate && <>
                  <h3>{focusedCandidate.label}</h3>
                  {focusedArchived ? (
                    <p className="housekeeping-placeholder">
                      This branch has been archived. It remains available via Show archived in TreeNote.
                    </p>
                  ) : focusedUnavailable ? (
                    <p className="housekeeping-placeholder">
                      This branch changed after the scan and was not archived. Start a new scan to review it again.
                    </p>
                  ) : !contents || contents.branchId !== focusedCandidate.id ||
                      contents.status === "loading" ? (
                    <p className="housekeeping-placeholder" role="status">Loading note contents…</p>
                  ) : contents.status === "error" ? (
                    <p className="housekeeping-error" role="alert">
                      Could not load this branch: {contents.text}
                    </p>
                  ) : (
                    <pre className="housekeeping-text-dump">{contents.text}</pre>
                  )}
                </>}
              </div>
            </section>
          </main>

          <footer className="housekeeping-footer">
            <div className="housekeeping-footer-detail">
              {groupReviewed ? (
                <span>This group is reviewed. Kept branches will not be replaced or moved into another group.</span>
              ) : (
                <span>{selectedIds.length} of {actionable.length} available branches checked
                  {" "}({selectedNoteCount} notes). Unchecked branches will be kept.</span>
              )}
              {isFinished && <strong>All groups reviewed. A new scan is optional.</strong>}
            </div>
            <div className="housekeeping-footer-actions">
              {groupReviewed ? (
                <button type="button" className="options-btn options-btn-secondary"
                  disabled={disableControls} onClick={reopenGroup}>Reopen this group</button>
              ) : <>
                <button type="button" className="options-btn options-btn-secondary"
                  disabled={disableControls} onClick={keepGroup}>Keep entire group</button>
                <button type="button" className="options-btn options-btn-primary"
                  disabled={disableControls || selectedIds.length === 0}
                  onClick={() => void archiveGroup()}>
                  {busy === "archive" ? "Archiving…" : "Archive " + selectedIds.length + " checked & continue"}
                </button>
              </>}
            </div>
          </footer>
        </>}
      </div>
    </FluentProvider>
  );
}
