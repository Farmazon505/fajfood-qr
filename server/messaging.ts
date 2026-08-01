import type { MaxService } from "./max";
import type { Store } from "./store";
import type { TelegramService } from "./telegram";
import type { DiningTable, ServiceCall, ShiftTask, VenueSettings, Waiter } from "./types";
import { config } from "./config";

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
  private taskRolloverTimer: ReturnType<typeof setInterval> | null = null;
  private taskRolloverRunning = false;

  constructor(
    private store: Store,
    private telegram: TelegramService,
    private max: MaxService
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
    return this.telegram.enabled() || this.max.enabled();
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
    if (!this.taskRolloverTimer) {
      this.taskRolloverTimer = setInterval(() => void this.processTaskRollovers(), 60_000);
      this.taskRolloverTimer.unref();
    }
    if (!this.enabled()) {
      void this.processTaskRollovers();
      return;
    }
    if (this.escalationTimer) return;
    this.escalationTimer = setInterval(() => void this.processEscalations(), 15_000);
    this.escalationTimer.unref();
    void this.processEscalations();
  }

  private async processTaskRollovers(at = Date.now()) {
    if (this.taskRolloverRunning) return;
    this.taskRolloverRunning = true;
    try {
      await this.store.rolloverIncompleteShiftTasks(venueDateKey(new Date(at)), new Date(at));
    } catch (error) {
      console.error("[messaging] Ошибка переноса заданий:", error);
    } finally {
      this.taskRolloverRunning = false;
    }
  }

  async processEscalations(at = Date.now()) {
    if (this.escalationRunning) return;
    this.escalationRunning = true;
    try {
      await this.processTaskRollovers(at);
      for (const dueCall of this.store.callsDueForAdminEscalation(at)) {
        const table = this.store.findTableById(dueCall.tableId);
        if (!table) continue;
        const reason = dueCall.status === "accepted"
          ? "Официант принял вызов, но не завершил его в течение 2 минут."
          : "Официант не принял вызов в течение 1 минуты.";
        const admins = this.store.activeAdminsForTable(table);
        if (!admins.length) {
          const ownerCall = await this.store.markOwnerEscalated(
            dueCall.id,
            `${reason} Администратор не в сети.`,
            new Date(at)
          );
          if (ownerCall) await this.syncCall(ownerCall);
          continue;
        }

        const adminCall = await this.store.startAdminEscalation(dueCall.id, reason, new Date(at));
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
        if (ownerCall) await this.syncCall(ownerCall);
      }

      for (const dueCall of this.store.callsDueForOwnerEscalation(at)) {
        const call = await this.store.markOwnerEscalated(
          dueCall.id,
          `${dueCall.routingReason} Администратор не подтвердил вызов в течение 1 минуты.`.trim(),
          new Date(at)
        );
        if (call) await this.syncCall(call);
      }

      for (const task of this.store.getShiftTasksForNotification(venueDateKey(new Date(at)))) {
        if (await this.notifyShiftTask(task)) await this.store.markShiftTaskNotified(task.id);
      }
    } finally {
      this.escalationRunning = false;
    }
  }
}
