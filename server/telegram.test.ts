import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "./store";
import { TelegramService } from "./telegram";

test("Telegram manages a shift and keeps one live message per table", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrnastol-telegram-"));
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; payload: Record<string, unknown> }> = [];
  let messageId = 700;

  globalThis.fetch = (async (input, init) => {
    const method = String(input).split("/").pop() || "";
    const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    requests.push({ method, payload });
    let result: unknown = true;
    if (method === "sendMessage") {
      messageId += 1;
      result = { message_id: messageId, chat: { id: payload.chat_id } };
    } else if (method === "editMessageText") {
      result = { message_id: payload.message_id, chat: { id: payload.chat_id } };
    }
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const store = new Store(directory);
    await store.init();
    const waiter = store.snapshot().waiters[0];
    const admin = { id: "admin-1", name: "Администратор", roleId: "admin", telegramChatId: "20001", tipUrl: "", active: true };
    const owner = { id: "owner-1", name: "Владелец", roleId: "owner", telegramChatId: "30001", tipUrl: "", active: true };
    await store.replaceWaiters([{ ...waiter, telegramChatId: "10001" }, admin, owner]);
    const telegram = new TelegramService(store, "test-token");

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Astrakhan" }).format(new Date());
    const personalTask = await store.addShiftTask({
      roleId: waiter.roleId,
      waiterId: waiter.id,
      date: today,
      title: "Персональное задание",
      description: "Напоминание должно прийти без открытой смены",
      requiredForCalls: false,
      countsForRating: true
    });
    await telegram.processEscalations();
    assert.equal(store.findShiftTask(personalTask.id)?.notified, true);
    assert.ok(requests.some((request) => request.method === "sendMessage" && String(request.payload.text).includes("Персональное задание")));

    await telegram.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: "10001" }, text: "/start" }
    });
    await telegram.handleUpdate({
      update_id: 2,
      message: { message_id: 2, chat: { id: "10001" }, text: "Начать смену" }
    });
    await telegram.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "zone-1",
        data: "shift:zone:0",
        message: { message_id: 3, chat: { id: "10001" } }
      }
    });

    const startedShift = store.currentShiftForWaiter(waiter.id);
    assert.ok(startedShift);
    assert.equal(startedShift.status, "checklist");
    for (let index = 0; index < startedShift.checklist.length; index += 1) {
      await telegram.handleUpdate({
        update_id: 10 + index,
        callback_query: {
          id: `check-${index}`,
          data: `check:${startedShift.id}:${index}`,
          message: { message_id: 4, chat: { id: "10001" } }
        }
      });
    }
    assert.equal(store.currentShiftForWaiter(waiter.id)?.status, "active");

    const table = store.snapshot().tables.find((item) => item.zone === startedShift.zones[0]);
    const action = store.snapshot().actions[0];
    assert.ok(table);
    const sendsBeforeCalls = requests.filter((request) => request.method === "sendMessage").length;

    const first = await store.upsertCall({ table, action, comment: "", guestName: "", assignedWaiterId: waiter.id, routingStage: "waiter", routingReason: "" });
    await telegram.notifyCall({ call: first, table, waiters: [waiter], settings: store.snapshot().settings });
    const second = await store.upsertCall({ table, action, comment: "", guestName: "", assignedWaiterId: waiter.id, routingStage: "waiter", routingReason: "" });
    await telegram.notifyCall({ call: second, table, waiters: [waiter], settings: store.snapshot().settings });

    assert.equal(requests.filter((request) => request.method === "sendMessage").length, sendsBeforeCalls + 1);
    const repeatedEdit = requests.filter((request) => request.method === "editMessageText").at(-1);
    assert.match(String(repeatedEdit?.payload.text), /Количество вызовов: 2/);

    const ref = store.findCallById(first.id)?.telegramMessages[0];
    assert.ok(ref);
    await telegram.handleUpdate({
      update_id: 20,
      callback_query: {
        id: "accept-1",
        data: `call:accepted:${first.id}`,
        message: { message_id: ref.messageId, chat: { id: ref.chatId } }
      }
    });
    assert.equal(store.findCallById(first.id)?.status, "accepted");

    const nextCycle = await store.upsertCall({ table, action, comment: "", guestName: "", assignedWaiterId: waiter.id, routingStage: "waiter", routingReason: "" });
    await telegram.notifyCall({ call: nextCycle, table, waiters: [waiter], settings: store.snapshot().settings });
    const resetEdit = requests.filter((request) => request.method === "editMessageText").at(-1);
    assert.match(String(resetEdit?.payload.text), /Количество вызовов: 1/);

    await telegram.handleUpdate({
      update_id: 21,
      callback_query: {
        id: "accept-2",
        data: `call:accepted:${first.id}`,
        message: { message_id: ref.messageId, chat: { id: ref.chatId } }
      }
    });
    await telegram.handleUpdate({
      update_id: 22,
      callback_query: {
        id: "done-1",
        data: `call:done:${first.id}`,
        message: { message_id: ref.messageId, chat: { id: ref.chatId } }
      }
    });

    assert.equal(store.findCallById(first.id)?.status, "done");
    assert.deepEqual(store.findCallById(first.id)?.telegramMessages, []);
    assert.equal(requests.filter((request) => request.method === "deleteMessage").length, 1);

    await telegram.handleUpdate({
      update_id: 23,
      message: { message_id: 5, chat: { id: "10001" }, text: "Закончить смену" }
    });
    assert.equal(store.currentShiftForWaiter(waiter.id), null);
    assert.equal(store.findTableById(table.id)?.waiterIds.includes(waiter.id), false);

    await telegram.handleUpdate({
      update_id: 24,
      message: { message_id: 6, chat: { id: "10001" }, text: "Начать смену" }
    });
    await telegram.handleUpdate({
      update_id: 25,
      callback_query: {
        id: "waiter-zone-again",
        data: "shift:zone:0",
        message: { message_id: 7, chat: { id: "10001" } }
      }
    });
    assert.equal(store.currentShiftForWaiter(waiter.id)?.status, "checklist");

    await telegram.handleUpdate({
      update_id: 26,
      message: { message_id: 8, chat: { id: "20001" }, text: "Начать смену" }
    });
    await telegram.handleUpdate({
      update_id: 27,
      callback_query: {
        id: "admin-zone",
        data: "shift:zone:0",
        message: { message_id: 9, chat: { id: "20001" } }
      }
    });
    assert.ok(store.currentShiftForWaiter(admin.id));

    const fallbackTable = store.snapshot().tables.find((item) => item.zone === store.listZones()[0]);
    assert.ok(fallbackTable);
    const fallbackReason = store.callFallbackReason(fallbackTable);
    assert.match(fallbackReason, /чек-лист не завершен/);
    const fallbackCall = await store.upsertCall({
      table: fallbackTable,
      action,
      comment: "",
      guestName: "",
      assignedWaiterId: null,
      routingStage: "admin",
      routingReason: fallbackReason
    });
    await telegram.notifyCall({ call: fallbackCall, table: fallbackTable, waiters: [], settings: store.snapshot().settings });
    assert.ok(store.findCallById(fallbackCall.id)?.telegramMessages.some((message) => message.recipientRole === "admin"));

    const baseTime = new Date(fallbackCall.adminEscalationStartedAt || fallbackCall.createdAt).getTime();
    await telegram.processEscalations(baseTime + 4 * 60 * 1000 + 1);
    assert.ok(store.findCallById(fallbackCall.id)?.adminWarningSentAt);
    assert.ok(store.findCallById(fallbackCall.id)?.telegramMessages.some((message) => message.kind === "warning"));

    await telegram.processEscalations(baseTime + 5 * 60 * 1000 + 1);
    const escalated = store.findCallById(fallbackCall.id);
    assert.equal(escalated?.routingStage, "owner");
    const ownerRef = escalated?.telegramMessages.find((message) => message.recipientRole === "owner" && message.kind === "call");
    assert.ok(ownerRef);

    await telegram.handleUpdate({
      update_id: 28,
      callback_query: {
        id: "owner-accept",
        data: `call:accepted:${fallbackCall.id}`,
        message: { message_id: ownerRef.messageId, chat: { id: ownerRef.chatId } }
      }
    });
    assert.equal(store.findCallById(fallbackCall.id)?.lastAcceptedByStaffId, owner.id);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
