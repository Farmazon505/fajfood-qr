import test from "node:test";
import assert from "node:assert/strict";
import { parseStoredVerification } from "../src/loyalty-verification-storage";
test("pending phone verification survives reload only while valid and with allowed bot destinations", () => {
  const now = Date.parse("2026-09-11T05:00:00Z");
  const state = { id: "verification123", accessToken: "a".repeat(43), expiresAt: new Date(now + 600_000).toISOString(),
    channels: { telegram: { url: "https://t.me/faj_bot?start=loyalty_123" }, max: null } };
  assert.deepEqual(parseStoredVerification(JSON.stringify(state), now), state);
  assert.equal(parseStoredVerification(JSON.stringify(state), now + 600_001), null);
  assert.equal(parseStoredVerification("broken", now), null);
  assert.equal(parseStoredVerification(JSON.stringify({ ...state, accessToken: "bad" }), now), null);
  assert.equal(parseStoredVerification(JSON.stringify({ ...state, channels: { telegram: { url: "https://evil.test/" }, max: null } }), now), null);
});
