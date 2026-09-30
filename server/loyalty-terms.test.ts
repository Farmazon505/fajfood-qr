import assert from "node:assert/strict";
import test from "node:test";
import { createLoyaltyTermsLoader } from "./loyalty-terms";
import { guestPopups } from "../src/loyalty-promotion";
import { popupEligible } from "../src/marketing";
import type { GuestLoyaltyTerms } from "../shared/loyalty-terms";

const terms: GuestLoyaltyTerms = { version: 1, welcomeAmount: 500, birthday: null,
  sections: [{ title: "Условия", text: "Только новые участники" }] };

test("table promotion uses the CRM amount; missing terms or disabled flag never promise a gift", () => {
  assert.deepEqual(guestPopups([], null, true, true), []);
  assert.deepEqual(guestPopups([], terms, false, true), []);
  assert.deepEqual(guestPopups([], terms, true, false), []);
  const popups = guestPopups([], { ...terms, welcomeAmount: 750 }, true, true);
  assert.match(popups[0].title, /750/);
  assert.equal(popups[0].buttonUrl, "/loyalty");
  assert.equal(guestPopups(popups, terms, true, true).length, 1);
});

test("registered, busy and recently dismissed guests are not interrupted", () => {
  const input = { hasCard: false, isRegistering: false, isLoyalty: true, lastSeen: 0, now: 100000000 };
  assert.equal(popupEligible(input), true);
  assert.equal(popupEligible({ ...input, hasCard: true }), false);
  assert.equal(popupEligible({ ...input, isRegistering: true }), false);
  assert.equal(popupEligible({ ...input, lastSeen: input.now - 1000 }), false);
  assert.equal(popupEligible({ ...input, lastSeen: input.now - 86400000 }), true);
});

test("terms coalesce requests and stop advertising stale promises after failed refresh", async () => {
  let now = 1; let calls = 0; let offline = false;
  const load = createLoyaltyTermsLoader(async () => { calls++; if (offline) throw new Error("offline"); return terms; }, () => now);
  assert.deepEqual(await Promise.all([load(), load(), load()]), [terms, terms, terms]);
  assert.equal(calls, 1);
  now += 30001; offline = true;
  assert.equal(await load(), null);
  assert.equal(await load(), null);
  assert.equal(calls, 2);
  offline = false; now += 30001;
  assert.deepEqual(await load(), terms);
});

test("malformed CRM response cannot produce a financial offer", async () => {
  const load = createLoyaltyTermsLoader(async () => ({ ...terms, welcomeAmount: "500" }));
  assert.equal(await load(), null);
});
