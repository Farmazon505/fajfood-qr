import type { MaxService } from "./max";
import type { Store } from "./store";
import type { TelegramService } from "./telegram";
import type { DiningTable, ServiceCall, ShiftTask, VenueSettings, Waiter } from "./types";
import { config } from "./config";
import type { OwnerWebPushService } from "./web-push";

type CallNotification = {
  call: ServiceCall;
  table: DiningTable;
  waiters: Waiter[];
  settings: VenueSettings;
};

const venueDateKey = (value = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: config.VENUE_TIME_ZONE }).format(value);

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
      const currentDateKey = venueDateKey(currentTime);
      await this.store.endOpenShiftsBeforeDate(currentDateKey, currentTime);
      await this.store.rolloverIncompleteShiftTasks(currentDateKey, currentTime);
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

      for (const task of this.store.getShiftTasksForNotification(venueDateKey(new Date(at)))) {
        if (await this.notifyShiftTask(task)) await this.store.markShiftTaskNotified(task.id);
      }
    } finally {
      this.escalationRunning = false;
    }
  }
}
