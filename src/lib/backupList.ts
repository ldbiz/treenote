export type ManagedBackupEntry = {
  timestamp: number;
  label?: string | null;
  locked: boolean;
};

export type ManagedBackupList = {
  entries: ManagedBackupEntry[];
  metadata_warning?: string | null;
};

export function formatBackupLabel(timestampSecs: number): string {
  const date = new Date(timestampSecs * 1000);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (date >= startOfToday) {
    return `Today, ${time}`;
  }
  if (date >= startOfYesterday) {
    return `Yesterday, ${time}`;
  }
  const day = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${day}, ${time}`;
}

export type BackupListGroupId = "today" | "yesterday" | "older";

export type BackupListGroup = {
  id: BackupListGroupId;
  title: string;
  items: { timestamp: number; label: string; userLabel?: string | null; locked: boolean }[];
};

function backupDateGroup(timestampSecs: number): BackupListGroupId {
  const date = new Date(timestampSecs * 1000);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (date >= startOfToday) return "today";
  if (date >= startOfYesterday) return "yesterday";
  return "older";
}

function formatBackupListItemLabel(timestampSecs: number, group: BackupListGroupId): string {
  const date = new Date(timestampSecs * 1000);
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (group === "today" || group === "yesterday") {
    return time;
  }
  const day = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${day}, ${time}`;
}

export function backupDisplayLabel(entry: ManagedBackupEntry): string {
  const trimmed = entry.label?.trim();
  if (trimmed) return trimmed;
  return formatBackupLabel(entry.timestamp);
}

const BACKUP_GROUP_ORDER: BackupListGroupId[] = ["today", "yesterday", "older"];
const BACKUP_GROUP_TITLES: Record<BackupListGroupId, string> = {
  today: "Today",
  yesterday: "Yesterday",
  older: "Older",
};

export function groupBackupListItems(backups: ManagedBackupEntry[]): BackupListGroup[] {
  const buckets = new Map<
    BackupListGroupId,
    { timestamp: number; label: string; userLabel?: string | null; locked: boolean }[]
  >();
  for (const groupId of BACKUP_GROUP_ORDER) {
    buckets.set(groupId, []);
  }
  for (const backup of backups) {
    const groupId = backupDateGroup(backup.timestamp);
    buckets.get(groupId)?.push({
      timestamp: backup.timestamp,
      label: formatBackupListItemLabel(backup.timestamp, groupId),
      userLabel: backup.label,
      locked: backup.locked,
    });
  }
  return BACKUP_GROUP_ORDER.flatMap((groupId) => {
    const items = buckets.get(groupId) ?? [];
    if (items.length === 0) return [];
    return [{ id: groupId, title: BACKUP_GROUP_TITLES[groupId], items }];
  });
}

function backupItemMatchesFilter(
  entry: ManagedBackupEntry,
  groupId: BackupListGroupId,
  itemLabel: string,
  query: string,
): boolean {
  const haystack = [
    itemLabel,
    backupDisplayLabel(entry),
    formatBackupLabel(entry.timestamp),
    BACKUP_GROUP_TITLES[groupId],
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

export function filterBackupGroups(
  groups: BackupListGroup[],
  backups: ManagedBackupEntry[],
  filterQuery: string,
): BackupListGroup[] {
  const query = filterQuery.trim().toLowerCase();
  if (!query) return groups;
  const byTimestamp = new Map(backups.map((entry) => [entry.timestamp, entry]));
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        const entry = byTimestamp.get(item.timestamp);
        if (!entry) return false;
        return backupItemMatchesFilter(entry, group.id, item.label, query);
      }),
    }))
    .filter((group) => group.items.length > 0);
}
