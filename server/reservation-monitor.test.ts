import assert from "node:assert/strict";
import test from "node:test";

import type {
  CrmStaffReservation,
  CrmStaffSnapshot,
} from "./crm-reservations";
import {
  isWaiterReservationNotificationEligible,
  ReservationMonitor,
} from "./reservation-monitor";

const reservation = (
  overrides: Partial<CrmStaffReservation> = {}
): CrmStaffReservation => ({
  id: "reservation-1",
  isIikoExternal: false,
  guestName: "Гость",
  guestPhone: null,
  guestsCount: 2,
  date: "2026-08-04T14:00:00.000Z",
  duration: 120,
  deposit: 1_000,
  depositPaid: false,
  notes: null,
  guestNotes: null,
  tags: [],
  status: "PENDING",
  source: "TELEGRAM",
  responsible: null,
  tableId: "table-1",
  ...overrides,
});

const snapshot = (item: CrmStaffReservation): CrmStaffSnapshot => ({
  date: "2026-08-04",
  halls: [{ key: "main", name: "Основной зал", emoji: "", color: "#fff", order: 1 }],
  decor: [],
  tables: [{
    id: "table-1",
    number: 7,
    capacity: 4,
    hall: "main",
    posX: 0,
    posY: 0,
    shape: "RECTANGLE",
    width: 100,
    height: 100,
    label: null,
    iikoTableId: null,
    iikoState: { online: true, occupied: false, activeOrder: null },
    reservations: [item],
  }],
  iikoSync: { online: true, syncedAt: null, errors: [], occupiedTables: 0 },
});

test("allows waiter notifications only for paid confirmed reservations and their later states", () => {
  assert.equal(isWaiterReservationNotificationEligible(reservation()), false);
  assert.equal(isWaiterReservationNotificationEligible(reservation({ depositPaid: true })), false);
  assert.equal(isWaiterReservationNotificationEligible(reservation({ status: "CONFIRMED" })), false);
  assert.equal(isWaiterReservationNotificationEligible(reservation({ depositPaid: true, status: "CONFIRMED" })), true);
  assert.equal(isWaiterReservationNotificationEligible(reservation({ depositPaid: true, status: "CANCELLED" })), true);
});

test("notifies once when an unpaid reservation becomes paid and confirmed", async () => {
  let currentSnapshot = snapshot(reservation());
  const delivered: Array<{ event: string; reservation: CrmStaffReservation }> = [];
  const crm = {
    enabled: () => true,
    getSnapshot: async () => currentSnapshot,
  };
  const telegram = {
    enabled: () => true,
    notifyReservationEvent: async (input: { event: string; reservation: CrmStaffReservation }) => {
      delivered.push(input);
      return 1;
    },
  };
  const store = {
    snapshot: () => ({
      waiters: [{ id: "waiter-1", active: true, telegramChatId: "100" }],
    }),
    currentShiftForWaiter: () => ({ status: "active", zones: ["Основной зал"] }),
  };
  const monitor = new ReservationMonitor(store as never, telegram as never, crm as never);
  const now = new Date("2026-08-04T12:00:00.000Z");

  await monitor.poll(now);
  currentSnapshot = snapshot(reservation({ depositPaid: true }));
  await monitor.poll(now);
  assert.equal(delivered.length, 0);

  currentSnapshot = snapshot(reservation({ depositPaid: true, status: "CONFIRMED" }));
  await monitor.poll(now);
  assert.deepEqual(delivered.map((item) => item.event), ["new"]);

  currentSnapshot = snapshot(reservation({
    depositPaid: true,
    status: "CONFIRMED",
    notes: "Стол у окна",
  }));
  await monitor.poll(now);
  assert.deepEqual(delivered.map((item) => item.event), ["new", "changed"]);
});

test("does not duplicate the paid notification with an immediate 30-minute reminder", async () => {
  let currentSnapshot = snapshot(reservation({ date: "2026-08-04T12:20:00.000Z" }));
  const delivered: string[] = [];
  const monitor = new ReservationMonitor(
    {
      snapshot: () => ({ waiters: [{ id: "waiter-1", active: true, telegramChatId: "100" }] }),
      currentShiftForWaiter: () => ({ status: "active", zones: ["Основной зал"] }),
    } as never,
    {
      enabled: () => true,
      notifyReservationEvent: async (input: { event: string }) => {
        delivered.push(input.event);
        return 1;
      },
    } as never,
    { enabled: () => true, getSnapshot: async () => currentSnapshot } as never,
  );
  const now = new Date("2026-08-04T12:00:00.000Z");

  await monitor.poll(now);
  currentSnapshot = snapshot(reservation({
    date: "2026-08-04T12:20:00.000Z",
    depositPaid: true,
    status: "CONFIRMED",
  }));
  await monitor.poll(now);

  assert.deepEqual(delivered, ["new"]);
});
