import assert from "node:assert/strict";
import test from "node:test";
import { swipeProgress } from "../src/admin-swipe";

test("admin swipe follows a horizontal right gesture and ignores vertical scrolling", () => {
  const start = { x: 5, y: 120, pointerId: 1 };
  assert.equal(swipeProgress(start, 35, 124).horizontal, true);
  assert.equal(swipeProgress(start, 35, 124).complete, false);
  assert.equal(swipeProgress(start, 70, 126).complete, true);
  assert.equal(swipeProgress(start, 20, 170).horizontal, false);
  assert.equal(swipeProgress(start, 0, 120).dx, 0);
});
