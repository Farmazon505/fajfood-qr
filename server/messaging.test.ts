import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MessagingService } from "./messaging";
import type { MaxService } from "./max";
import {
  ADMIN_ACK_TIMEOUT_MS,
  CHECKLIST_OVERDUE_TIMEOUT_MS,
  Store,
  WAITER_ACCEPT_TIMEOUT_MS,
  WAITER_COMPLETE_TIMEOUT_MS
} from "./store";
import type { TelegramService } from "./telegram";
import type { ServiceCall, WaiterShift } from "./types";
import type { OwnerWebPushService } from "./web-push";

class FakeTransport {
  notifications: ServiceCall[] = [];
  ownerAlerts: string[] = [];
  closingAlerts: WaiterShift[] = [];
  adminSummaries: WaiterShift[] = [];

  enabled() {
    return true;
  }

  setCallCoordinator() {}

  startPolling() {}

  async start() {}

  async notifyCall({ call }: { call: ServiceCall }) {
    this.notifications.push(structuredClone(call));
    return call.routingStage === "owner" ? [] : [{}];
  }

  async closeCallMessages() {}

  async notifyShiftTask() {
    return false;
  }

  async notifyOwnerAlert(text: string) {
    this.ownerAlerts.push(text);
    return 1;
  }

  async notifyClosingChecklistIncomplete(shift: WaiterShift) {
    this.closingAlerts.push(structuredClone(shift));
    return 1;
  }

  async notifyAdminShiftSummary(shift: WaiterShift) {
    this.adminSummaries.push(structuredClone(shift));
    return 1;
  }
}

class FakeWebPush {
  notifications: Array<{ title: string; body: string; tag?: string }> = [];

  enabled() {
    return true;
  }

  async notify(payload: { title: string; body: string; tag?: string }) {
    this.notifications.push(payload);
    return { sent: 1, failed: 0, removed: 0 };
  }
}

