import type { Express } from "express";
import type { Request } from "express";
import { z } from "zod";
import { venueOperationalDateKey, type Store } from "./store";
import type { MessagingService } from "./messaging";
import type { ServiceCall, Waiter } from "./types";

export function workCallAccess(store: Store, waiter: Waiter, call: ServiceCall) {
  const role = store.roleForWaiter(waiter);
  const table = store.findTableById(call.tableId);
  if (!waiter.active || !role?.active || !table) return { view: false, complete: false };
  const shift = store.currentShiftForWaiter(waiter.id);
  const supervisor = role.kind === "owner" || (role.kind === "admin" && shift?.status === "active" && shift.zones.includes(table.zone));
  const assigned = call.lastAcceptedByStaffId === waiter.id;
  const onTable = store.waitersForTable(table).some((member) => member.id === waiter.id);
  return { view: Boolean(supervisor || assigned || onTable), complete: Boolean(supervisor || assigned) };
}

export function workSnapshot(store: Store, waiter: Waiter) {
  const shift = store.currentShiftForWaiter(waiter.id);
  const snapshot = store.snapshot();
  const kind = store.roleForWaiter(waiter)?.kind;
  const canUseFloor = kind === "waiter" || kind === "admin" || kind === "owner";
  return {
    connected: true, employeeName: waiter.name, roleName: store.roleForWaiter(waiter)?.name || "Сотрудник",
    venue: snapshot.settings.name, zones: store.listZones(), canUseFloor,
    pendingReasons: store.pendingShiftTaskRolloverReasons(waiter.id).map(({ task, record }) => ({ id: record.id, title: task.title, fromDate: record.fromDate })),
    tasks: snapshot.shiftTasks.filter((task) => task.waiterId === waiter.id && !task.completedAt && task.date <= venueOperationalDateKey()
      && !shift?.checklist.some((item) => item.itemId === `task-${task.id}`))
      .map((task) => ({ id: task.id, title: task.title, description: task.description, date: task.date })),
    shift: shift ? {
      id: shift.id, status: shift.status, zones: shift.zones, startedAt: shift.startedAt, period: shift.shiftPeriod,
      checklist: shift.checklist.map((item, index) => ({
        index, id: item.itemId, title: item.title, description: item.description, phase: item.phase,
        completedAt: item.completedAt, requiredForCalls: item.requiredForCalls,
        available: item.itemId.startsWith("task-") || store.checklistPhaseWindowStatus(shift, item.phase) === "available",
        window: store.checklistPhaseWindow(shift, item.phase),
      })),
    } : null,
    tables: canUseFloor ? snapshot.tables.filter((table) => kind === "owner" || shift?.zones.includes(table.zone))
      .map((table) => ({ id: table.id, name: table.name, zone: table.zone })) : [],
    calls: canUseFloor ? snapshot.calls.filter((call) => ["new", "accepted"].includes(call.status) && workCallAccess(store, waiter, call).view)
      .map((call) => ({
        id: call.id, status: call.status, tableName: store.findTableById(call.tableId)?.name || "Стол",
        zone: store.findTableById(call.tableId)?.zone || "", reason: call.actionLabel, comment: call.comment,
        createdAt: call.cycleStartedAt, acceptedAt: call.acceptedAt, presses: call.pressCount,
        mine: call.lastAcceptedByStaffId === waiter.id,
        acceptedBy: call.lastAcceptedByStaffId ? store.findWaiterById(call.lastAcceptedByStaffId)?.name || "Сотрудник" : "",
        canComplete: workCallAccess(store, waiter, call).complete,
      })) : [],
  };
}

const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), callId: z.string().min(1).max(120) }),
  z.object({ action: z.literal("complete"), callId: z.string().min(1).max(120) }),
  z.object({ action: z.literal("start"), zones: z.array(z.string().min(1).max(120)).min(1).max(20), period: z.enum(["day", "evening", "full"]) }),
  z.object({ action: z.literal("end") }),
  z.object({ action: z.literal("check"), shiftId: z.string().min(1), itemId: z.string().min(1) }),
  z.object({ action: z.literal("reason"), recordId: z.string().min(1), reason: z.string().trim().min(5).max(2000) }),
  z.object({ action: z.literal("task"), taskId: z.string().min(1).max(120) }),
]);

