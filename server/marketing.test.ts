import test from "node:test";
import assert from "node:assert/strict";
import { marketingTokens } from "./marketing";
import { isLoyaltyPopup, popupEligible } from "../src/marketing";

test("malformed marketing cookies are ignored and tokens are bounded", () => {
  assert.deepEqual(marketingTokens({ headers: { cookie: "faj_marketing_visits=%bad" } }), []);
  assert.deepEqual(marketingTokens({ headers: { cookie: `faj_marketing_visits=${encodeURIComponent(JSON.stringify(["phone=70000000000", "a".repeat(43), "a".repeat(43)]))}` } }), ["a".repeat(43)]);
  const values = Array.from({ length: 12 }, (_, i) => `${i}`.padStart(43, "a"));
  assert.equal(marketingTokens({ headers: { cookie: `faj_marketing_visits=${encodeURIComponent(JSON.stringify(values))}` } }).length, 5);
});
test("loyalty popup is suppressed for cardholders, during registration and for 24h after dismissal", () => {
  const state = { hasCard: false, isRegistering: false, isLoyalty: true, lastSeen: 0, now: 2 * 86_400_000 };
  assert.equal(popupEligible(state), true);
  assert.equal(popupEligible({ ...state, hasCard: true }), false);
  assert.equal(popupEligible({ ...state, isRegistering: true }), false);
  assert.equal(popupEligible({ ...state, lastSeen: state.now - 60_000 }), false);
  assert.equal(popupEligible({ ...state, lastSeen: state.now - 86_400_000 }), true);
  assert.equal(isLoyaltyPopup({ buttonUrl: "/loyalty" }), true);
  assert.equal(isLoyaltyPopup({ buttonUrl: "/t/table-1/loyalty" }), true);
  assert.equal(isLoyaltyPopup({ buttonUrl: "/offers" }), false);
});
test("the first acquisition survives later on-site visits", () => {
  const first = "f".repeat(43);
  const recent = Array.from({ length: 8 }, (_, i) => `${i}`.padStart(43, "a"));
  const tokens = marketingTokens({ headers: { cookie: `faj_first_acquisition=${first}; faj_marketing_visits=${encodeURIComponent(JSON.stringify(recent))}` } });
  assert.equal(tokens[0], first); assert.equal(tokens.at(-1), recent.at(-1)); assert.equal(tokens.length, 6);
});
