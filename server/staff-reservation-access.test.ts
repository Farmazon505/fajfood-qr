import assert from "node:assert/strict";
import test from "node:test";

import { staffZoneMatchesHall } from "./staff-reservation-access";

test("matches Qrnastol floor zones to CRM hall names", () => {
  assert.equal(staffZoneMatchesHall(["Зал 1-й этаж"], "1-этаж", "Зал 1 этаж"), true);
  assert.equal(staffZoneMatchesHall(["Зал 1-й этаж"], "2-этаж", "Зал 2 этаж"), false);
  assert.equal(staffZoneMatchesHall(["Терраса"], "terrace", "Терраса"), true);
});
