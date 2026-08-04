export const ADMIN_EDITABLE_RESOURCES = [
  "settings",
  "tables",
  "waiters",
  "staffRoles",
  "checklistItems",
  "checklistWindows",
  "actions",
  "offers"
] as const;

export type AdminEditableResource = (typeof ADMIN_EDITABLE_RESOURCES)[number];

export function mergeAdminOverviewWithDrafts<
  T extends Record<AdminEditableResource, unknown>
>(
  fresh: T,
  current: T | null,
  dirtyResources: ReadonlySet<AdminEditableResource>
): T {
  if (!current || dirtyResources.size === 0) return fresh;

  const merged = { ...fresh };
  for (const resource of dirtyResources) {
    merged[resource] = current[resource];
  }
  return merged;
}

export function isLatestAdminOverviewRequest(requestId: number, latestRequestId: number) {
  return requestId === latestRequestId;
}
