import { useCallback, useEffect, useRef, useState } from "react";
import { FluentProvider, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "./hooks/useTheme";
import { useUiZoom } from "./hooks/useUiZoom";
import { archiveBatch, ARCHIVE_BATCH_SIZE } from "./lib/archiveBatches";
import {
  actionableArchiveGroup, completeArchiveReviewGroup, keepArchiveReviewGroup,
  newArchiveReviewSession, nextUnreviewedGroup, reopenArchiveReviewGroup,
  selectedIdsInReviewGroup, setReviewCandidateSelected, setReviewGroupSelection,
  type ArchiveReviewSession,
} from "./lib/archiveReviewSession";
import { createFlushRequestId, waitForFlushResult, writeFlushRequest } from "./lib/editorFlushBridge";
import "./styles/theme.css";
import "./styles/housekeeping.css";

type Candidate = {
  id: string;
  label: string;
  parentPath: string;
  createdAt: number;
  modifiedAt: number;
  lastAccessedAt: number | null;
  lastUnarchivedAt: number | null;
  noteCount: number;
};

type Preview = {
  days: number;
  notebookPath: string;
  totalNotes: number;
  candidates: Candidate[];
};

type CleanupResult = {
  deletedIds: string[];
  skippedIds: string[];
  backupPath: string;
};

type Session = ArchiveReviewSession<Candidate>;
type Review = { source: Preview; session: Session };
type Notice = { kind: "error" | "success" | "info"; text: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function date(ts: number | null): string {
  return ts === null ? "Never recorded" : new Date(ts).toLocaleString();
}

function notebookName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

async function confirmAction(text: string, title: string): Promise<boolean> {
  try {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    return await confirm(text, { title, kind: "warning" });
  } catch {
    return window.confirm(text);
  }
}

export default function EmptyCleanupReviewApp({ onArchive }: { onArchive: () => void }) {
  const { resolvedTheme } = useTheme();
  useUiZoom();
  const [review, setReview] = useState<Review | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"scan" | "delete" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const initialScan = useRef(false);

  const scan = useCallback(async (discard = false) => {
    if (busy) return;
    if (discard && review &&
        (review.session.reviewedGroups.size > 0 ||
          review.session.selectedIds.size !== review.session.candidates.length)) {
      const proceed = await confirmAction(
        "Start a new scan? Current choices and review progress will be cleared. Deleted notes cannot be restored except from a backup.",
        "New empty-note scan",
      );
      if (!proceed) return;
    }
    setBusy("scan");
    setNotice(null);
    try {
      const requestId = createFlushRequestId();
      writeFlushRequest(requestId);
      await waitForFlushResult(requestId);
      const source = await invoke<Preview>("preview_empty_note_cleanup");
      setReview({ source, session: newArchiveReviewSession(source.candidates) });
      setPageIndex(0);
      setFocusedId(source.candidates[0]?.id ?? null);
      if (!source.candidates.length) {
        setNotice({ kind: "info", text: "No provably unused empty notes meet the inactivity threshold. Ambiguous legacy and imported notes are deliberately excluded." });
      }
    } catch (error) {
      setNotice({ kind: "error", text: "Unable to scan notebook: " + message(error) });
    } finally {
      setBusy(null);
    }
  }, [busy, review]);

  useEffect(() => {
    if (initialScan.current) return;
    initialScan.current = true;
    void scan();
  }, [scan]);

  const group = archiveBatch(review?.session.candidates ?? [], pageIndex);
  const current = group.pageIndex;
  const pageCount = group.pageCount;
  const reviewed = review?.session.reviewedGroups.has(current) ?? false;
  const actionable = review ? actionableArchiveGroup(review.session, current) : [];
  const checked = review ? selectedIdsInReviewGroup(review.session, current) : [];
  const deletedCount = review?.session.archivedIds.size ?? 0;
  const skippedCount = review?.session.unavailableIds.size ?? 0;
  const reviewedCount = review?.session.reviewedGroups.size ?? 0;
  const finished = review !== null && reviewedCount === pageCount;
  let keptCount = 0;
  if (review) {
    for (const i of review.session.reviewedGroups) {
      for (const candidate of archiveBatch(review.session.candidates, i).candidates) {
        if (!review.session.archivedIds.has(candidate.id) && !review.session.unavailableIds.has(candidate.id)) {
          keptCount += 1;
        }
      }
    }
  }

  const moveTo = (next: number) => {
    if (!review) return;
    const batch = archiveBatch(review.session.candidates, next);
    setPageIndex(batch.pageIndex);
    setFocusedId(batch.candidates.find((c) =>
      !review.session.archivedIds.has(c.id) && !review.session.unavailableIds.has(c.id)
    )?.id ?? batch.candidates[0]?.id ?? null);
  };

  const advance = (session: Session, source: Preview) => {
    const next = nextUnreviewedGroup(session.reviewedGroups, current,
      archiveBatch(source.candidates, 0).pageCount);
    if (next === null) {
      setFocusedId(null);
    } else {
      setPageIndex(next);
      setFocusedId(archiveBatch(source.candidates, next).candidates[0]?.id ?? null);
    }
  };

  const keep = () => {
    if (!review || busy || reviewed) return;
    const session = keepArchiveReviewGroup(review.session, current);
    setReview({ ...review, session });
    setNotice({ kind: "info", text: "Kept group " + (current + 1) + ". No notes were deleted." });
    advance(session, review.source);
  };

  const deleteChecked = async () => {
    if (!review || busy || reviewed || !checked.length) return;
    const submitted = [...checked];
    const agreed = await confirmAction(
      "Permanently delete " + submitted.length + " selected empty " +
      (submitted.length === 1 ? "note" : "notes") + " from this group?\n\n" +
      "TreeNote will first create and retain a managed local safety backup. " +
      "The backend will skip notes that no longer qualify. Deletion cannot be undone without restoring a backup.",
      "Confirm permanent note deletion",
    );
    if (!agreed) return;
    setBusy("delete");
    setNotice(null);
    let result: CleanupResult;
    try {
      const requestId = createFlushRequestId();
      writeFlushRequest(requestId);
      await waitForFlushResult(requestId);
      result = await invoke<CleanupResult>("execute_empty_note_cleanup", {
        previewedIds: submitted,
        expectedNotebookPath: review.source.notebookPath,
        expectedDays: review.source.days,
      });
    } catch (error) {
      setNotice({ kind: "error", text: "Cleanup did not complete: " + message(error) });
      setBusy(null);
      return;
    }
    // Reuse fixed-group review bookkeeping. 'archivedIds' in that generic
    // session represents processed IDs here; no archiving happens in this flow.
    const session = completeArchiveReviewGroup(review.session, current, submitted, result.deletedIds);
    setReview({ ...review, session });
    advance(session, review.source);
    if (result.deletedIds.length) {
      try {
        localStorage.setItem("treenote-housekeeping-delete-result",
          JSON.stringify({ deletedIds: result.deletedIds, notebookPath: review.source.notebookPath, at: Date.now() }));
      } catch (error) {
        console.error("Deleted notes, but could not notify the main window:", error);
      }
    }
    const retained = actionable.length - submitted.length;
    setNotice({
      kind: result.skippedIds.length ? "info" : "success",
      text: "Group " + (current + 1) + ": " + result.deletedIds.length + " deleted, " +
        retained + " kept, " + result.skippedIds.length + " skipped after revalidation. " +
        "Safety backup: " + result.backupPath,
    });
    setBusy(null);
  };

  const switchToArchive = async () => {
    if (busy) return;
    if (review && (review.session.reviewedGroups.size ||
        review.session.selectedIds.size !== review.session.candidates.length)) {
      const agreed = await confirmAction(
        "Leave empty-note cleanup? Your current review choices and progress will be cleared; deleted notes stay deleted.",
        "Switch to archive review",
      );
      if (!agreed) return;
    }
    onArchive();
  };

  const selected = group.candidates.find((c) => c.id === focusedId);
  const disabled = busy !== null;

  return (
    <FluentProvider theme={resolvedTheme === "dark" ? webDarkTheme : webLightTheme}>
      <div className="housekeeping-root">
        <header className="housekeeping-header">
          <div className="housekeeping-heading">
            <h1>Empty-note cleanup</h1>
            <p>Review old, unused, genuinely empty leaf notes before permanently deleting them.</p>
            {review && <div className="housekeeping-notebook">
              {notebookName(review.source.notebookPath)} · Inactive {review.source.days}+ days · Manual deletion only
            </div>}
          </div>
          <div className="housekeeping-header-actions">
            <button type="button" className="options-btn options-btn-secondary" disabled={disabled}
              onClick={() => void switchToArchive()}>Archive review</button>
            <button type="button" className="options-btn options-btn-secondary" disabled={disabled}
              onClick={() => void scan(true)}>{busy === "scan" ? "Scanning…" : "New scan"}</button>
            <button type="button" className="options-btn options-btn-secondary" disabled={disabled}
              onClick={() => void getCurrentWindow().close()}>Close</button>
          </div>
        </header>
        {review && review.source.candidates.length > 0 && (
          <div className="housekeeping-progress" aria-label="Cleanup progress">
            <span>{reviewedCount} of {pageCount} groups reviewed</span>
            <span>{deletedCount} deleted · {keptCount} kept{skippedCount ? " · " + skippedCount + " skipped" : ""}</span>
            <div className="housekeeping-progress-track" role="progressbar" aria-valuemin={0}
              aria-valuemax={pageCount} aria-valuenow={reviewedCount}>
              <div style={{ width: (reviewedCount / pageCount * 100) + "%" }} />
            </div>
          </div>
        )}
        {notice && <div className={"housekeeping-notice housekeeping-notice-" + notice.kind}
          role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}
        {!review && <div className="housekeeping-empty" role="status">
          {busy === "scan" ? "Scanning for safely removable empty notes…" : "No cleanup scan loaded."}
        </div>}
        {review && review.source.candidates.length === 0 && <div className="housekeeping-empty">
          <h2>Nothing to delete</h2>
          <p>Only notes with verified autogenerated-title provenance and reliable lifecycle metadata qualify.
            Existing legacy and imported notes are not assumed safe.</p>
        </div>}
        {review && review.source.candidates.length > 0 && <>
          <nav className="housekeeping-group-bar" aria-label="Cleanup groups">
            <span className="housekeeping-group-heading">Group {current + 1} of {pageCount}</span>
            <span className="housekeeping-group-range">
              Notes {group.firstItem}–{group.lastItem} of {review.source.candidates.length}
            </span>
            <div className="housekeeping-group-controls">
              <button type="button" className="options-btn options-btn-secondary options-btn-compact"
                disabled={disabled || current === 0} onClick={() => moveTo(current - 1)}>Previous</button>
              <label className="housekeeping-group-jump">
                <span>Group</span>
                <select className="options-control" value={current} disabled={disabled}
                  onChange={(event) => moveTo(Number(event.target.value))} aria-label="Go to cleanup group">
                  {Array.from({ length: pageCount }, (_, i) =>
                    <option key={i} value={i}>{i + 1}{review.session.reviewedGroups.has(i) ? " (reviewed)" : ""}</option>)}
                </select>
              </label>
              <button type="button" className="options-btn options-btn-secondary options-btn-compact"
                disabled={disabled || current === pageCount - 1} onClick={() => moveTo(current + 1)}>Next</button>
            </div>
          </nav>
          <main className="housekeeping-workspace">
            <section className="housekeeping-branches" aria-label="Empty notes in current group">
              <div className="housekeeping-pane-header">
                <div><h2>Empty notes</h2><p>{ARCHIVE_BATCH_SIZE} per group · {actionable.length} available</p></div>
                {!reviewed && <div className="housekeeping-select-actions">
                  <button type="button" disabled={disabled || checked.length === actionable.length}
                    onClick={() => setReview((r) => r ? { ...r, session: setReviewGroupSelection(r.session, current, true) } : null)}>Select all</button>
                  <button type="button" disabled={disabled || !checked.length}
                    onClick={() => setReview((r) => r ? { ...r, session: setReviewGroupSelection(r.session, current, false) } : null)}>Select none</button>
                </div>}
              </div>
              <p className="housekeeping-pane-help">
                {reviewed ? "This group is reviewed. Reopen to reconsider retained notes." :
                  "Checked notes will be proposed for deletion. Click a title to inspect its details."}
              </p>
              <ul className="housekeeping-branch-list" key={current}>
                {group.candidates.map((candidate) => {
                  const deleted = review.session.archivedIds.has(candidate.id);
                  const skipped = review.session.unavailableIds.has(candidate.id);
                  const isSelected = review.session.selectedIds.has(candidate.id);
                  const status = deleted ? "Deleted" : skipped ? "Skipped" :
                    reviewed ? "Kept" : isSelected ? "Delete" : "Keep";
                  return <li className={"housekeeping-branch-row" +
                      (candidate.id === focusedId ? " housekeeping-branch-row-focused" : "")}
                    key={candidate.id}>
                    <input type="checkbox" className="options-checkbox"
                      aria-label={"Delete " + candidate.label + " in " + candidate.parentPath}
                      checked={!deleted && !skipped && isSelected}
                      disabled={disabled || reviewed || deleted || skipped}
                      onFocus={() => setFocusedId(candidate.id)}
                      onChange={(e) => setReview((r) => r ? {
                        ...r, session: setReviewCandidateSelected(r.session, current, candidate.id, e.target.checked),
                      } : null)} />
                    <button type="button" className="housekeeping-branch-title"
                      aria-pressed={candidate.id === focusedId}
                      onFocus={() => setFocusedId(candidate.id)}
                      onClick={() => setFocusedId(candidate.id)}>
                      <span className="housekeeping-branch-label">{candidate.label}</span>
                      <span className="housekeeping-branch-meta">{candidate.parentPath} · {status}</span>
                    </button>
                  </li>;
                })}
              </ul>
            </section>
            <section className="housekeeping-contents" aria-label="Empty note details">
              <div className="housekeeping-pane-header">
                <div><h2>Note details</h2><p>Read-only · Empty content verified at scan time</p></div>
              </div>
              <div className="housekeeping-contents-body">
                {!selected ? <p className="housekeeping-placeholder">
                  {finished ? "Review complete. Start a new scan if needed." : "Select a note to view its path and activity."}
                </p> : <>
                  <h3>{selected.label}</h3>
                  <dl className="housekeeping-detail-list">
                    <dt>Parent path</dt><dd>{selected.parentPath}</dd>
                    <dt>Created</dt><dd>{date(selected.createdAt)}</dd>
                    <dt>Last modified</dt><dd>{date(selected.modifiedAt)}</dd>
                    <dt>Last opened</dt><dd>{date(selected.lastAccessedAt)}</dd>
                    <dt>Last unarchived</dt><dd>{date(selected.lastUnarchivedAt)}</dd>
                    <dt>Content</dt><dd>Empty (zero characters)</dd>
                    <dt>Children</dt><dd>None, including archived descendants</dd>
                  </dl>
                  <p className="housekeeping-placeholder">This note was created with an automatically generated title and has no recorded title or content edits. These facts will be checked again before deletion.</p>
                  {review.session.archivedIds.has(selected.id) &&
                    <p className="housekeeping-placeholder">Deleted. Recovery requires restoring the safety backup.</p>}
                  {review.session.unavailableIds.has(selected.id) &&
                    <p className="housekeeping-placeholder">Skipped because the note no longer qualified.</p>}
                </>}
              </div>
            </section>
          </main>
          <footer className="housekeeping-footer">
            <div className="housekeeping-footer-detail">
              {reviewed ? <span>This group's decisions are recorded; kept notes remain in place.</span> :
                <span>{checked.length} of {actionable.length} available notes checked. Unchecked notes will be kept.</span>}
              <strong>Permanent deletion requires confirmation and a managed safety backup.</strong>
            </div>
            <div className="housekeeping-footer-actions">
              {reviewed ?
                <button type="button" className="options-btn options-btn-secondary" disabled={disabled}
                  onClick={() => setReview((r) => r ? {
                    ...r, session: reopenArchiveReviewGroup(r.session, current),
                  } : null)}>Reopen this group</button> : <>
                <button type="button" className="options-btn options-btn-secondary"
                  disabled={disabled} onClick={keep}>Keep entire group</button>
                <button type="button" className="options-btn options-btn-primary"
                  disabled={disabled || !checked.length} onClick={() => void deleteChecked()}>
                  {busy === "delete" ? "Backing up and deleting…" : "Delete " + checked.length + " checked…"}
                </button>
              </>}
            </div>
          </footer>
        </>}
      </div>
    </FluentProvider>
  );
}
