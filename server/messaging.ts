import type { MaxService } from "./max";
import { venueOperationalDateKey, type Store } from "./store";
import type { TelegramService } from "./telegram";
import type { DeliveryPickupAlert, DiningTable, ServiceCall, ShiftTask, ShiftTaskRolloverRecord, VenueSettings, Waiter, WaiterShift } from "./types";
import { config } from "./config";
import type { OwnerWebPushService } from "./web-push";
import { nextDateKey } from "../shared/shift-tasks";

type CallNotification = {
  call: ServiceCall;
  table: DiningTable;
  waiters: Waiter[];
  settings: VenueSettings;
};

export class MessagingService {
  private escalationTimer: ReturnType<typeof setInterval> | null = null;
  private escalationRunning = false;
  private dailyMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private dailyMaintenanceRunning = false;

  constructor(
    private store: Store,
    private telegram: TelegramService,
    private max: MaxService,
    private webPush: OwnerWebPushService | null = null
  ) {
    const coordinator = {
      syncCall: async (call: ServiceCall) => {
        await this.syncCall(call);
      },
      closeCall: async (call: ServiceCall) => {
        await this.closeCallMessages(call);
      },
      notifyClosingChecklistIncomplete: async (shift: WaiterShift) => {
        await this.notifyClosingChecklistIncomplete(shift);
      },
      notifyAdminShiftSummary: async (shift: WaiterShift) => {
        await this.notifyAdminShiftSummary(shift);
      },
      processEndedShiftTasks: async (shift: WaiterShift) => {
        return this.processEndedShiftTasks(shift);
      },
      acknowledgeDeliveryPickupAlert: async (alertId: string, waiterId: string) => {
        return this.acknowledgeDeliveryPickupAlert(alertId, waiterId);
      }
    };
    this.telegram.setCallCoordinator(coordinator);
    this.max.setCallCoordinator(coordinator);
  }

  enabled() {
    return this.telegram.enabled() || this.max.enabled() || Boolean(this.webPush?.enabled());
  }

  async notifyCall(options: CallNotification) {
    const results = await Promise.allSettled([
      this.telegram.notifyCall(options),
      this.max.notifyCall(options)
    ]);
    for (const result of results) {
      if (result.status === "rejected") console.error("[messaging] Ошибка доставки вызова:", result.reason);
    }
    return results.reduce((total, result) => total + (result.status === "fulfilled" ? result.value.length : 0), 0);
  }

  async syncCall(call: ServiceCall) {
    const current = this.store.findCallById(call.id) ?? call;
    const table = this.store.findTableById(current.tableId);
    if (!table) return;
    await this.notifyCall({
      call: current,
      table,
      waiters: this.store.waitersForTable(table),
      settings: this.store.snapshot().settings
    });
  }

  async closeCallMessages(call: ServiceCall) {
    const results = await Promise.allSettled([
      this.telegram.closeCallMessages(call),
      this.max.closeCallMessages(call)
    ]);
    for (const result of results) {
      if (result.status === "rejected") console.error("[messaging] Ошибка удаления сообщения:", result.reason);
    }
  }

  async notifyOwnerEscalation(call: ServiceCall) {
    const table = this.store.findTableById(call.tableId);
    if (!table) return 0;
    const [messengerDelivered, pushResult] = await Promise.all([
      this.notifyCall({
        call,
        table,
        waiters: [],
        settings: this.store.snapshot().settings
      }),
      this.webPush?.notify({
        title: "Срочный вызов гостя",
        body: `${table.name}${table.zone ? ` · ${table.zone}` : ""}: ${call.actionLabel}. ${call.routingReason}`.trim(),
        url: "/admin",
        tag: `call-${call.id}`
      }) ?? Promise.resolve({ sent: 0, failed: 0, removed: 0 })
    ]);
    return messengerDelivered + pushResult.sent;
  }

