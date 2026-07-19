import type { Store } from "./store";
import type { TelegramService } from "./telegram";
import {
  CrmReservationsClient,
  type CrmStaffReservation,
  type CrmStaffTable,
} from "./crm-reservations";
import { config } from "./config";
import { staffZoneMatchesHall } from "./staff-reservation-access";

const dateKey = (value = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: config.VENUE_TIME_ZONE }).format(value);

const fingerprint = (reservation: CrmStaffReservation) => JSON.stringify([
  reservation.status,
  reservation.tableId,
  reservation.date,
  reservation.guestsCount,
  reservation.notes,
]);

export class ReservationMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private seeded = false;
  private known = new Map<string, string>();
  private reminders = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly telegram: TelegramService,
    private readonly crm: CrmReservationsClient,
    private readonly intervalMs = 20_000
  ) {}

  start() {
    if (this.timer || !this.crm.enabled() || !this.telegram.enabled()) return;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref();
    void this.poll();
  }

  async poll(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      const snapshot = await this.crm.getSnapshot(dateKey(now));
      const halls = new Map(snapshot.halls.map((hall) => [hall.key, hall.name]));
      const current = new Map<string, string>();

      for (const table of snapshot.tables) {
        const hallName = halls.get(table.hall) || table.hall;
        for (const reservation of table.reservations) {
          const nextFingerprint = fingerprint(reservation);
          current.set(reservation.id, nextFingerprint);
          const previous = this.known.get(reservation.id);
          if (this.seeded && previous !== nextFingerprint) {
            await this.notify(previous ? "changed" : "new", reservation, table, hallName);
          }

          if (reservation.status === "CONFIRMED" || reservation.status === "PENDING") {
            const startsIn = new Date(reservation.date).getTime() - now.getTime();
            const reminderKey = `${reservation.id}:${reservation.date}`;
            if (startsIn > 0 && startsIn <= 30 * 60_000 && !this.reminders.has(reminderKey)) {
              this.reminders.add(reminderKey);
              await this.notify("reminder", reservation, table, hallName);
            }
          }
        }
      }

      this.known = current;
      this.seeded = true;
    } catch (error) {
      console.error("[reservation monitor]", error);
    } finally {
      this.running = false;
    }
  }

  private async notify(
    event: "new" | "changed" | "reminder",
    reservation: CrmStaffReservation,
    table: CrmStaffTable,
    hallName: string
  ) {
    const recipients = this.store.snapshot().waiters.filter((waiter) => {
      if (!waiter.active || !waiter.telegramChatId.trim()) return false;
      const shift = this.store.currentShiftForWaiter(waiter.id);
      return Boolean(
        shift?.status === "active"
        && staffZoneMatchesHall(shift.zones, table.hall, hallName)
      );
    });
    if (!recipients.length) return;
    await this.telegram.notifyReservationEvent({
      recipients,
      reservation,
      tableNumber: table.number,
      hallName,
      event,
    });
  }
}
