import assert from "node:assert/strict";
import test from "node:test";
import {
  isLatestAdminOverviewRequest,
  mergeAdminOverviewWithDrafts,
  type AdminEditableResource
} from "./admin-drafts";

type EditableState = Record<AdminEditableResource, unknown> & {
  calls: string[];
};

const freshState = (): EditableState => ({
  settings: { name: "Server venue" },
  tables: ["server-table"],
  waiters: ["server-waiter"],
  staffRoles: ["server-role"],
  checklistItems: ["server-checklist"],
  actions: ["server-action"],
  offers: ["server-offer"],
  calls: ["fresh-call"]
});

test("admin polling preserves every dirty editor and still refreshes live data", () => {
  const fresh = freshState();
  const current: EditableState = {
    ...freshState(),
    settings: { name: "Draft venue" },
    tables: ["draft-table"],
    waiters: ["draft-waiter"],
    staffRoles: ["new-role"],
    checklistItems: ["draft-checklist"],
    actions: ["draft-action"],
    offers: ["draft-offer"],
    calls: ["old-call"]
  };
  const dirty = new Set<AdminEditableResource>([
    "settings",
    "tables",
    "waiters",
    "staffRoles",
    "checklistItems",
    "actions",
    "offers"
  ]);

  const merged = mergeAdminOverviewWithDrafts(fresh, current, dirty);

  for (const resource of dirty) assert.equal(merged[resource], current[resource]);
  assert.equal(merged.calls, fresh.calls);
});

test("admin polling replaces clean resources and ignores an outdated response", () => {
  const fresh = freshState();
  const current = { ...freshState(), staffRoles: ["draft-role"], calls: ["old-call"] };

  assert.deepEqual(mergeAdminOverviewWithDrafts(fresh, current, new Set()), fresh);
  assert.equal(isLatestAdminOverviewRequest(4, 5), false);
  assert.equal(isLatestAdminOverviewRequest(5, 5), true);
});
