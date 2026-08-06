import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { MaxService } from "./max";
import { CHECKLIST_ITEM_COOLDOWN_MS, Store } from "./store";

const allowChecklistAllDay = (store: Store) => store.replaceChecklistConfiguration(
  store.snapshot().checklistItems,
  {
    opening: { start: "00:00", end: "23:59" },
    evening: { start: "18:00", end: "19:00" },
    closing: { start: "00:00", end: "23:59" }
  }
);

test("MAX retries a transient API failure before reporting delivery failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrnastol-max-retry-"));
  let attempts = 0;
  const api = createServer((_request, response) => {
    attempts += 1;
    response.setHeader("content-type", "application/json");
    if (attempts === 1) {
      response.statusCode = 502;
      response.end(JSON.stringify({ message: "Bad Gateway" }));
      return;
    }
    response.statusCode = 200;
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));

  try {
    const address = api.address();
    assert.ok(address && typeof address !== "string");
    const store = new Store(directory);
    await store.init();
    const max = new MaxService(store, "test-token", `http://127.0.0.1:${address.port}/`);
    (max as unknown as { httpsAgent?: undefined }).httpsAgent = undefined;
    const result = await (max as unknown as {
      request<T>(method: string, endpoint: string): Promise<T | null>;
    }).request<{ ok: boolean }>("GET", "me");
    assert.equal(result?.ok, true);
    assert.equal(attempts, 2);
  } finally {
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("MAX lets an admin end immediately and manage an unclosed employee shift", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrnastol-max-admin-end-"));
  try {
    const store = new Store(directory);
    await store.init();
    const waiter = { ...store.snapshot().waiters[0], telegramChatId: "", maxUserId: "51001" };
    const admin = {
      id: "max-admin-end",
      name: "Администратор",
      roleId: "admin",
      telegramChatId: "",
      maxUserId: "52002",
      tipUrl: "",
      active: true
    };
    await store.replaceWaiters([waiter, admin]);
    const zone = store.listZones()[0];
    const waiterShift = await store.startWaiterShift(waiter.id, [zone]);
    const adminShift = await store.startWaiterShift(admin.id, [zone]);
    assert.ok(waiterShift);
    assert.ok(adminShift);

    const requests: Array<{ method: string; endpoint: string; options: Record<string, any> }> = [];
    const max = new MaxService(store, "test-token");
    let messageCounter = 0;
    (max as unknown as { request: (method: string, endpoint: string, options: Record<string, any>) => Promise<any> }).request =
      async (method, endpoint, options = {}) => {
        requests.push({ method, endpoint, options });
        if (method === "POST" && endpoint === "messages") {
          messageCounter += 1;
          return {
            message: {
              recipient: { chat_id: null, chat_type: "dialog" },
              body: { mid: `admin-shift-message-${messageCounter}`, text: "" }
            }
          };
        }
        return { success: true };
      };

    await max.handleUpdate({
      update_type: "message_callback",
      timestamp: Date.now(),
      callback: {
        callback_id: "max-admin-end",
        payload: "shift:end",
        user: { user_id: Number(admin.maxUserId) }
      }
    });
    assert.equal(store.currentShiftForWaiter(admin.id), null);
    assert.ok(store.currentShiftForWaiter(waiter.id));
    const warning = requests.find((request) =>
      request.endpoint === "messages"
      && request.options.query?.user_id === admin.maxUserId
      && String(request.options.body?.text).includes("Сотрудник не закрыл смену")
    );
    assert.ok(warning);
    const warningBody = JSON.stringify(warning.options.body);
    assert.match(warningBody, new RegExp(`shift:admin-close:${waiterShift.shift.id}`));
    assert.match(warningBody, new RegExp(`shift:admin-remind:${waiterShift.shift.id}`));

    await max.handleUpdate({
      update_type: "message_callback",
      timestamp: Date.now(),
      callback: {
        callback_id: "max-admin-remind",
        payload: `shift:admin-remind:${waiterShift.shift.id}`,
        user: { user_id: Number(admin.maxUserId) }
      }
    });
    assert.ok(requests.some((request) =>
      request.endpoint === "messages"
      && request.options.query?.user_id === waiter.maxUserId
      && String(request.options.body?.text).includes("Напоминание о завершении смены")
    ));

    await max.handleUpdate({
      update_type: "message_callback",
      timestamp: Date.now(),
      callback: {
        callback_id: "max-admin-close",
        payload: `shift:admin-close:${waiterShift.shift.id}`,
        user: { user_id: Number(admin.maxUserId) }
      }
    });
    assert.equal(store.currentShiftForWaiter(waiter.id), null);
    assert.ok(requests.some((request) =>
      request.endpoint === "answers"
      && String(request.options.body?.message?.text).includes("закрыта администратором")
    ));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MAX delivers a call and handles accept and done callbacks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrnastol-max-"));
  try {
    const store = new Store(directory);
    await store.init();
    await allowChecklistAllDay(store);
    const waiter = store.snapshot().waiters[0];
    await store.replaceWaiters([{
      ...waiter,
      telegramChatId: "",
      maxUserId: "10001"
    }]);
    const table = store.snapshot().tables[0];
    await store.replaceTables([{
      ...table,
      waiterId: waiter.id,
      waiterIds: [waiter.id]
    }]);

    const started = await store.startWaiterShift(waiter.id, [table.zone]);
    assert.ok(started);
    let completionTime = new Date(started.shift.startedAt).getTime();
    for (let index = 0; index < started.shift.checklist.length; index += 1) {
      completionTime += CHECKLIST_ITEM_COOLDOWN_MS;
      const result = await store.completeShiftChecklistItem(
        started.shift.id,
        waiter.id,
        index,
        new Date(completionTime)
      );
      assert.equal(result.status, "completed");
    }

    const call = await store.upsertCall({
      table,
      action: store.snapshot().actions[0],
      comment: "",
      guestName: "",
      assignedWaiterId: waiter.id,
      routingStage: "waiter",
      routingReason: ""
    });
    const requests: Array<{ method: string; endpoint: string; options: Record<string, unknown> }> = [];
    const max = new MaxService(store, "test-token");
    let messageCounter = 0;
    (max as unknown as { request: (method: string, endpoint: string, options: Record<string, unknown>) => Promise<unknown> }).request =
      async (method, endpoint, options = {}) => {
        requests.push({ method, endpoint, options });
        if (method === "POST" && endpoint === "messages") {
          messageCounter += 1;
          return {
            message: {
              recipient: { chat_id: null, chat_type: "dialog" },
              body: { mid: `max-message-${messageCounter}`, text: "" }
            }
          };
        }
        return { success: true };
      };

    const refs = await max.notifyCall({
      call,
      table,
      waiters: store.waitersForTable(table),
      settings: store.snapshot().settings
    });
    assert.equal(refs.length, 1);
    assert.equal(refs[0].userId, "10001");
    assert.equal(store.findCallById(call.id)?.maxMessages[0].messageId, "max-message-1");

    let syncedStatus = "";
    let closed = false;
    max.setCallCoordinator({
      syncCall: async (changedCall) => {
        syncedStatus = changedCall.status;
      },
      closeCall: async () => {
        closed = true;
      }
    });
    await max.handleUpdate({
      update_type: "message_callback",
      timestamp: Date.now(),
      callback: {
        callback_id: "accept-callback",
        payload: `call:accepted:${call.id}`,
        user: { user_id: 10001 }
      }
    });
    assert.equal(syncedStatus, "accepted");
    assert.equal(store.findCallById(call.id)?.status, "accepted");

    await max.handleUpdate({
      update_type: "message_callback",
      timestamp: Date.now(),
      callback: {
        callback_id: "done-callback",
        payload: `call:done:${call.id}`,
        user: { user_id: 10001 }
      }
    });
    assert.equal(store.findCallById(call.id)?.status, "done");
    assert.equal(closed, true);
    assert.ok(requests.some((request) => request.method === "POST" && request.endpoint === "answers"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MAX lets an employee complete a personal dated task from its notification", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrnastol-max-task-"));
  try {
    const store = new Store(directory);
    await store.init();
    const waiter = store.snapshot().waiters[0];
    await store.replaceWaiters([{
      ...waiter,
      telegramChatId: "",
      maxUserId: "30003"
    }]);
    const task = await store.addShiftTask({
      roleId: waiter.roleId,
      waiterId: waiter.id,
      date: "2026-08-02",
      title: "Проверить выполнение задания в MAX",
      description: "Кнопка должна закрыть задание без открытой смены",
      requiredForCalls: false,
      countsForRating: true
    });

    const requests: Array<{ method: string; endpoint: string; options: Record<string, unknown> }> = [];
    const max = new MaxService(store, "test-token");
    (max as unknown as { request: (method: string, endpoint: string, options: Record<string, unknown>) => Promise<unknown> }).request =
      async (method, endpoint, options = {}) => {
        requests.push({ method, endpoint, options });
        if (method === "POST" && endpoint === "messages") {
          return {
            message: {
              recipient: { chat_id: null, chat_type: "dialog" },
              body: { mid: "max-task-message", text: "" }
            }
          };
        }
        return { success: true };
      };

    assert.equal(await max.notifyShiftTask(task), true);
    const notification = requests.find((request) => request.endpoint === "messages");
    assert.match(JSON.stringify(notification?.options.body), new RegExp(`task:complete:${task.id}`));

    await max.handleUpdate({
      update_type: "message_callback",
      timestamp: Date.now(),
      callback: {
        callback_id: "complete-task",
        payload: `task:complete:${task.id}`,
        user: { user_id: 30003 }
      }
    });

    assert.ok(store.findShiftTask(task.id)?.completedAt);
    const completed = requests.filter((request) => request.endpoint === "answers").at(-1);
    const completedBody = JSON.stringify(completed?.options.body);
    assert.match(completedBody, /Задание выполнено/);
    assert.doesNotMatch(completedBody, new RegExp(`task:complete:${task.id}`));

    const overdueTask = await store.addShiftTask({
      roleId: waiter.roleId,
      waiterId: waiter.id,
      date: "2026-08-01",
      title: "Перенос с комментарием в MAX",
      description: "Причина должна сохраниться",
      requiredForCalls: false,
      countsForRating: true
    });
    const [carriedTask] = await store.rolloverIncompleteShiftTasks("2026-08-02");
    assert.equal(carriedTask.carriedFromTaskId, overdueTask.id);
    const rolloverRecord = carriedTask.rolloverHistory?.at(-1);
    assert.ok(rolloverRecord);
    assert.equal(await max.notifyShiftTaskRollover(carriedTask, rolloverRecord), true);
    const rolloverMessage = requests.filter((request) =>
      request.endpoint === "messages" && JSON.stringify(request.options.body).includes("Задача перенесена на следующий день")
    ).at(-1);
    assert.ok(rolloverMessage);
    assert.match(JSON.stringify(rolloverMessage.options.body), new RegExp(`task:reason:${rolloverRecord.id}`));

    await max.handleUpdate({
      update_type: "message_callback",
      timestamp: Date.now(),
      callback: {
        callback_id: "reason-task",
        payload: `task:reason:${rolloverRecord.id}`,
        user: { user_id: 30003 }
      }
    });
    await max.handleUpdate({
      update_type: "message_created",
      timestamp: Date.now(),
      message: {
        sender: { user_id: 30003 },
        recipient: { chat_id: null, chat_type: "dialog" },
        body: { mid: "reason-message", text: "Не привезли расходные материалы" }
      }
    });
    assert.equal(
      store.findShiftTask(carriedTask.id)?.rolloverHistory?.at(-1)?.reason,
      "Не привезли расходные материалы"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MAX manages a shift and shows the full checklist item text", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrnastol-max-shift-"));
  try {
    const store = new Store(directory);
    await store.init();
    await allowChecklistAllDay(store);
    const waiter = store.snapshot().waiters[0];
    await store.replaceWaiters([{
      ...waiter,
      telegramChatId: "",
      maxUserId: "20002"
    }]);
    const fullTitle = "Полностью проверить подготовку гостевого зала перед началом обслуживания каждого стола";
    const fullDescription = "Пройти весь зал, проверить чистоту столов и кресел, наличие салфеток, приборов и актуальных QR-кодов без сокращений.";
    await store.replaceChecklistItems([{
      id: "max-full-checklist-item",
      roleId: waiter.roleId,
      title: fullTitle,
      description: fullDescription,
      requiredForCalls: true,
      countsForRating: true,
      active: true,
      sort: 10
    }]);

    const requests: Array<{ method: string; endpoint: string; options: Record<string, unknown> }> = [];
    const max = new MaxService(store, "test-token");
    let messageCounter = 0;
    (max as unknown as { request: (method: string, endpoint: string, options: Record<string, unknown>) => Promise<unknown> }).request =
      async (method, endpoint, options = {}) => {
        requests.push({ method, endpoint, options });
        if (method === "POST" && endpoint === "messages") {
          messageCounter += 1;
          return {
            message: {
              recipient: { chat_id: null, chat_type: "dialog" },
              body: { mid: `max-shift-message-${messageCounter}`, text: "" }
            }
          };
        }
        return { success: true };
      };

    await max.handleUpdate({
      update_type: "message_created",
      timestamp: Date.now(),
      message: {
        sender: { user_id: 20002 },
        recipient: { chat_id: null, chat_type: "dialog" },
        body: { mid: "incoming-start", text: "/start" }
      }
    });
    const welcome = requests.find((request) => request.endpoint === "messages");
    assert.match(JSON.stringify(welcome?.options.body), /shift:start/);

    await max.handleUpdate({
      update_type: "message_callback",
      timestamp: Date.now(),
      callback: {
        callback_id: "choose-zone",
        payload: "shift:start",
        user: { user_id: 20002 }
      }
    });
    const zonePicker = requests.filter((request) => request.endpoint === "answers").at(-1);
    assert.match(JSON.stringify(zonePicker?.options.body), /На каком этаже/);
    assert.match(JSON.stringify(zonePicker?.options.body), /shift:zone:0/);

    await max.handleUpdate({
      update_type: "message_callback",
      timestamp: Date.now(),
      callback: {
        callback_id: "start-shift",
        payload: "shift:zone:0",
        user: { user_id: 20002 }
      }
    });
    const shift = store.currentShiftForWaiter(waiter.id);
    assert.ok(shift);
    assert.equal(shift.status, "checklist");
    const startedChecklist = requests.filter((request) => request.endpoint === "answers").at(-1);
    const startedBody = JSON.stringify(startedChecklist?.options.body);
    assert.match(startedBody, new RegExp(fullTitle));
    assert.match(startedBody, new RegExp(fullDescription));
    assert.match(startedBody, new RegExp(`check:${shift.id}:0`));

    await max.handleUpdate({
      update_type: "message_callback",
      timestamp: Date.now(),
      callback: {
        callback_id: "complete-item",
        payload: `check:${shift.id}:0`,
        user: { user_id: 20002 }
      }
    });
    assert.equal(store.currentShiftForWaiter(waiter.id)?.status, "active");
    const completedChecklist = requests.filter((request) => request.endpoint === "answers").at(-1);
    const completedBody = JSON.stringify(completedChecklist?.options.body);
    assert.match(completedBody, /✅/);
    assert.match(completedBody, new RegExp(fullTitle));
    assert.match(completedBody, new RegExp(fullDescription));
    assert.doesNotMatch(completedBody, new RegExp(`check:${shift.id}:0`));

    await max.handleUpdate({
      update_type: "message_callback",
      timestamp: Date.now(),
      callback: {
        callback_id: "finish-shift",
        payload: "shift:end",
        user: { user_id: 20002 }
      }
    });
    assert.equal(store.currentShiftForWaiter(waiter.id), null);
    const finished = requests.filter((request) => request.endpoint === "answers").at(-1);
    assert.match(JSON.stringify(finished?.options.body), /Смена завершена/);
    assert.match(JSON.stringify(finished?.options.body), /shift:start/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