test("messaging routes timed-out calls through online admin and persists owner CRM escalation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrnastol-messaging-"));
  try {
    const store = new Store(directory);
    await store.init();
    const waiter = { ...store.snapshot().waiters[0], telegramChatId: "10001" };
    const admin = {
      id: "admin-1",
      name: "Администратор",
      roleId: "admin",
      telegramChatId: "20001",
      maxUserId: "",
      tipUrl: "",
      active: true
    };
    await store.replaceWaiters([waiter, admin]);
    const zone = store.listZones()[0];
    const adminShift = await store.startWaiterShift(admin.id, [zone]);
    assert.equal(adminShift?.shift.status, "active");

    const telegram = new FakeTransport();
    const max = new FakeTransport();
    const messaging = new MessagingService(
      store,
      telegram as unknown as TelegramService,
      max as unknown as MaxService
    );
    const action = store.snapshot().actions[0];
    const [unansweredTable, slowTable, offlineTable] = store.snapshot().tables.filter((table) => table.zone === zone);

    const unanswered = await store.upsertCall({
      table: unansweredTable,
      action,
      comment: "",
      guestName: "",
      assignedWaiterId: waiter.id,
      routingStage: "waiter",
      routingReason: ""
    });
    await messaging.processEscalations(
      new Date(unanswered.lastRequestedAt).getTime() + WAITER_ACCEPT_TIMEOUT_MS
    );
    const adminCall = store.findCallById(unanswered.id);
    assert.equal(adminCall?.routingStage, "admin");
    assert.match(adminCall?.routingReason || "", /не принял вызов в течение 1 минуты/);
    assert.deepEqual(adminCall?.missedByStaff.map((event) => [event.staffId, event.role]), [[waiter.id, "waiter"]]);

    await store.acknowledgeEscalation(unanswered.id, "admin");
    await messaging.processEscalations(
      new Date(adminCall?.adminEscalationStartedAt || "").getTime() + ADMIN_ACK_TIMEOUT_MS
    );
    assert.equal(store.findCallById(unanswered.id)?.routingStage, "admin");

    const slow = await store.upsertCall({
      table: slowTable,
      action,
      comment: "",
      guestName: "",
      assignedWaiterId: waiter.id,
      routingStage: "waiter",
      routingReason: ""
    });
    const accepted = await store.updateCallStatus(slow.id, "accepted");
    await messaging.processEscalations(
      new Date(accepted?.acceptedAt || "").getTime() + WAITER_COMPLETE_TIMEOUT_MS
    );
    const slowAdminCall = store.findCallById(slow.id);
    assert.equal(slowAdminCall?.routingStage, "admin");
    assert.match(slowAdminCall?.routingReason || "", /не завершил его в течение 2 минут/);

    await messaging.processEscalations(
      new Date(slowAdminCall?.adminEscalationStartedAt || "").getTime() + ADMIN_ACK_TIMEOUT_MS
    );
    const ownerCall = store.findCallById(slow.id);
    assert.equal(ownerCall?.routingStage, "owner");
    assert.ok(ownerCall?.ownerEscalatedAt);
    assert.match(ownerCall?.routingReason || "", /не подтвердил вызов в течение 1 минуты/);
    assert.deepEqual(ownerCall?.missedByStaff.map((event) => [event.staffId, event.role]), [[admin.id, "admin"]]);
    assert.equal(store.waiterRatings().find((rating) => rating.waiterId === waiter.id)?.missedCallCount, 1);
    assert.equal(store.waiterRatings().find((rating) => rating.waiterId === admin.id)?.missedCallCount, 1);

    await store.endWaiterShift(admin.id);
    const offline = await store.upsertCall({
      table: offlineTable,
      action,
      comment: "",
      guestName: "",
      assignedWaiterId: waiter.id,
      routingStage: "waiter",
      routingReason: ""
    });
    await messaging.processEscalations(
      new Date(offline.lastRequestedAt).getTime() + WAITER_ACCEPT_TIMEOUT_MS
    );
    const immediateOwnerCall = store.findCallById(offline.id);
    assert.equal(immediateOwnerCall?.routingStage, "owner");
    assert.match(immediateOwnerCall?.routingReason || "", /Администратор не в сети/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("messaging alerts the owner once when a required checklist is overdue", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrnastol-checklist-alert-"));
  try {
    const store = new Store(directory);
    await store.init();
    const waiter = store.snapshot().waiters[0];
    const started = await store.startWaiterShift(waiter.id, [store.listZones()[0]]);
    assert.ok(started);

    const telegram = new FakeTransport();
    const max = new FakeTransport();
    const webPush = new FakeWebPush();
    const messaging = new MessagingService(
      store,
      telegram as unknown as TelegramService,
      max as unknown as MaxService,
      webPush as unknown as OwnerWebPushService
    );
    const overdueAt = new Date(started.shift.startedAt).getTime() + CHECKLIST_OVERDUE_TIMEOUT_MS;
    await messaging.processEscalations(overdueAt);

    assert.equal(telegram.ownerAlerts.length, 1);
    assert.match(telegram.ownerAlerts[0], /Чек-лист не завершён/);
    assert.equal(webPush.notifications.length, 1);
    assert.match(webPush.notifications[0].title, /Чек-лист не завершён/);
    assert.ok(store.currentShiftForWaiter(waiter.id)?.checklistOverdueNotifiedAt);

    await messaging.processEscalations(overdueAt + 60_000);
    assert.equal(telegram.ownerAlerts.length, 1);
    assert.equal(webPush.notifications.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("messaging daily maintenance closes a shift from the previous venue date", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrnastol-midnight-shift-"));
  try {
    const store = new Store(directory);
    await store.init();
    const waiter = store.snapshot().waiters[0];
    const started = await store.startWaiterShift(waiter.id, [store.listZones()[0]]);
    assert.ok(started);

    const telegram = new FakeTransport();
    const max = new FakeTransport();
    const webPush = new FakeWebPush();
    const messaging = new MessagingService(
      store,
      telegram as unknown as TelegramService,
      max as unknown as MaxService,
      webPush as unknown as OwnerWebPushService
    );
    const nextVenueDay = new Date(started.shift.startedAt).getTime() + 36 * 60 * 60 * 1000;
    await messaging.processEscalations(nextVenueDay);

    const closed = store.snapshot().shifts.find((shift) => shift.id === started.shift.id);
    assert.equal(closed?.status, "ended");
    assert.equal(closed?.endedAt, new Date(nextVenueDay).toISOString());
    assert.equal(store.currentShiftForWaiter(waiter.id), null);
    assert.ok(store.snapshot().tables.every((table) => !table.waiterIds.includes(waiter.id)));
    assert.equal(telegram.ownerAlerts.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("messaging keeps shifts open until 02:00 and then alerts admin about incomplete closing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrnastol-two-am-shift-"));
  try {
    const store = new Store(directory);
    await store.init();
    const waiter = { ...store.snapshot().waiters[0], telegramChatId: "10001" };
    const admin = {
      id: "admin-two-am",
      name: "Администратор 02:00",
      roleId: "admin",
      telegramChatId: "20001",
      maxUserId: "",
      tipUrl: "",
      active: true
    };
    await store.replaceWaiters([waiter, admin]);
    await store.replaceChecklistItems([{
      id: "closing-two-am",
      roleId: "waiter",
      phase: "closing",
      title: "Закрыть зал",
      description: "",
      requiredForCalls: false,
      countsForRating: true,
      active: true,
      sort: 10
    }]);
    const zone = store.listZones()[0];
    const waiterShift = await store.startWaiterShift(waiter.id, [zone]);
    const adminShift = await store.startWaiterShift(admin.id, [zone]);
    assert.ok(waiterShift);
    assert.ok(adminShift);

    const telegram = new FakeTransport();
    const max = new FakeTransport();
    const messaging = new MessagingService(
      store,
      telegram as unknown as TelegramService,
      max as unknown as MaxService
    );
    const [year, month, day] = waiterShift.shift.morningGreetingDate.split("-").map(Number);
    const nextDate = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
    const beforeClose = new Date(`${nextDate}T01:59:59+04:00`).getTime();
    const atClose = new Date(`${nextDate}T02:00:00+04:00`).getTime();

    await messaging.processEscalations(beforeClose);
    assert.ok(store.currentShiftForWaiter(waiter.id));
    assert.ok(store.currentShiftForWaiter(admin.id));
    assert.equal(telegram.closingAlerts.length, 0);

    await messaging.processEscalations(atClose);
    assert.equal(store.currentShiftForWaiter(waiter.id), null);
    assert.equal(store.currentShiftForWaiter(admin.id), null);
    assert.equal(telegram.closingAlerts.length, 1);
    assert.equal(max.closingAlerts.length, 1);
    assert.equal(telegram.adminSummaries.length, 1);
    assert.equal(telegram.adminSummaries[0].adminPenaltyAmount, 20);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