  async notifyShiftTask(task: ShiftTask) {
    const results = await Promise.allSettled([
      this.telegram.notifyShiftTask(task),
      this.max.notifyShiftTask(task)
    ]);
    for (const result of results) {
      if (result.status === "rejected") console.error("[messaging] Ошибка доставки задания:", result.reason);
    }
    return results.some((result) => result.status === "fulfilled" && result.value);
  }

  async notifyShiftTaskRollover(task: ShiftTask, record: ShiftTaskRolloverRecord) {
    const results = await Promise.allSettled([
      this.telegram.notifyShiftTaskRollover(task, record),
      this.max.notifyShiftTaskRollover(task, record)
    ]);
    for (const result of results) {
      if (result.status === "rejected") console.error("[messaging] Ошибка запроса причины переноса:", result.reason);
    }
    return results.some((result) => result.status === "fulfilled" && result.value);
  }

  async processEndedShiftTasks(shift: WaiterShift, processedAt = new Date()) {
    const nextShiftDate = nextDateKey(shift.morningGreetingDate);
    const currentOperationalDate = venueOperationalDateKey(processedAt);
    const carried = await this.store.rolloverIncompleteShiftTasksForShift(
      shift.id,
      currentOperationalDate > nextShiftDate ? currentOperationalDate : nextShiftDate,
      processedAt
    );
    for (const task of carried) {
      const record = [...(task.rolloverHistory || [])].at(-1);
      if (record) await this.notifyShiftTaskRollover(task, record);
    }
    return carried;
  }

  async notifyDeliveryCorrectionApproval(text: string) {
    const admins = this.store.activeShiftAdmins();
    if (!admins.length) return { admins: 0, delivered: 0 };
    const results = await Promise.allSettled([
      this.telegram.notifyDeliveryCorrectionApproval(admins, text),
      this.max.notifyDeliveryCorrectionApproval(admins, text)
    ]);
    for (const result of results) {
      if (result.status === "rejected") console.error("[messaging] Ошибка доставки кода коррекции:", result.reason);
    }
    return {
      admins: admins.length,
      delivered: results.reduce(
        (total, result) => total + (result.status === "fulfilled" ? result.value : 0),
        0
      )
    };
  }

  async notifyDeliveryPickupAlert(alert: DeliveryPickupAlert) {
    const packers = this.store.activeShiftPackers();
    let admins = packers.length ? [] : this.store.activeShiftAdmins();
    let recipients = packers.length ? packers : admins;
    if (!recipients.length) return { packers: 0, admins: 0, delivered: 0, fallbackToAdmin: false };
    const deliver = async (targets: Waiter[]) => {
      const results = await Promise.allSettled([
        this.telegram.notifyDeliveryPickupAlert(targets, alert),
        this.max.notifyDeliveryPickupAlert(targets, alert)
      ]);
      for (const result of results) {
        if (result.status === "rejected") console.error("[messaging] Ошибка уведомления упаковщика:", result.reason);
      }
      return results.reduce(
        (total, result) => total + (result.status === "fulfilled" ? result.value : 0),
        0
      );
    };
    let delivered = await deliver(recipients);
    let fallbackToAdmin = !packers.length;
    if (packers.length && !delivered) {
      admins = this.store.activeShiftAdmins();
      if (admins.length) {
        recipients = admins;
        fallbackToAdmin = true;
        delivered = await deliver(recipients);
      }
    }
    await this.store.recordDeliveryPickupAlertNotification(alert.id, {
      recipientWaiterIds: recipients.map((recipient) => recipient.id),
      fallbackToAdmin,
      delivered
    });
    return {
      packers: packers.length,
      admins: admins.length,
      delivered,
      fallbackToAdmin
    };
  }

