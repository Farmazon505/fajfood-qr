import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "./config";
import { crmLoyalty } from "./crm-loyalty";
import { retryMarketingRegistrations } from "./marketing";
import { Store } from "./store";
import type { LoyaltyLead } from "./types";

const token = "a".repeat(43);
const verifiedAt = new Date().toISOString();
const input: Omit<LoyaltyLead, "id" | "createdAt" | "updatedAt"> = {
  name: "Fixture", phone: "+79000000000", birthday: "", tableId: null,
  personalDataConsent: true, personalDataConsentVersion: "fixture", personalDataConsentHash: "fixture",
  personalDataConsentAcceptedAt: verifiedAt, marketingConsent: false, consentIpAddress: "", consentUserAgent: "",
  accessTokenHash: "fixture", verificationId: "verification-1", verificationExpiresAt: null,
  phoneVerificationChannel: null, phoneVerifiedAt: null, crmUserId: null, iikoCustomerId: null, cardNumber: null,
  bonusBalance: 0, balanceUpdatedAt: null, welcomeBonusAmount: 0, welcomeBonusStatus: "PENDING", syncError: "",
  marketingVisitTokens: [token], marketingSyncPending: false, marketingSyncError: "",
};
const profile = { phoneVerifiedAt: verifiedAt, crmUserId: "fixture-user", iikoCustomerId: "fixture-iiko", cardNumber: "fixture-card" };

async function fixture(run: (store: Store, calls: Array<Record<string, unknown>>) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "qr-marketing-test-"));
  const enabled = config.MARKETING_ATTRIBUTION_ENABLED;
  const original = crmLoyalty.marketing;
  const calls: Array<Record<string, unknown>> = [];
  try {
    config.MARKETING_ATTRIBUTION_ENABLED = "true";
    crmLoyalty.marketing = async <T>(payload: unknown): Promise<T> => {
      calls.push(payload as Record<string, unknown>);
      return { recorded: true, retryable: false } as T;
    };
    const store = new Store(directory);
    await store.init();
    await run(store, calls);
  } finally {
    crmLoyalty.marketing = original;
    config.MARKETING_ATTRIBUTION_ENABLED = enabled;
    assert.ok(directory.startsWith(path.join(tmpdir(), "qr-marketing-test-")));
    await rm(directory, { recursive: true, force: true });
  }
}

test("table enrollment retries with the same attempt ID used for CRM consent, including after reload", async () => {
  await fixture(async (store, calls) => {
    const { leadId, attempt } = await store.beginLoyaltyVerification(input);
    assert.notEqual(leadId, attempt.id);
    await store.completeLoyaltyVerification(leadId, attempt, profile, false);
    await store.init();
    await retryMarketingRegistrations(store);
    assert.deepEqual(calls, [{ action: "registration", token, sourceRegistrationId: attempt.id, verificationId: attempt.verificationId }]);
    assert.equal(store.snapshot().loyaltyLeads[0].marketingSyncPending, false);
    await retryMarketingRegistrations(store);
    assert.equal(calls.length, 1);
  });
});

test("old verified registrations still use their original lead ID", async () => {
  await fixture(async (store, calls) => {
    const lead = await store.addLoyaltyLead({ ...input, ...profile, marketingSyncPending: true });
    await retryMarketingRegistrations(store);
    assert.equal(calls[0].sourceRegistrationId, lead.id);
    assert.equal(store.snapshot().loyaltyLeads[0].marketingSyncPending, false);
  });
});

test("an incomplete or different-person attempt cannot claim a conversion", async () => {
  await fixture(async (store, calls) => {
    const { leadId, attempt } = await store.beginLoyaltyVerification(input);
    await store.updateLoyaltyLead(leadId, { ...profile, marketingSyncPending: true });
    await retryMarketingRegistrations(store);
    assert.equal(calls.length, 0);
    await store.updateLoyaltyVerification(leadId, attempt.id, { ...profile, completedAt: verifiedAt, crmUserId: "other-user" });
    await retryMarketingRegistrations(store);
    assert.equal(calls.length, 0);
    assert.equal(store.snapshot().loyaltyLeads[0].marketingSyncPending, true);
  });
});
