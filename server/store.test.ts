import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CHECKLIST_ITEM_COOLDOWN_MS, Store } from "./store";
import type { WaiterShift } from "./types";

const withStore = async (run: (store: Store) => Promise<void>) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrnastol-store-"));
  try {
    const store = new Store(directory);
    await store.init();
    await run(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const completeChecklistItems = async (
  store: Store,
  shift: WaiterShift,
  waiterId: string,
  indexes = shift.checklist.map((_, index) => index)
) => {
  let completionTimestamp = Math.max(
    new Date(shift.startedAt).getTime(),
    ...shift.checklist
      .map((item) => item.completedAt ? new Date(item.completedAt).getTime() : 0)
      .filter(Number.isFinite)
  );
  let current = shift;
  for (const index of indexes) {
    completionTimestamp += CHECKLIST_ITEM_COOLDOWN_MS;
    const result = await store.completeShiftChecklistItem(
      current.id,
      waiterId,
      index,
      new Date(completionTimestamp)
    );
    assert.equal(result.status, "completed");
    current = result.shift;
  }
  return current;
};

test("waiter receives table calls only after required checklist is complete", async () => {
  await withStore(async (store) => {
    const waiter = store.snapshot().waiters[0];
    await store.replaceWaiters([{ ...waiter, telegramChatId: "10001" }]);
    const result = await store.startWaiterShift(waiter.id, ["Зал 1-й этаж"]);
    assert.ok(result);
    assert.equal(result.shift.status, "checklist");

    const table = store.snapshot().tables.find((item) => item.zone === "Зал 1-й этаж");
    assert.ok(table);
    assert.deepEqual(table.waiterIds, [waiter.id]);
    assert.equal(store.waitersForTable(table).length, 0);
    const action = store.snapshot().actions[0];
    await store.upsertCall({ table, action, comment: "", guestName: "", assignedWaiterId: waiter.id, routingStage: "waiter", routingReason: "" });
    assert.equal(store.pendingCallsForWaiter(waiter.id).length, 0);

    await completeChecklistItems(store, result.shift, waiter.id);

    assert.equal(store.currentShiftForWaiter(waiter.id)?.status, "active");
    assert.equal(store.waitersForTable(table).length, 1);
    assert.equal(store.pendingCallsForWaiter(waiter.id).length, 1);

    const endedShift = await store.endWaiterShift(waiter.id);
    assert.ok(endedShift);
    assert.equal(store.waitersForTable(table).length, 0);
    assert.equal(store.findTableById(table.id)?.waiterIds.length, 0);

    const reviewed = await store.reviewShiftChecklist(endedShift.id, [
      { itemId: endedShift.checklist[0].itemId, score: 2, comment: "Нужно исправить" }
    ]);
    assert.ok(reviewed);
    const expectedScore = Math.round(((2 + (endedShift.checklist.length - 1) * 5) / endedShift.checklist.length) * 100) / 100;
    assert.equal(reviewed.score, expectedScore);
    assert.equal(store.waiterRatings()[0].score, expectedScore);
  });
});

test("checklist items require one minute between distinct completions", async () => {
  await withStore(async (store) => {
    const waiter = store.snapshot().waiters[0];
    const started = await store.startWaiterShift(waiter.id, [store.listZones()[0]]);
    assert.ok(started);
    assert.ok(started.shift.checklist.length >= 2);

    const firstCompletedAt = new Date(new Date(started.shift.startedAt).getTime() + 1_000);
    const first = await store.completeShiftChecklistItem(started.shift.id, waiter.id, 0, firstCompletedAt);
    assert.equal(first.status, "completed");

    const blocked = await store.completeShiftChecklistItem(
      started.shift.id,
      waiter.id,
      1,
      new Date(firstCompletedAt.getTime() + CHECKLIST_ITEM_COOLDOWN_MS - 1)
    );
    assert.equal(blocked.status, "cooldown");
    assert.equal(blocked.retryAfterSeconds, 1);
    assert.equal(blocked.shift.checklist[1].completedAt, null);

    const allowed = await store.completeShiftChecklistItem(
      started.shift.id,
      waiter.id,
      1,
      new Date(firstCompletedAt.getTime() + CHECKLIST_ITEM_COOLDOWN_MS)
    );
    assert.equal(allowed.status, "completed");
    assert.ok(allowed.shift.checklist[1].completedAt);
  });
});

test("repeated calls share one thread and reset after acceptance", async () => {
  await withStore(async (store) => {
    const table = store.snapshot().tables[0];
    const action = store.snapshot().actions[0];
    const first = await store.upsertCall({ table, action, comment: "", guestName: "", assignedWaiterId: null, routingStage: "waiter", routingReason: "" });
    const repeated = await store.upsertCall({ table, action, comment: "", guestName: "", assignedWaiterId: null, routingStage: "waiter", routingReason: "" });

    assert.equal(repeated.id, first.id);
    assert.equal(repeated.pressCount, 2);
    assert.equal(repeated.reasonCounts[0].count, 2);

    await store.updateCallStatus(first.id, "accepted", null);
    const nextCycle = await store.upsertCall({ table, action, comment: "", guestName: "", assignedWaiterId: null, routingStage: "waiter", routingReason: "" });
    assert.equal(nextCycle.id, first.id);
    assert.equal(nextCycle.status, "new");
    assert.equal(nextCycle.pressCount, 1);

    await store.completeCall(first.id);
    const nextGuests = await store.upsertCall({ table, action, comment: "", guestName: "", assignedWaiterId: null, routingStage: "waiter", routingReason: "" });
    assert.notEqual(nextGuests.id, first.id);
    assert.equal(nextGuests.pressCount, 1);
  });
});

test("a task scheduled for today is appended to an already running shift", async () => {
  await withStore(async (store) => {
    const waiter = store.snapshot().waiters[0];
    const zone = store.listZones()[0];
    const started = await store.startWaiterShift(waiter.id, [zone]);
    assert.ok(started);

    await completeChecklistItems(store, started.shift, waiter.id);
    assert.equal(store.currentShiftForWaiter(waiter.id)?.status, "active");

    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Astrakhan" }).format(new Date());
    const task = await store.addShiftTask({
      roleId: waiter.roleId,
      waiterId: waiter.id,
      date,
      title: "Проверить персональное задание",
      description: "Добавлено после начала смены",
      requiredForCalls: true,
      countsForRating: true
    });

    const updated = store.currentShiftForWaiter(waiter.id);
    assert.ok(updated);
    assert.equal(updated.status, "checklist");
    assert.ok(updated.checklist.some((item) => item.itemId === `task-${task.id}`));

    const taskIndex = updated.checklist.findIndex((item) => item.itemId === `task-${task.id}`);
    await completeChecklistItems(store, updated, waiter.id, [taskIndex]);
    assert.equal(store.currentShiftForWaiter(waiter.id)?.status, "active");
  });
});

test("shift rating uses five stars and ignores excluded tasks", async () => {
  await withStore(async (store) => {
    const waiter = store.snapshot().waiters[0];
    await store.replaceChecklistItems([
      ...Array.from({ length: 14 }, (_, index) => ({
        id: `rated-${index}`,
        roleId: waiter.roleId,
        title: `Оцениваемая задача ${index + 1}`,
        description: "",
        requiredForCalls: false,
        countsForRating: true,
        active: true,
        sort: (index + 1) * 10
      })),
      {
        id: "excluded-task",
        roleId: waiter.roleId,
        title: "Информационный пункт",
        description: "",
        requiredForCalls: false,
        countsForRating: false,
        active: true,
        sort: 200
      }
    ]);
    const started = await store.startWaiterShift(waiter.id, [store.listZones()[0]]);
    assert.ok(started);
    await completeChecklistItems(store, started.shift, waiter.id, [...Array.from({ length: 7 }, (_, index) => index), 14]);
    const ended = await store.endWaiterShift(waiter.id);
    assert.ok(ended);
    assert.equal(ended.score, 2.5);
    const rating = store.waiterRatings(waiter.roleId)[0];
    assert.equal(rating.score, 2.5);
    assert.equal(rating.totalStars, 2.5);
    assert.equal(rating.ratedTaskCount, 14);
    assert.equal(rating.completedRatedTaskCount, 7);
    assert.equal(rating.completionRate, 50);
  });
});

test("performance analytics finds repeated task and employee failures", async () => {
  await withStore(async (store) => {
    const waiter = store.snapshot().waiters[0];
    await store.replaceChecklistItems([{
      id: "station-standard",
      roleId: waiter.roleId,
      title: "Подготовить рабочую станцию",
      description: "",
      requiredForCalls: false,
      countsForRating: true,
      active: true,
      sort: 10
    }]);
    const zone = store.listZones()[0];
    const first = await store.startWaiterShift(waiter.id, [zone]);
    assert.ok(first);
    const completion = await store.completeShiftChecklistItem(first.shift.id, waiter.id, 0);
    assert.equal(completion.status, "completed");
    const firstEnded = await store.endWaiterShift(waiter.id);
    assert.ok(firstEnded);
    await store.reviewShiftChecklist(firstEnded.id, [{ itemId: firstEnded.checklist[0].itemId, score: 2, comment: "Низкое качество" }]);

    const second = await store.startWaiterShift(waiter.id, [zone]);
    assert.ok(second);
    await store.endWaiterShift(waiter.id);

    const rating = store.waiterRatings(waiter.roleId)[0];
    assert.equal(rating.score, 1);
    assert.equal(rating.totalStars, 2);
    assert.equal(rating.shiftCount, 2);
    const analytics = store.performanceAnalytics([waiter.roleId]);
    assert.equal(analytics.taskPatterns[0].assignments, 2);
    assert.equal(analytics.taskPatterns[0].missed, 1);
    assert.equal(analytics.taskPatterns[0].lowRatings, 1);
    assert.equal(analytics.taskPatterns[0].issueRate, 100);
    assert.equal(analytics.employeePatterns[0].waiterId, waiter.id);
  });
});
