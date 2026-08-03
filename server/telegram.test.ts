import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CHECKLIST_ITEM_COOLDOWN_MS, Store } from "./store";
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
    const admin = { id: "admin-1", name: "Администратор", roleId: "admin", telegramChatId: "20001", maxUserId: "", tipUrl: "", active: true };
    const owner = { id: "owner-1", name: "Владелец", roleId: "owner", telegramChatId: "30001", maxUserId: "", tipUrl: "", active: true };
    await store.replaceWaiters([{ ...waiter, telegramChatId: "10001" }, admin, owner]);
    const fullChecklistTitle = "Проверить все столы, стулья, диваны и сервировку во всех зонах перед открытием смены";
    const fullChecklistDescription = "Осмотреть каждый стол без исключения, убрать загрязнения, выровнять стулья и проверить комплектность сервировки.";
    const checklistItems = store.snapshot().checklistItems;
    await store.replaceChecklistItems(checklistItems.map((item, index) => index === 0
      ? { ...item, title: fullChecklistTitle, description: fullChecklistDescription }
      : item));
    const telegram = new TelegramService(store, "test-token", 10);

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
    const taskNotification = requests.find(
      (request) => request.method === "sendMessage" && String(request.payload.text).includes("Персональное задание")
    );
    assert.ok(taskNotification);
    assert.match(JSON.stringify(taskNotification.payload.reply_markup), new RegExp(`task:complete:${personalTask.id}`));

    await telegram.handleUpdate({
      update_id: 0,
      callback_query: {
        id: "complete-personal-task",
        data: `task:complete:${personalTask.id}`,
        message: { message_id: 701, chat: { id: "10001" } }
      }
    });
    assert.ok(store.findShiftTask(personalTask.id)?.completedAt);
    const completedTaskMessage = requests.filter((request) => request.method === "editMessageText").at(-1);
    assert.match(String(completedTaskMessage?.payload.text), /Задание выполнено/);
    assert.deepEqual(completedTaskMessage?.payload.reply_markup, { inline_keyboard: [] });

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
    assert.ok(startedShift.checklist.length >= 2);
    const checklistMessage = requests
      .filter((request) => request.method === "sendMessage" && String(request.payload.text).includes("Чек-лист:"))
      .at(-1);
    assert.ok(checklistMessage);
    assert.match(String(checklistMessage.payload.text), new RegExp(fullChecklistTitle));
    assert.match(String(checklistMessage.payload.text), new RegExp(fullChecklistDescription));
    assert.ok(startedShift.checklist.every((item) => String(checklistMessage.payload.text).includes(item.title)));
    assert.ok(startedShift.checklist.every((item) => !item.description || String(checklistMessage.payload.text).includes(item.description)));
    await telegram.handleUpdate({
      update_id: 10,
      callback_query: {
        id: "check-0",
        data: `check:${startedShift.id}:0`,
        message: { message_id: 4, chat: { id: "10001" } }
      }
    });
    await telegram.handleUpdate({
      update_id: 11,
      callback_query: {
        id: "check-1-too-soon",
        data: `check:${startedShift.id}:1`,
        message: { message_id: 4, chat: { id: "10001" } }
      }
    });
    const cooldownAnswer = requests.filter((request) => request.method === "answerCallbackQuery").at(-1);
    assert.match(String(cooldownAnswer?.payload.text), /Следующий пункт можно отметить через \d+ сек\./);
    assert.equal(cooldownAnswer?.payload.show_alert, true);
    assert.equal(store.currentShiftForWaiter(waiter.id)?.checklist[1].completedAt, null);

    let completionTimestamp = new Date(
      store.currentShiftForWaiter(waiter.id)?.checklist[0].completedAt || ""
    ).getTime();
    for (let index = 1; index < startedShift.checklist.length; index += 1) {
      completionTimestamp += CHECKLIST_ITEM_COOLDOWN_MS;
      const result = await store.completeShiftChecklistItem(
        startedShift.id,
        waiter.id,
        index,
        new Date(completionTimestamp)
      );
      assert.equal(result.status, "completed");
    }
    assert.equal(store.currentShiftForWaiter(waiter.id)?.status, "active");

    const table = store.snapshot().tables.find((item) => item.zone === startedShift.zones[0]);
    const action = store.snapshot().actions[0];
    const cardAction = store.snapshot().actions.find((item) => item.label === "Счет картой");
    assert.ok(table);
    assert.ok(cardAction);
    const sendsBeforeCalls = requests.filter((request) => request.method === "sendMessage").length;

    const first = await store.upsertCall({ table, action, comment: "", guestName: "", assignedWaiterId: waiter.id, routingStage: "waiter", routingReason: "" });
    await telegram.notifyCall({ call: first, table, waiters: [waiter], settings: store.snapshot().settings });
    const second = await store.upsertCall({ table, action: cardAction, comment: "", guestName: "", assignedWaiterId: waiter.id, routingStage: "waiter", routingReason: "" });
    await telegram.notifyCall({ call: second, table, waiters: [waiter], settings: store.snapshot().settings });

    const callSends = requests.filter((request) => request.method === "sendMessage").slice(sendsBeforeCalls);
    assert.equal(callSends.length, 2);
    assert.equal(callSends[0]?.payload.disable_notification, false);
    assert.match(String(callSends[1]?.payload.text), /ПОВТОРНЫЙ ВЫЗОВ/);
    assert.match(String(callSends[1]?.payload.text), /💳 СЧЕТ КАРТОЙ/);
    assert.equal(callSends[1]?.payload.disable_notification, false);
    const repeatedEdit = requests.filter((request) => request.method === "editMessageText").at(-1);
    assert.match(String(repeatedEdit?.payload.text), /🟥🟥🟥 НОВЫЙ ВЫЗОВ/);
    assert.match(String(repeatedEdit?.payload.text), /ПОСЛЕДНИЙ ЗАПРОС: 💳 СЧЕТ КАРТОЙ/);
    assert.match(String(repeatedEdit?.payload.text), /➡️ Счет картой — 1/);
    assert.match(String(repeatedEdit?.payload.text), /Количество вызовов: 2/);
    const audibleMessageId = messageId;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(
      requests.some(
        (request) => request.method === "deleteMessage" && request.payload.message_id === audibleMessageId
      )
    );

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
    const acceptedEdit = requests.filter((request) => request.method === "editMessageText").at(-1);
    assert.match(String(acceptedEdit?.payload.text), /✅ ВЫЗОВ ПРИНЯТ/);
    assert.doesNotMatch(String(acceptedEdit?.payload.text), /🟥🟥🟥 НОВЫЙ ВЫЗОВ/);

    const nextCycle = await store.upsertCall({ table, action, comment: "", guestName: "", assignedWaiterId: waiter.id, routingStage: "waiter", routingReason: "" });
    await telegram.notifyCall({ call: nextCycle, table, waiters: [waiter], settings: store.snapshot().settings });
    const resetEdit = requests.filter((request) => request.method === "editMessageText").at(-1);
    assert.match(String(resetEdit?.payload.text), /🟥🟥🟥 НОВЫЙ ВЫЗОВ/);
    assert.match(String(resetEdit?.payload.text), /ПОСЛЕДНИЙ ЗАПРОС: 🙋 ПОЗВАТЬ ОФИЦИАНТА/);
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
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(requests.filter((request) => request.method === "deleteMessage").length, 3);

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
    await telegram.processEscalations(baseTime + 60 * 1000 + 1);
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

