import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ADMIN_ACK_TIMEOUT_MS,
  CHECKLIST_ITEM_COOLDOWN_MS,
  Store,
  WAITER_ACCEPT_TIMEOUT_MS,
  WAITER_COMPLETE_TIMEOUT_MS
} from "./store";
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

test("a supervisor can end only an unassigned waiter shift", async () => {
  await withStore(async (store) => {
    const waiter = store.snapshot().waiters[0];
    const started = await store.startWaiterShift(waiter.id, [store.listZones()[0]]);
    assert.ok(started);

    const blocked = await store.endWaiterShiftBySupervisor(started.shift.id);
    assert.equal(blocked.status, "tables_assigned");
    if (blocked.status === "tables_assigned") assert.ok(blocked.tableCount > 0);
    assert.ok(store.currentShiftForWaiter(waiter.id));

    await store.replaceTables(store.snapshot().tables.map((table) => ({
      ...table,
      waiterId: null,
      waiterIds: []
    })));
    const ended = await store.endWaiterShiftBySupervisor(started.shift.id);
    assert.equal(ended.status, "ended");
    assert.equal(store.currentShiftForWaiter(waiter.id), null);

    const repeated = await store.endWaiterShiftBySupervisor(started.shift.id);
    assert.equal(repeated.status, "already_ended");

    const admin = {
      id: "admin-shift-test",
      name: "Тестовый администратор",
      roleId: "admin",
      telegramChatId: "",
      maxUserId: "",
      tipUrl: "",
      active: true
    };
    await store.replaceWaiters([...store.snapshot().waiters, admin]);
    const adminShift = await store.startWaiterShift(admin.id, [store.listZones()[0]]);
    assert.ok(adminShift);
    const forbidden = await store.endWaiterShiftBySupervisor(adminShift.shift.id);
    assert.equal(forbidden.status, "not_waiter");
    assert.ok(store.currentShiftForWaiter(admin.id));
  });
});

