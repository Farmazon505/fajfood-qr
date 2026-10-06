import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MaxService } from "./max";
import { TelegramService } from "./telegram";
import { MessagingService } from "./messaging";
import { ADMIN_ACK_TIMEOUT_MS, Store } from "./store";

test("partial delivery retries the missing recipient and retains both admin cards at owner escalation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-04T08:00:00Z") });
  const directory = await mkdtemp(path.join(os.tmpdir(), "qr-call-delivery-"));
  try {
    const store = new Store(directory);
    await store.init();
    const table = store.snapshot().tables[0];
    const staff = [
      { id: "admin-1", name: "Первый администратор", roleId: "admin", telegramChatId: "101", maxUserId: "201", tipUrl: "", active: true },
      { id: "admin-2", name: "Второй администратор", roleId: "admin", telegramChatId: "102", maxUserId: "202", tipUrl: "", active: true },
      { id: "owner", name: "Владелец", roleId: "owner", telegramChatId: "103", maxUserId: "203", tipUrl: "", active: true },
    ];
    await store.replaceWaiters(staff);
    for (const admin of staff.slice(0, 2)) await store.startWaiterShift(admin.id, [table.zone]);
    const call = await store.upsertCall({ table, action: store.snapshot().actions[0], comment: "", guestName: "",
      assignedWaiterId: null, routingStage: "admin", routingReason: "Официант не принял вызов",
      adminRecipientIds: ["admin-1", "admin-2"] });
    const max = new MaxService(store, "test-token");
    const telegram = new TelegramService(store, "test-token");
    const operations: Array<{ channel: string; method: string; recipient?: string }> = [];
    let failSecondMax = true;
    let id = 0;
    (max as unknown as { request: (...args: any[]) => Promise<unknown> }).request = async (method, endpoint, options = {}) => {
      operations.push({ channel: "max", method, recipient: options.query?.user_id });
      if (method === "POST" && endpoint === "messages") {
        if (options.query?.user_id === "202" && failSecondMax) return null;
        return { message: { body: { mid: `max-${++id}` } } };
      }
      return { success: true };
    };
    (telegram as unknown as { request: (...args: any[]) => Promise<unknown> }).request = async (method, payload) => {
      operations.push({ channel: "telegram", method, recipient: String(payload.chat_id) });
      if (method === "sendMessage" || method === "editMessageText") {
        return { message_id: payload.message_id || ++id, chat: { id: payload.chat_id } };
      }
      return true;
    };
    const messaging = new MessagingService(store, telegram, max);
    await messaging.notifyCall({ call, table, waiters: [], settings: store.snapshot().settings });
    assert.equal(store.findCallById(call.id)?.telegramMessages.length, 2);
    assert.equal(store.findCallById(call.id)?.maxMessages.length, 1);
    assert.equal(store.callsNeedingNotificationRetry(Date.now() + 14_999).length, 0);
    assert.equal(store.callsNeedingNotificationRetry(Date.now() + 15_000).length, 1);
    failSecondMax = false;
    const retryStart = operations.length;
    await messaging.syncCall(store.findCallById(call.id)!, true);
    assert.deepEqual(operations.slice(retryStart), [{ channel: "max", method: "POST", recipient: "202" }]);
    assert.equal(store.callsNeedingNotificationRetry(Date.now() + 15_000).length, 0);

    // A repeated press must not erase who received the administrator escalation.
    await store.upsertCall({ table, action: store.snapshot().actions[0], comment: "", guestName: "",
      assignedWaiterId: null, routingStage: "waiter", routingReason: "" });
    assert.deepEqual(store.findCallById(call.id)?.adminRecipientIds, ["admin-1", "admin-2"]);
    const ownerCall = await store.markOwnerEscalated(call.id);
    assert.ok(ownerCall);
    const escalationStart = operations.length;
    await messaging.notifyOwnerEscalation(ownerCall);
    assert.equal(operations.slice(escalationStart).some((operation) => operation.method === "DELETE" || operation.method === "deleteMessage"), false);
    const updated = store.findCallById(call.id)!;
    assert.deepEqual(updated.telegramMessages.map((ref) => ref.recipientRole), ["admin", "admin", "owner"]);
    assert.deepEqual(updated.maxMessages.map((ref) => ref.recipientRole), ["admin", "admin", "owner"]);
    await store.completeCall(call.id);
    await messaging.closeCallMessages(store.findCallById(call.id)!);
    assert.equal(store.findCallById(call.id)?.telegramMessages.length, 0);
    assert.equal(store.findCallById(call.id)?.maxMessages.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("administrator receives the full minute after confirmed delivery, excluding failed sends and edits", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qr-admin-delivery-time-"));
  try {
    const store = new Store(directory);
    await store.init();
    const startedAt = new Date();
    const call = await store.upsertCall({ table: store.snapshot().tables[0], action: store.snapshot().actions[0],
      comment: "", guestName: "", assignedWaiterId: null, routingStage: "waiter", routingReason: "" });
    await store.startAdminEscalation(call.id, "Не принят", ["admin"], startedAt);
    const delivery = { callId: call.id, channel: "max" as const, recipientId: "201", recipientRole: "admin" as const, operation: "send" as const,
      status: "failed" as const, externalMessageId: "" };
    await store.recordNotificationDelivery(delivery, startedAt);
    const deliveredAt = startedAt.getTime() + 20_000;
    await store.recordNotificationDelivery({ ...delivery, status: "delivered", externalMessageId: "real-message-id" }, new Date(deliveredAt));
    await store.recordNotificationDelivery({ ...delivery, operation: "edit", status: "delivered", externalMessageId: "real-message-id" }, new Date(deliveredAt + 10_000));
    assert.equal(store.callsDueForOwnerEscalation(startedAt.getTime() + ADMIN_ACK_TIMEOUT_MS).length, 0);
    assert.equal(store.callsDueForOwnerEscalation(deliveredAt + ADMIN_ACK_TIMEOUT_MS - 1).length, 0);
    assert.equal(store.callsDueForOwnerEscalation(deliveredAt + ADMIN_ACK_TIMEOUT_MS).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
