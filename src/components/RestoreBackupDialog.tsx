import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from "@fluentui/react-components";
import {
  backupDisplayLabel,
  filterBackupGroups,
  groupBackupListItems,
  type ManagedBackupEntry,
} from "../lib/backupList";

interface RestoreBackupDialogProps {
  open: boolean;
  backups: ManagedBackupEntry[];
  selectedTimestamp: number | null;
  backupBeforeRestore: boolean;
  busy?: boolean;
  onSelect: (timestamp: number) => void;
  onClearSelection: () => void;
  onBackupBeforeRestoreChange: (enabled: boolean) => void;
  onKeepSelectedChange: (locked: boolean) => void;
  onRestore: () => void;
  onCancel: () => void;
}

export default function RestoreBackupDialog({
  open,
  backups,
  selectedTimestamp,
  backupBeforeRestore,
  busy = false,
  onSelect,
  onClearSelection,
  onBackupBeforeRestoreChange,
  onKeepSelectedChange,
  onRestore,
  onCancel,
}: RestoreBackupDialogProps) {
  const [filterQuery, setFilterQuery] = useState("");
  const [olderExpanded, setOlderExpanded] = useState(false);

  const groups = useMemo(() => groupBackupListItems(backups), [backups]);
  const filteredGroups = useMemo(
    () => filterBackupGroups(groups, backups, filterQuery),
    [groups, backups, filterQuery],
  );
  const isFiltering = filterQuery.trim().length > 0;
  const olderGroup = groups.find((group) => group.id === "older");
  const olderCount = olderGroup?.items.length ?? 0;
  const selectedEntry =
    selectedTimestamp === null
      ? null
      : backups.find((entry) => entry.timestamp === selectedTimestamp) ?? null;

  useEffect(() => {
    if (!open) return;
    setFilterQuery("");
    setOlderExpanded(false);
  }, [open]);

  useEffect(() => {
    if (selectedTimestamp === null) return;
    const stillVisible = filteredGroups.some((group) =>
      group.items.some((item) => item.timestamp === selectedTimestamp),
    );
    if (!stillVisible) {
      onClearSelection();
    }
  }, [filteredGroups, onClearSelection, selectedTimestamp]);

  const showOlderItems = isFiltering || olderExpanded;

  return (
    <Dialog
      open={open}
      modalType="modal"
      onOpenChange={(_, data) => {
        if (!data.open && !busy) onCancel();
      }}
    >
      <DialogSurface className="app-dialog-surface restore-backup-dialog-surface">
        <DialogBody className="app-dialog-body">
          <DialogTitle className="app-dialog-title">Restore from backup</DialogTitle>
          <DialogContent className="app-dialog-content restore-backup-dialog-content">
            <p className="restore-backup-dialog-intro">
              Choose a recovery point for this notebook. Newest backups are listed first.
            </p>
            <label className="restore-backup-filter">
              <span className="restore-backup-filter-label">Filter backups</span>
              <input
                type="search"
                className="options-control"
                value={filterQuery}
                disabled={busy}
                placeholder="Filter by date, time or label"
                onChange={(event) => setFilterQuery(event.target.value)}
              />
              <p className="options-field-hint">
                Try a month, date, time or label, e.g. Aug or Before release.
              </p>
            </label>
            <div
              className="restore-backup-list"
              role="radiogroup"
              aria-label="Available backups"
            >
              {filteredGroups.length === 0 ? (
                <p className="restore-backup-empty">No backups match your filter.</p>
              ) : (
                filteredGroups.map((group) => {
                  const isOlder = group.id === "older";
                  if (isOlder && !showOlderItems) {
                    return (
                      <div key={group.id} className="restore-backup-group restore-backup-group-collapsed">
                        <button
                          type="button"
                          className="restore-backup-toggle-older"
                          disabled={busy}
                          onClick={() => setOlderExpanded(true)}
                        >
                          Show older backups ({olderCount})
                        </button>
                      </div>
                    );
                  }

                  return (
                    <div key={group.id} className="restore-backup-group">
                      <div className="restore-backup-group-header">
                        <div className="restore-backup-group-title">{group.title}</div>
                        {isOlder && !isFiltering && olderExpanded ? (
                          <button
                            type="button"
                            className="restore-backup-toggle-older restore-backup-toggle-older-compact"
                            disabled={busy}
                            onClick={() => setOlderExpanded(false)}
                          >
                            Hide
                          </button>
                        ) : null}
                      </div>
                      <ul className="restore-backup-group-items">
                        {group.items.map((item) => {
                          const selected = selectedTimestamp === item.timestamp;
                          const entry =
                            backups.find((backup) => backup.timestamp === item.timestamp) ??
                            item;
                          const displayLabel = backupDisplayLabel({
                            timestamp: item.timestamp,
                            label: item.userLabel ?? null,
                            locked: item.locked,
                          });
                          return (
                            <li key={item.timestamp}>
                              <label
                                className={`restore-backup-option${selected ? " restore-backup-option-selected" : ""}`}
                              >
                                <input
                                  type="radio"
                                  name="restore-backup-choice"
                                  checked={selected}
                                  disabled={busy}
                                  onChange={() => onSelect(item.timestamp)}
                                />
                                <span className="restore-backup-option-label">
                                  <span>{displayLabel}</span>
                                  {entry.locked ? (
                                    <span className="restore-backup-kept-tag">Kept</span>
                                  ) : null}
                                </span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })
              )}
            </div>
          </DialogContent>
          <DialogActions className="app-dialog-actions restore-backup-dialog-actions">
            <div className="restore-backup-dialog-options">
              <label className="options-field options-checkbox-field restore-backup-dialog-checkbox">
                <input
                  type="checkbox"
                  className="options-checkbox"
                  checked={backupBeforeRestore}
                  disabled={busy}
                  onChange={(event) => onBackupBeforeRestoreChange(event.target.checked)}
                />
                <span className="options-checkbox-label">
                  Create a backup of the current notebook first
                </span>
              </label>
              {selectedEntry ? (
                <label className="options-field options-checkbox-field restore-backup-dialog-checkbox">
                  <input
                    type="checkbox"
                    className="options-checkbox"
                    checked={selectedEntry.locked}
                    disabled={busy}
                    onChange={(event) => onKeepSelectedChange(event.target.checked)}
                  />
                  <span className="options-checkbox-label">Keep selected backup</span>
                </label>
              ) : null}
            </div>
            <div className="restore-backup-dialog-buttons">
              <button
                type="button"
                className="app-dialog-button"
                disabled={busy}
                onClick={onCancel}
              >
                Cancel
              </button>
              <button
                type="button"
                className="app-dialog-button app-dialog-danger"
                disabled={busy || selectedTimestamp === null}
                onClick={onRestore}
              >
                {busy ? "Restoring…" : "Restore"}
              </button>
            </div>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