test("Telegram sends admin fine summary and stores receipt photo", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrnastol-telegram-penalty-"));
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; payload: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/file/bot")) {
      const jpeg = Buffer.alloc(256, 0x11);
      jpeg[0] = 0xff;
      jpeg[1] = 0xd8;
      jpeg[2] = 0xff;
      return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    requests.push({ url, payload });
    if (url.endsWith("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/receipt.jpg" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: payload.chat_id } } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const store = new Store(directory);
    await store.init();
    const waiter = store.snapshot().waiters[0];
    const admin = {
      id: "admin-telegram-penalty",
      name: "Администратор штрафа",
      roleId: "admin",
      telegramChatId: "22001",
      maxUserId: "",
      tipUrl: "",
      active: true
    };
    await store.replaceWaiters([waiter, admin]);
    await store.updateOwnerNotifications({
      telegramChatId: "",
      maxUserId: "",
      sberCardNumber: "2202 0000 0000 0000",
      telegramEnabled: false,
      maxEnabled: false
    });
    await store.replaceChecklistItems([{
      id: "telegram-penalty-closing",
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
    const waiterStarted = await store.startWaiterShift(waiter.id, [zone]);
    const adminStarted = await store.startWaiterShift(admin.id, [zone]);
    assert.ok(waiterStarted);
    assert.ok(adminStarted);
    const nextDate = new Date(`${waiterStarted.shift.morningGreetingDate}T12:00:00.000Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const ended = await store.endOpenShiftsBeforeDate(nextDate.toISOString().slice(0, 10), nextDate);
    const adminShift = ended.find((shift) => shift.waiterId === admin.id);
    assert.ok(adminShift);
    assert.equal(adminShift.adminPenaltyAmount, 20);

    const telegram = new TelegramService(store, "test-token");
    await telegram.notifyAdminShiftSummary(adminShift);
    const summary = requests.find((request) => String(request.payload.text || "").includes("Итоги смены администратора"));
    assert.match(String(summary?.payload.text), /Штраф: 20 ₽/);
    assert.match(String(summary?.payload.text), /2202 0000 0000 0000/);

    await telegram.handleUpdate({
      update_id: 500,
      message: {
        message_id: 500,
        chat: { id: "22001" },
        photo: [{ file_id: "receipt-file", file_size: 256, width: 100, height: 100 }]
      }
    });
    const saved = store.findShiftById(adminShift.id);
    assert.match(saved?.adminPenaltyReceiptUrl || "", /^\/api\/admin\/review-media\/penalty-/);
    assert.equal(saved?.adminPenaltyReceiptMessenger, "telegram");
    assert.ok(saved?.adminPenaltyReceiptAt);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
