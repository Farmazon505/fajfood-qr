import assert from "node:assert/strict";
import test from "node:test";

import { filterSnapshotForZones, staffZoneMatchesHall } from "./staff-reservation-access";

test("matches Qrnastol floor zones to CRM hall names", () => {
  assert.equal(staffZoneMatchesHall(["Зал 1-й этаж"], "1-этаж", "Зал 1 этаж"), true);
  assert.equal(staffZoneMatchesHall(["Зал 1-й этаж"], "2-этаж", "Зал 2 этаж"), false);
  assert.equal(staffZoneMatchesHall(["Терраса"], "terrace", "Терраса"), true);
});

test("keeps hall decor only for the employee shift zones", () => {
  const filtered = filterSnapshotForZones({
    date: "2026-07-19",
    halls: [
      { key: "1-этаж", name: "Зал 1 этаж", emoji: "", color: "#fff", order: 1 },
      { key: "2-этаж", name: "Зал 2 этаж", emoji: "", color: "#fff", order: 2 },
    ],
    decor: [
      { id: "wall-1", hallKey: "1-этаж", type: "wall", label: "Стена", posX: 0, posY: 0, width: 200, height: 20, angle: 0 },
      { id: "bar-2", hallKey: "2-этаж", type: "bar", label: "Бар", posX: 20, posY: 40, width: 160, height: 60, angle: 0 },
    ],
    tables: [],
    iikoSync: { online: true, syncedAt: null, errors: [], occupiedTables: 0 },
  }, ["Зал 1-й этаж"]);

  assert.deepEqual(filtered.halls.map((hall) => hall.key), ["1-этаж"]);
  assert.deepEqual(filtered.decor.map((item) => item.id), ["wall-1"]);
});