test("open employee shifts end automatically when the venue date changes", async () => {
  await withStore(async (store) => {
    const waiter = store.snapshot().waiters[0];
    const admin = {
      id: "admin-midnight-test",
      name: "Администратор полуночи",
      roleId: "admin",
      telegramChatId: "",
      maxUserId: "",
      tipUrl: "",
      active: true
    };
    await store.replaceWaiters([...store.snapshot().waiters, admin]);

    const zone = store.listZones()[0];
    const waiterShift = await store.startWaiterShift(waiter.id, [zone]);
    const adminShift = await store.startWaiterShift(admin.id, [zone]);
    assert.ok(waiterShift);
    assert.ok(adminShift);
    assert.ok(store.snapshot().tables.some((table) => table.waiterIds.includes(waiter.id)));

    const [year, month, day] = waiterShift.shift.morningGreetingDate.split("-").map(Number);
    const nextDateKey = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
    const endedAt = new Date(`${nextDateKey}T00:00:05.000Z`);
    assert.deepEqual(
      await store.endOpenShiftsBeforeDate(waiterShift.shift.morningGreetingDate, endedAt),
      []
    );
    assert.ok(store.currentShiftForWaiter(waiter.id));
    const ended = await store.endOpenShiftsBeforeDate(nextDateKey, endedAt);

    assert.equal(ended.length, 2);
    assert.ok(ended.every((shift) => shift.status === "ended" && shift.endedAt === endedAt.toISOString()));
    assert.equal(store.currentShiftForWaiter(waiter.id), null);
    assert.equal(store.currentShiftForWaiter(admin.id), null);
    assert.ok(store.snapshot().tables.every((table) => !table.waiterIds.includes(waiter.id)));
    assert.deepEqual(await store.endOpenShiftsBeforeDate(nextDateKey, endedAt), []);
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

test("calls escalate after one minute without acceptance and two minutes without completion", async () => {
  await withStore(async (store) => {
    const [firstTable, secondTable] = store.snapshot().tables;
    const action = store.snapshot().actions[0];

    const unanswered = await store.upsertCall({
      table: firstTable,
      action,
      comment: "",
      guestName: "",
      assignedWaiterId: null,
      routingStage: "waiter",
      routingReason: ""
    });
    const unansweredAt = new Date(unanswered.lastRequestedAt).getTime();
    assert.equal(store.callsDueForAdminEscalation(unansweredAt + WAITER_ACCEPT_TIMEOUT_MS - 1).length, 0);
    assert.equal(store.callsDueForAdminEscalation(unansweredAt + WAITER_ACCEPT_TIMEOUT_MS).length, 1);

    const adminCall = await store.startAdminEscalation(
      unanswered.id,
      "Официант не принял вызов в течение 1 минуты.",
      []
    );
    assert.equal(adminCall?.routingStage, "admin");
    const adminStartedAt = new Date(adminCall?.adminEscalationStartedAt || "").getTime();
    assert.equal(store.callsDueForOwnerEscalation(adminStartedAt + ADMIN_ACK_TIMEOUT_MS - 1).length, 0);
    assert.equal(store.callsDueForOwnerEscalation(adminStartedAt + ADMIN_ACK_TIMEOUT_MS).length, 1);

    const acknowledged = await store.acknowledgeEscalation(unanswered.id, "admin");
    assert.ok(acknowledged?.adminAcknowledgedAt);
    assert.equal(store.callsDueForOwnerEscalation(adminStartedAt + ADMIN_ACK_TIMEOUT_MS + 1).length, 0);

    const accepted = await store.upsertCall({
      table: secondTable,
      action,
      comment: "",
      guestName: "",
      assignedWaiterId: null,
      routingStage: "waiter",
      routingReason: ""
    });
    const acceptedCall = await store.updateCallStatus(accepted.id, "accepted");
    const acceptedAt = new Date(acceptedCall?.acceptedAt || "").getTime();
    assert.equal(store.callsDueForAdminEscalation(acceptedAt + WAITER_COMPLETE_TIMEOUT_MS - 1).length, 0);
    assert.equal(store.callsDueForAdminEscalation(acceptedAt + WAITER_COMPLETE_TIMEOUT_MS).length, 1);

    const slowCall = await store.startAdminEscalation(
      accepted.id,
      "Официант принял вызов, но не завершил его в течение 2 минут.",
      []
    );
    const slowAdminStartedAt = new Date(slowCall?.adminEscalationStartedAt || "").getTime();
    assert.equal(store.callsDueForOwnerEscalation(slowAdminStartedAt + ADMIN_ACK_TIMEOUT_MS).length, 1);

    const ownerCall = await store.markOwnerEscalated(
      accepted.id,
      "Администратор не подтвердил вызов в течение 1 минуты."
    );
    assert.equal(ownerCall?.routingStage, "owner");
    assert.ok(ownerCall?.ownerEscalatedAt);
    assert.equal(ownerCall?.status, "accepted");

    const ownerAcknowledged = await store.acknowledgeEscalation(accepted.id, "owner");
    assert.ok(ownerAcknowledged?.ownerAcknowledgedAt);
  });
});

test("owner profile controls Telegram and MAX escalation channels", async () => {
  await withStore(async (store) => {
    const settings = await store.updateOwnerNotifications({
      telegramChatId: "30001",
      maxUserId: "40001",
      telegramEnabled: true,
      maxEnabled: false
    });
    assert.equal(settings.configured, true);
    assert.equal(settings.telegramEnabled, true);
    assert.equal(settings.maxEnabled, false);

    const recipients = store.ownersForEscalation();
    assert.equal(recipients.length, 1);
    assert.equal(recipients[0].telegramChatId, "30001");
    assert.equal(recipients[0].maxUserId, "");
    assert.equal(store.findWaiterByChatId("30001")?.roleId, "owner");
    assert.equal(store.findWaiterByMaxUserId("40001"), null);

    const table = store.snapshot().tables[0];
    const action = store.snapshot().actions[0];
    const call = await store.upsertCall({
      table,
      action,
      comment: "",
      guestName: "",
      assignedWaiterId: null,
      routingStage: "owner",
      routingReason: "Администратор не в сети."
    });
    const accepted = await store.acceptCall(call.id, recipients[0].id);
    assert.equal(accepted?.accepted, true);
    assert.ok(accepted?.call.ownerAcknowledgedAt);

    await store.updateOwnerNotifications({
      telegramChatId: "30001",
      maxUserId: "40001",
      telegramEnabled: false,
      maxEnabled: false
    });
    assert.deepEqual(store.ownersForEscalation(), []);
    assert.equal(store.findWaiterByChatId("30001"), null);
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

    const completed = await store.completeShiftTask(task.id, waiter.id);
    assert.equal(completed.status, "completed");
    assert.equal(store.currentShiftForWaiter(waiter.id)?.status, "active");
    assert.ok(store.currentShiftForWaiter(waiter.id)?.checklist.find(
      (item) => item.itemId === `task-${task.id}`
    )?.completedAt);
  });
});

test("an incomplete personal dated task is carried forward once per new date", async () => {
  await withStore(async (store) => {
    const waiter = store.snapshot().waiters[0];
    const original = await store.addShiftTask({
      roleId: waiter.roleId,
      waiterId: waiter.id,
      date: "2026-01-10",
      title: "Перенести невыполненное задание",
      description: "Задание должно оставаться у сотрудника до выполнения",
      requiredForCalls: true,
      countsForRating: true
    });

    const firstCarry = await store.rolloverIncompleteShiftTasks(
      "2026-01-11",
      new Date("2026-01-11T00:01:00+04:00")
    );
    assert.equal(firstCarry.length, 1);
    assert.equal(firstCarry[0].waiterId, waiter.id);
    assert.equal(firstCarry[0].date, "2026-01-11");
    assert.equal(firstCarry[0].carriedFromTaskId, original.id);
    assert.equal(firstCarry[0].notified, false);
    assert.ok(store.findShiftTask(original.id)?.rolloverProcessedAt);

    const repeatedRun = await store.rolloverIncompleteShiftTasks(
      "2026-01-11",
      new Date("2026-01-11T00:02:00+04:00")
    );
    assert.equal(repeatedRun.length, 0);
    assert.equal(store.listShiftTasks().length, 2);

    const secondCarry = await store.rolloverIncompleteShiftTasks(
      "2026-01-12",
      new Date("2026-01-12T00:01:00+04:00")
    );
    assert.equal(secondCarry.length, 1);
    assert.equal(secondCarry[0].carriedFromTaskId, firstCarry[0].id);
    assert.equal(store.listShiftTasks().length, 3);
  });
});

test("a completed dated task is not carried forward", async () => {
  await withStore(async (store) => {
    const waiter = store.snapshot().waiters[0];
    const zone = store.listZones()[0];
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Astrakhan" }).format(new Date());
    const nextDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Astrakhan" }).format(
      new Date(new Date(`${date}T12:00:00+04:00`).getTime() + 24 * 60 * 60 * 1000)
    );
    const task = await store.addShiftTask({
      roleId: waiter.roleId,
      waiterId: waiter.id,
      date,
      title: "Выполненное задание",
      description: "Не должно появиться завтра",
      requiredForCalls: false,
      countsForRating: true
    });
    const started = await store.startWaiterShift(waiter.id, [zone]);
    assert.ok(started);
    const taskIndex = started.shift.checklist.findIndex((item) => item.itemId === `task-${task.id}`);
    assert.ok(taskIndex >= 0);
    const completed = await store.completeShiftChecklistItem(
      started.shift.id,
      waiter.id,
      taskIndex,
      new Date(new Date(started.shift.startedAt).getTime() + CHECKLIST_ITEM_COOLDOWN_MS)
    );
    assert.equal(completed.status, "completed");
    assert.ok(store.findShiftTask(task.id)?.completedAt);

    const carried = await store.rolloverIncompleteShiftTasks(nextDate);
    assert.equal(carried.length, 0);
    assert.equal(store.listShiftTasks().length, 1);
    assert.ok(store.findShiftTask(task.id)?.rolloverProcessedAt);
  });
});

test("a personal dated task can be completed without a shift and is not carried forward", async () => {
  await withStore(async (store) => {
    const waiter = store.snapshot().waiters[0];
    const task = await store.addShiftTask({
      roleId: waiter.roleId,
      waiterId: waiter.id,
      date: "2026-01-10",
      title: "Отметить персональное задание в боте",
      description: "Смена для выполнения не требуется",
      requiredForCalls: false,
      countsForRating: true
    });

    const denied = await store.completeShiftTask(task.id, "another-employee");
    assert.equal(denied.status, "not_found");

    const completed = await store.completeShiftTask(
      task.id,
      waiter.id,
      new Date("2026-01-10T12:00:00+04:00")
    );
    assert.equal(completed.status, "completed");
    assert.ok(completed.task.completedAt);
    assert.equal(store.getShiftTasksForNotification(task.date).length, 0);

    const repeated = await store.completeShiftTask(task.id, waiter.id);
    assert.equal(repeated.status, "already_completed");

    const carried = await store.rolloverIncompleteShiftTasks(
      "2026-01-11",
      new Date("2026-01-11T00:01:00+04:00")
    );
    assert.equal(carried.length, 0);
    assert.ok(store.findShiftTask(task.id)?.rolloverProcessedAt);
  });
});

test("an incomplete role task is carried forward personally for the affected employee", async () => {
  await withStore(async (store) => {
    const waiter = store.snapshot().waiters[0];
    const zone = store.listZones()[0];
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Astrakhan" }).format(new Date());
    const nextDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Astrakhan" }).format(
      new Date(new Date(`${date}T12:00:00+04:00`).getTime() + 24 * 60 * 60 * 1000)
    );
    const task = await store.addShiftTask({
      roleId: waiter.roleId,
      waiterId: null,
      date,
      title: "Общее задание должности",
      description: "Переносится только тому, кто не выполнил",
      requiredForCalls: false,
      countsForRating: true
    });
    const started = await store.startWaiterShift(waiter.id, [zone]);
    assert.ok(started?.shift.checklist.some((item) => item.itemId === `task-${task.id}`));

    const carried = await store.rolloverIncompleteShiftTasks(nextDate);
    assert.equal(carried.length, 1);
    assert.equal(carried[0].waiterId, waiter.id);
    assert.equal(carried[0].date, nextDate);
    assert.equal(carried[0].carriedFromTaskId, task.id);
  });
});

test("a carried task is appended to an already running shift on the target date", async () => {
  await withStore(async (store) => {
    const waiter = store.snapshot().waiters[0];
    const zone = store.listZones()[0];
    const targetDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Astrakhan" }).format(new Date());
    const previousDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Astrakhan" }).format(
      new Date(new Date(`${targetDate}T12:00:00+04:00`).getTime() - 24 * 60 * 60 * 1000)
    );
    await store.addShiftTask({
      roleId: waiter.roleId,
      waiterId: waiter.id,
      date: previousDate,
      title: "Просроченное обязательное задание",
      description: "Должно появиться в уже открытой смене",
      requiredForCalls: true,
      countsForRating: true
    });
    const started = await store.startWaiterShift(waiter.id, [zone]);
    assert.ok(started);
    await completeChecklistItems(store, started.shift, waiter.id);
    assert.equal(store.currentShiftForWaiter(waiter.id)?.status, "active");

    const carried = await store.rolloverIncompleteShiftTasks(targetDate);
    assert.equal(carried.length, 1);
    const updated = store.currentShiftForWaiter(waiter.id);
    assert.ok(updated?.checklist.some((item) => item.itemId === `task-${carried[0].id}`));
    assert.equal(updated?.status, "checklist");
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
    const reviewed = await store.reviewShiftChecklist(
      firstEnded.id,
      [{
        itemId: firstEnded.checklist[0].itemId,
        score: 2,
        comment: "Низкое качество",
        photoUrl: "/api/admin/review-media/review-1-00000000-0000-0000-0000-000000000001.jpg"
      }],
      "admin",
      "shift-manager"
    );
    assert.equal(reviewed?.checklist[0].adminPhotoUrl, "/api/admin/review-media/review-1-00000000-0000-0000-0000-000000000001.jpg");
    assert.equal(reviewed?.checklist[0].reviewedByRole, "admin");
    assert.equal(reviewed?.checklist[0].reviewedByUsername, "shift-manager");
    assert.ok(reviewed?.checklist[0].reviewedAt);

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
    const employeeOnly = store.performanceAnalytics([waiter.roleId], [waiter.id]);
    assert.equal(employeeOnly.analyzedShiftCount, 2);
    assert.equal(employeeOnly.roleSummaries[0].employeeCount, 1);
  });
});

test("an unfinished required checklist becomes overdue only once", async () => {
  await withStore(async (store) => {
    const waiter = store.snapshot().waiters[0];
    const started = await store.startWaiterShift(waiter.id, [store.listZones()[0]]);
    assert.ok(started);
    assert.equal(started.shift.status, "checklist");
    const startedAt = new Date(started.shift.startedAt).getTime();

    assert.equal(store.shiftsDueForChecklistAlert(startedAt + 999, 1_000).length, 0);
    const due = store.shiftsDueForChecklistAlert(startedAt + 1_000, 1_000);
    assert.equal(due.length, 1);
    assert.equal(due[0].id, started.shift.id);

    const marked = await store.markChecklistOverdueNotified(started.shift.id, new Date(startedAt + 1_000));
    assert.ok(marked?.checklistOverdueNotifiedAt);
    assert.equal(store.shiftsDueForChecklistAlert(startedAt + 2_000, 1_000).length, 0);
  });
});
