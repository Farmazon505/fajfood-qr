import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createLoyaltyRouter } from "./loyalty-routes";
import type { LoyaltyProfile } from "./crm-loyalty";
import { Store } from "./store";

const body = { name: "Гость", phone: "+79001234567", personalDataConsent: true, marketingConsent: false };
async function fixture(run: (value: Awaited<ReturnType<typeof startFixture>>) => Promise<void>) {
  const app = await startFixture();
  try { await run(app); } finally {
    await new Promise<void>((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
    // mkdtemp created this exact disposable test directory.
    assert.ok(app.directory.startsWith(path.join(tmpdir(), "qr-loyalty-test-")));
    await rm(app.directory, { recursive: true, force: true });
  }
}
async function startFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "qr-loyalty-test-"));
  const store = new Store(directory);
  await store.init();
  const states = new Map<string, string>();
  let registrations = 0;
  let failProfile = false;
  let profile: LoyaltyProfile = { userId: "fixture-user", name: "Гость", phoneMasked: "••• 4567",
    iikoCustomerId: "fixture-iiko", cardNumber: "001234567", bonusBalance: 500, balanceUpdatedAt: new Date().toISOString(),
    alreadyRegistered: false, balanceIsFresh: true, welcomeBonus: { amount: 500, status: "GRANTED", granted: true } };
  const crm = {
    async startVerification() {
      const verificationId = `verification-${states.size + 1}`;
      states.set(verificationId, "PENDING");
      return { verificationId, pendingUserId: profile.userId, expiresAt: new Date(Date.now() + 600000).toISOString(),
        channels: { telegram: { url: "https://t.me/fixture_bot?start=verification" }, max: null } };
    },
    async getVerification(id: string) {
      const status = states.get(id) || "EXPIRED";
      return { id, status, channel: "TELEGRAM", expiresAt: new Date(Date.now() + 600000).toISOString(),
        verifiedAt: status === "VERIFIED" || status === "CONSUMED" ? new Date().toISOString() : null };
    },
    async register() { registrations++; return { ...profile }; },
    async getProfile() { if (failProfile) throw new Error("offline"); return { ...profile }; },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/public/loyalty", createLoyaltyRouter({ store, crm, limiter: (_req, _res, next) => next() }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test listener");
  const base = `http://127.0.0.1:${address.port}/api/public/loyalty`;
  const request = async (url: string, token?: string, data?: unknown) => {
    const response = await fetch(base + url, { method: data ? "POST" : "GET",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: data ? JSON.stringify(data) : undefined });
    return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
  };
  return { directory, store, server, states, request, registrations: () => registrations,
    profile: (patch: Partial<LoyaltyProfile>) => { profile = { ...profile, ...patch }; },
    failProfile: () => { failProfile = true; } };
}

test("public QR registration verifies phone before revealing the card and retries a completed response without registering twice", async () => {
  await fixture(async f => {
    const start = await f.request("", undefined, body);
    assert.equal(start.status, 202);
    assert.equal(start.body.profile, undefined);
    const v = start.body.verification;
    assert.equal((await f.request("/profile", v.accessToken)).status, 401);
    assert.equal((await f.request(`/verification/${v.id}`, v.accessToken)).status, 202);
    assert.equal(f.registrations(), 0);
    f.states.set(v.id, "VERIFIED");
    const result = await f.request(`/verification/${v.id}`, v.accessToken);
    assert.equal(result.status, 201);
    assert.equal(result.body.profile.alreadyRegistered, false);
    assert.equal(result.body.profile.bonusBalance, 500);
    assert.equal(result.cache, "no-store");
    f.states.set(v.id, "CONSUMED");
    const retry = await f.request(`/verification/${v.id}`, v.accessToken);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.profile.alreadyRegistered, false);
    assert.equal(retry.body.profile.cardNumber, "001234567");
    assert.equal(f.registrations(), 1);
  });
});

test("returning member opens the same card with current balance; an unverified attempt never signs out the original device", async () => {
  await fixture(async f => {
    const first = (await f.request("", undefined, body)).body.verification;
    f.states.set(first.id, "VERIFIED");
    await f.request(`/verification/${first.id}`, first.accessToken);
    f.profile({ alreadyRegistered: true, bonusBalance: 861.3 });
    const second = (await f.request("", undefined, { ...body, name: "Другое имя", phone: "89001234567" })).body.verification;
    assert.equal((await f.request("/profile", second.accessToken)).status, 401);
    assert.equal((await f.request(`/verification/${second.id}`, first.accessToken)).status, 401);
    assert.equal(f.store.snapshot().loyaltyLeads[0].name, "Гость");
    assert.equal((await f.request("/profile", first.accessToken)).body.profile.cardNumber, "001234567");
    f.states.set(second.id, "VERIFIED");
    const restored = await f.request(`/verification/${second.id}`, second.accessToken);
    assert.equal(restored.status, 201);
    assert.equal(restored.body.profile.alreadyRegistered, true);
    assert.equal(restored.body.profile.bonusBalance, 861.3);
    assert.equal(restored.body.profile.cardNumber, "001234567");
    assert.equal(f.store.snapshot().loyaltyLeads.length, 1);
    assert.equal((await f.request("/profile", first.accessToken)).status, 200);
    assert.equal((await f.request("/profile", second.accessToken)).status, 200);
    const reloaded = new Store(f.directory);
    await reloaded.init();
    for (const token of [first.accessToken, second.accessToken]) {
      assert.equal(reloaded.findLoyaltyLeadByTokenHash(createHash("sha256").update(token).digest("hex"))?.cardNumber, "001234567");
    }
    f.failProfile();
    const cached = await f.request("/profile", second.accessToken);
    assert.equal(cached.body.stale, true);
    assert.equal(cached.body.profile.bonusBalance, 861.3);
  });
});

test("a member registered through another channel receives their existing card after proof; expired and anonymous sessions cannot read it", async () => {
  await fixture(async f => {
    f.profile({ alreadyRegistered: true, bonusBalance: 125.45, welcomeBonus: { amount: 0, status: "SKIPPED_EXISTING_MEMBER", granted: false } });
    const old = (await f.request("", undefined, body)).body.verification;
    f.states.set(old.id, "SUPERSEDED");
    assert.equal((await f.request(`/verification/${old.id}`, old.accessToken)).status, 410);
    assert.equal((await f.request("/profile", old.accessToken)).status, 401);
    assert.equal((await f.request("/profile")).status, 401);
    const v = (await f.request("", undefined, body)).body.verification;
    f.states.set(v.id, "VERIFIED");
    const result = await f.request(`/verification/${v.id}`, v.accessToken);
    assert.equal(result.body.profile.alreadyRegistered, true);
    assert.equal(result.body.profile.cardNumber, "001234567");
    assert.equal(result.body.profile.bonusBalance, 125.45);
    assert.equal((await f.request("", undefined, { ...body, personalDataConsent: false })).status, 400);
    assert.equal((await f.request("", undefined, { ...body, tableSlug: "does-not-exist" })).status, 400);
  });
});
