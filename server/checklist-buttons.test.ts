import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CHECKLIST_WINDOWS } from "../shared/checklists";
import { MaxService } from "./max";
import { Store } from "./store";
import { TelegramService } from "./telegram";
import type { ChecklistPhase, WaiterShift } from "./types";

const shiftWithEveryPhase = (): WaiterShift => ({
  id: "shift-all-phases",
  waiterId: "waiter",
  waiterName: "Официант",
  roleId: "waiter",
  roleName: "Официант",
  roleKind: "waiter",
  zones: ["Зал"],
  status: "checklist",
  checklist: (["opening", "evening", "closing"] as ChecklistPhase[]).map((phase, index) => ({
    itemId: `${phase}-${index}`,
    phase,
    title: phase,
    description: "",
    requiredForCalls: phase !== "closing",
    countsForRating: true,
    sort: (index + 1) * 10,
    completedAt: null,
    adminScore: null,
    adminComment: "",
    adminPhotoUrl: "",
    reviewedAt: null,
    reviewedByRole: null,
    reviewedByUsername: ""
  })),
  score: 0,
  startedAt: "2026-08-04T06:00:00.000Z",
  readyAt: null,
  endedAt: null,
  morningGreetingDate: "2026-08-04",
  checklistOverdueNotifiedAt: null,
  closingChecklistIncompleteNotifiedAt: null,
  endedAutomatically: false,
  adminReviewRequiredCount: 0,
  adminReviewMissingCount: 0,
  adminRatingPenaltyStars: 0,
  adminPenaltyItemCount: 0,
  adminPenaltyAmount: 0,
  adminPenaltyReceiptUrl: "",
  adminPenaltyReceiptAt: null,
  adminPenaltyReceiptMessenger: null
});

const storeWithClosedWindows = {
  checklistPhaseWindowStatus: () => "closed",
  snapshot: () => ({ checklistWindows: DEFAULT_CHECKLIST_WINDOWS })
} as unknown as Store;

test("Telegram keeps opening, evening and closing checklist buttons clickable outside their windows", () => {
  const service = new TelegramService(storeWithClosedWindows, "test-token", 10);
  const keyboard = (service as unknown as {
    checklistKeyboard: (shift: WaiterShift) => { inline_keyboard: Array<Array<{ callback_data: string }>> };
  }).checklistKeyboard(shiftWithEveryPhase());

  assert.deepEqual(
    keyboard.inline_keyboard.flat().map((button) => button.callback_data),
    [
      "check:shift-all-phases:0",
      "check:shift-all-phases:1",
      "check:shift-all-phases:2"
    ]
  );
});

test("MAX keeps opening, evening and closing checklist buttons clickable outside their windows", () => {
  const service = new MaxService(storeWithClosedWindows, "test-token");
  const body = (service as unknown as {
    checklistBody: (shift: WaiterShift) => { attachments: unknown };
  }).checklistBody(shiftWithEveryPhase());
  const serialized = JSON.stringify(body.attachments);

  assert.match(serialized, /check:shift-all-phases:0/);
  assert.match(serialized, /check:shift-all-phases:1/);
  assert.match(serialized, /check:shift-all-phases:2/);
});