export function installFajWorkRoutes(app: Express, store: Store, messaging: MessagingService, authorized: (request: Request) => boolean) {
  const syncCall = (call: ServiceCall) => { void messaging.syncCall(call).catch(() => console.error("[FAJ Work] Call notification will be retried")); };
  const resolve = (request: Request) => {
    if (!authorized(request)) throw Object.assign(new Error("Служебный доступ запрещён"), { status: 401 });
    const maxUserId = String(request.headers["x-faj-work-max-user"] || "");
    if (!/^\d{1,30}$/.test(maxUserId)) throw Object.assign(new Error("Не подтверждён профиль MAX"), { status: 403 });
    const waiter = store.findWaiterByMaxUserId(maxUserId);
    if (!waiter?.active || !store.roleForWaiter(waiter)?.active) throw Object.assign(new Error("MAX ещё не привязан к действующему сотруднику зала. Администратор должен указать его MAX ID в карточке сотрудника Qr на стол."), { status: 409 });
    return waiter;
  };
  app.get("/api/integrations/crm/work", (request, response) => {
    try { response.set("Cache-Control", "no-store").json(workSnapshot(store, resolve(request))); }
    catch (error) { response.status((error as { status?: number }).status || 500).json({ error: (error as Error).message }); }
  });
  app.post("/api/integrations/crm/work", async (request, response) => {
    try {
      const waiter = resolve(request);
      const parsed = commandSchema.safeParse(request.body);
      if (!parsed.success) { response.status(400).json({ error: "Некорректное действие" }); return; }
      const command = parsed.data;
      if (command.action === "accept" || command.action === "complete") {
        const call = store.findCallById(command.callId);
        if (!call || !workCallAccess(store, waiter, call).view) { response.status(403).json({ error: "Этот вызов вам недоступен" }); return; }
        if (command.action === "accept") {
          const result = await store.acceptCall(call.id, waiter.id);
          if (!result?.allowed || (!result.accepted && result.call.lastAcceptedByStaffId !== waiter.id)) { response.status(409).json({ error: "Вызов уже принят другим сотрудником или передан администратору" }); return; }
          if (result.call.status !== "accepted") { response.status(409).json({ error: "Вызов уже завершён" }); return; }
          await store.setCallWorkManaged(call.id);
          syncCall(store.findCallById(call.id)!);
        } else {
          if (!workCallAccess(store, waiter, call).complete) { response.status(403).json({ error: "Завершить вызов может принявший сотрудник или администратор своей зоны" }); return; }
          if (call.status !== "accepted" && call.status !== "done") { response.status(409).json({ error: "Сначала примите вызов" }); return; }
          const completed = call.status === "done" ? call : await store.completeCall(call.id);
          if (completed) void messaging.closeCallMessages(completed).catch(() => console.error("[FAJ Work] Call cleanup will be retried"));
        }
      } else if (command.action === "start") {
        const result = await store.startWaiterShift(waiter.id, command.zones, command.period);
        if (!result) { response.status(400).json({ error: "Проверьте зону и действующую должность" }); return; }
        for (const call of store.pendingCallsForWaiter(waiter.id)) syncCall(call);
      } else if (command.action === "end") {
        const mine = store.snapshot().calls.some((call) => call.status === "accepted" && call.lastAcceptedByStaffId === waiter.id);
        if (mine) { response.status(409).json({ error: "Сначала завершите принятые вызовы или обратитесь к администратору" }); return; }
        const result = await store.requestEndWaiterShift(waiter.id);
        if (result.status === "closing_checklist_incomplete") { response.status(409).json({ error: "Сначала заполните чек-лист закрытия" }); return; }
        if (result.status === "ended") {
          await messaging.clearEmployeeCallNotifications(waiter.id);
          await messaging.processEndedShiftTasks(result.shift);
        }
      } else if (command.action === "check") {
        const shift = store.currentShiftForWaiter(waiter.id);
        if (!shift || shift.id !== command.shiftId) { response.status(409).json({ error: "Смена уже изменилась. Обновите страницу" }); return; }
        const result = await store.completeShiftChecklistItem(shift.id, waiter.id, shift.checklist.findIndex((item) => item.itemId === command.itemId));
        if (!["completed", "already_completed"].includes(result.status)) {
          response.status(409).json({ error: result.status === "cooldown" ? `Следующий пункт можно отметить через ${result.retryAfterSeconds} сек.` : "Этот пункт сейчас недоступен. Проверьте время чек-листа" }); return;
        }
        for (const call of store.pendingCallsForWaiter(waiter.id)) syncCall(call);
      } else if (command.action === "task") {
        const task = store.listShiftTasks().find((item) => item.id === command.taskId && item.waiterId === waiter.id && item.date <= venueOperationalDateKey());
        if (!task) { response.status(403).json({ error: "Задание вам недоступно" }); return; }
        await store.completeShiftTask(task.id, waiter.id);
        for (const call of store.pendingCallsForWaiter(waiter.id)) syncCall(call);
      } else {
        if (!await store.setShiftTaskRolloverReason(command.recordId, waiter.id, command.reason)) { response.status(403).json({ error: "Задание вам недоступно" }); return; }
      }
      response.set("Cache-Control", "no-store").json(workSnapshot(store, waiter));
    } catch (error) { response.status((error as { status?: number }).status || 500).json({ error: (error as Error).message }); }
  });
}
