import { describe, expect, it } from "vitest";
import {
  backupDisplayLabel,
  filterBackupGroups,
  formatBackupLabel,
  groupBackupListItems,
  type ManagedBackupEntry,
} from "./backupList";

describe("backupList", () => {
  it("falls back to timestamp label when no user label", () => {
    const entry: ManagedBackupEntry = { timestamp: 1_700_000_000, label: null, locked: false };
    expect(backupDisplayLabel(entry)).toBe(formatBackupLabel(entry.timestamp));
  });

  it("uses user label when present", () => {
    const entry: ManagedBackupEntry = {
      timestamp: 1_700_000_000,
      label: "Before release",
      locked: false,
    };
    expect(backupDisplayLabel(entry)).toBe("Before release");
  });

  it("filters by user label text", () => {
    const backups: ManagedBackupEntry[] = [
      { timestamp: 1_700_000_000, label: "Before release", locked: false },
      { timestamp: 1_700_000_100, label: null, locked: false },
    ];
    const groups = groupBackupListItems(backups);
    const filtered = filterBackupGroups(groups, backups, "release");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.items).toHaveLength(1);
    expect(filtered[0]?.items[0]?.userLabel).toBe("Before release");
  });

  it("groups backups into today, yesterday and older buckets", () => {
    const now = Math.floor(Date.now() / 1000);
    const backups: ManagedBackupEntry[] = [
      { timestamp: now - 60, label: null, locked: false },
      { timestamp: now - 86_400 - 60, label: null, locked: false },
      { timestamp: now - 86_400 * 3, label: null, locked: false },
    ];
    const groups = groupBackupListItems(backups);
    expect(groups.map((group) => group.id)).toEqual(["today", "yesterday", "older"]);
  });
});