  async acknowledgeDeliveryPickupAlert(alertId: string, waiterId: string) {
    const result = await this.store.acknowledgeDeliveryPickupAlert(alertId, waiterId);
    if (!result.alert || !["acknowledged", "already_acknowledged"].includes(result.status)) return result;
    const secret = config.CRM_STAFF_SERVICE_SECRET.trim();
    const baseUrl = config.CRM_BASE_URL.replace(/\/$/, "");
    if (!baseUrl || secret.length < 32 || !result.alert.acknowledgedById || !result.alert.acknowledgedByName || !result.alert.acknowledgedAt) {
      return result;
    }
    try {
      const response = await fetch(`${baseUrl}/api/integrations/qr/delivery-pickup-alert/ack`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          "x-qrnastol-staff-secret": secret
        },
        body: JSON.stringify({
          alertId: result.alert.externalId,
          acknowledgedById: result.alert.acknowledgedById,
          acknowledgedByName: result.alert.acknowledgedByName,
          acknowledgedAt: result.alert.acknowledgedAt
        })
      });
      if (!response.ok) throw new Error(`CRM вернула ${response.status}`);
    } catch (error) {
      console.error("[messaging] Не удалось передать подтверждение упаковщика в CRM:", error);
    }
    return result;
  }

  async notifyClosingChecklistIncomplete(shift: WaiterShift) {
    const results = await Promise.allSettled([
      this.telegram.notifyClosingChecklistIncomplete(shift),
      this.max.notifyClosingChecklistIncomplete(shift)
    ]);
    for (const result of results) {
      if (result.status === "rejected") console.error("[messaging] Ошибка уведомления о чек-листе закрытия:", result.reason);
    }
  }

  async notifyAdminShiftSummary(shift: WaiterShift) {
    const results = await Promise.allSettled([
      this.telegram.notifyAdminShiftSummary(shift),
      this.max.notifyAdminShiftSummary(shift)
    ]);
    for (const result of results) {
      if (result.status === "rejected") console.error("[messaging] Ошибка доставки итогов смены администратора:", result.reason);
    }
  }

  start() {
    this.telegram.startPolling(false);
    void this.max.start().catch((error) => console.error("[max start]", error));
    if (!this.dailyMaintenanceTimer) {
      this.dailyMaintenanceTimer = setInterval(() => void this.processDailyMaintenance(), 60_000);
      this.dailyMaintenanceTimer.unref();
    }
    if (!this.enabled()) {
      void this.processDailyMaintenance();
      return;
    }
    if (this.escalationTimer) return;
    this.escalationTimer = setInterval(() => void this.processEscalations(), 15_000);
    this.escalationTimer.unref();
    void this.processEscalations();
  }

  private async processDailyMaintenance(at = Date.now()) {
    if (this.dailyMaintenanceRunning) return;
    this.dailyMaintenanceRunning = true;
    try {
      const currentTime = new Date(at);
      const currentDateKey = venueOperationalDateKey(currentTime);
      const endedShifts = await this.store.endOpenShiftsBeforeDate(currentDateKey, currentTime);
      for (const shift of endedShifts) {
        const incompleteClosing = shift.checklist.some((item) => item.phase === "closing" && !item.completedAt);
        if (incompleteClosing && (shift.roleKind === "waiter" || shift.roleId === "barista")) {
          await this.notifyClosingChecklistIncomplete(shift);
        }
        await this.processEndedShiftTasks(shift, currentTime);
      }
      for (const shift of endedShifts.filter((item) => item.roleKind === "admin")) {
        await this.notifyAdminShiftSummary(shift);
      }
      const additionallyCarried = await this.store.rolloverIncompleteShiftTasks(currentDateKey, currentTime);
      for (const task of additionallyCarried) {
        const record = [...(task.rolloverHistory || [])].at(-1);
        if (record) await this.notifyShiftTaskRollover(task, record);
      }
    } catch (error) {
      console.error("[messaging] Ошибка ежедневного обслуживания:", error);
    } finally {
      this.dailyMaintenanceRunning = false;
    }
  }

  async processEscalations(at = Date.now()) {
    if (this.escalationRunning) return;
    this.escalationRunning = true;
    try {
      await this.processDailyMaintenance(at);
      for (const dueCall of this.store.callsDueForAdminEscalation(at)) {
        const table = this.store.findTableById(dueCall.tableId);
        if (!table) continue;
        const reason = dueCall.status === "accepted"
          ? "Официант принял вызов, но не завершил его в течение 2 минут."
          : "Официант не принял вызов в течение 1 минуты.";
        const admins = this.store.activeAdminsForTable(table);
        if (dueCall.status === "new") {
          await this.store.recordMissedCallRecipients(
            dueCall.id,
            "waiter",
            dueCall.waiterRecipientIds.length
              ? dueCall.waiterRecipientIds
              : dueCall.assignedWaiterId ? [dueCall.assignedWaiterId] : [],
            new Date(at)
          );
        }
        if (!admins.length) {
          const ownerCall = await this.store.markOwnerEscalated(
            dueCall.id,
            `${reason} Администратор не в сети.`,
            new Date(at)
          );
          if (ownerCall) await this.notifyOwnerEscalation(ownerCall);
          continue;
        }

        const adminCall = await this.store.startAdminEscalation(
          dueCall.id,
          reason,
          admins.map((admin) => admin.id),
          new Date(at)
        );
        if (!adminCall) continue;
        const delivered = await this.notifyCall({
          call: adminCall,
          table,
          waiters: [],
          settings: this.store.snapshot().settings
        });
        if (delivered > 0) continue;

        const ownerCall = await this.store.markOwnerEscalated(
          adminCall.id,
          `${reason} Уведомление администратору не доставлено.`,
          new Date(at)
        );
        if (ownerCall) await this.notifyOwnerEscalation(ownerCall);
      }

      for (const dueCall of this.store.callsDueForOwnerEscalation(at)) {
        await this.store.recordMissedCallRecipients(
          dueCall.id,
          "admin",
          dueCall.adminRecipientIds,
          new Date(at)
        );
        const call = await this.store.markOwnerEscalated(
          dueCall.id,
          `${dueCall.routingReason} Администратор не подтвердил вызов в течение 1 минуты.`.trim(),
          new Date(at)
        );
        if (call) await this.notifyOwnerEscalation(call);
      }

      for (const shift of this.store.shiftsDueForChecklistAlert(at)) {
        const pending = shift.checklist.filter((item) => item.requiredForCalls && !item.completedAt);
        const titles = pending.slice(0, 3).map((item) => item.title).join(", ");
        const more = pending.length > 3 ? ` и ещё ${pending.length - 3}` : "";
        const body = `${shift.waiterName} не завершил обязательный чек-лист. Не выполнено: ${titles}${more}.`;
        const telegramText = [
          "⚠️ Чек-лист не завершён",
          `Сотрудник: ${shift.waiterName}`,
          `Должность: ${shift.roleName}`,
          `Не выполнено: ${titles}${more}`,
          `${config.CHECKLIST_OVERDUE_MINUTES} минут с начала смены.`,
          `${config.PUBLIC_BASE_URL || ""}/admin`
        ].filter(Boolean).join("\n");
        const [telegramResult, pushResult] = await Promise.all([
          this.telegram.notifyOwnerAlert(telegramText),
          this.webPush?.notify({
            title: "Чек-лист не завершён",
            body,
            url: "/admin",
            tag: `checklist-${shift.id}`
          }) ?? Promise.resolve({ sent: 0, failed: 0, removed: 0 })
        ]);
        if (telegramResult + pushResult.sent > 0) {
          await this.store.markChecklistOverdueNotified(shift.id, new Date(at));
        }
      }

      for (const task of this.store.getShiftTasksForNotification(venueOperationalDateKey(new Date(at)))) {
        if (await this.notifyShiftTask(task)) await this.store.markShiftTaskNotified(task.id);
      }
    } finally {
      this.escalationRunning = false;
    }
  }
}
