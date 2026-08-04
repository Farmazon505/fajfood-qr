import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CHECKLIST_WINDOWS,
  checklistWindowStatus,
  groupChecklistByPhase,
  normalizeChecklistWindows,
  openingPhaseForShiftStart
} from "./checklists";
import type { ShiftChecklistEntry } from "../server/types";

const atAstrakhan = (localIso: string) => new Date(`${localIso}+04:00`);

test("checklist defaults expose morning, evening and overnight closing windows", () => {
  assert.deepEqual(normalizeChecklistWindows(undefined), DEFAULT_CHECKLIST_WINDOWS);
  assert.equal(
    checklistWindowStatus("opening", DEFAULT_CHECKLIST_WINDOWS, "2026-08-04", atAstrakhan("2026-08-04T10:00:00"), "Europe/Astrakhan"),
    "available"
  );
  assert.equal(
    checklistWindowStatus("evening", DEFAULT_CHECKLIST_WINDOWS, "2026-08-04", atAstrakhan("2026-08-04T17:59:00"), "Europe/Astrakhan"),
    "not_started"
  );
  assert.equal(
    checklistWindowStatus("closing", DEFAULT_CHECKLIST_WINDOWS, "2026-08-04", atAstrakhan("2026-08-05T01:59:00"), "Europe/Astrakhan"),
    "available"
  );
  assert.equal(
    checklistWindowStatus("closing", DEFAULT_CHECKLIST_WINDOWS, "2026-08-04", atAstrakhan("2026-08-05T02:01:00"), "Europe/Astrakhan"),
    "closed"
  );
});

test("shift start selects morning opening before its cutoff and evening opening afterwards", () => {
  assert.equal(
    openingPhaseForShiftStart(DEFAULT_CHECKLIST_WINDOWS, "2026-08-04", atAstrakhan("2026-08-04T09:30:00"), "Europe/Astrakhan"),
    "opening"
  );
  assert.equal(
    openingPhaseForShiftStart(DEFAULT_CHECKLIST_WINDOWS, "2026-08-04", atAstrakhan("2026-08-04T13:00:00"), "Europe/Astrakhan"),
    "evening"
  );
  assert.equal(
    openingPhaseForShiftStart(DEFAULT_CHECKLIST_WINDOWS, "2026-08-04", atAstrakhan("2026-08-04T18:30:00"), "Europe/Astrakhan"),
    "evening"
  );
});

test("phase grouping returns collapsed-summary metrics in deterministic order", () => {
  const entry = (itemId: string, phase: ShiftChecklistEntry["phase"], completed: boolean, score: number | null): ShiftChecklistEntry => ({
    itemId,
    phase,
    title: itemId,
    description: "",
    requiredForCalls: false,
    countsForRating: true,
    sort: 10,
    completedAt: completed ? "2026-08-04T08:00:00.000Z" : null,
    adminScore: score,
    adminComment: "",
    adminPhotoUrl: "",
    reviewedAt: score === null ? null : "2026-08-04T09:00:00.000Z",
    reviewedByRole: score === null ? null : "admin",
    reviewedByUsername: score === null ? "" : "admin"
  });
  const groups = groupChecklistByPhase([
    entry("closing", "closing", false, null),
    entry("evening", "evening", true, 4),
    entry("opening-a", "opening", true, 5),
    entry("opening-b", "opening", false, 3)
  ]);

  assert.deepEqual(groups.map((group) => group.phase), ["opening", "evening", "closing"]);
  assert.deepEqual(
    groups.map(({ completed, reviewed, averageScore }) => ({ completed, reviewed, averageScore })),
    [
      { completed: 1, reviewed: 2, averageScore: 4 },
      { completed: 1, reviewed: 1, averageScore: 4 },
      { completed: 0, reviewed: 0, averageScore: null }
    ]
  );
});
