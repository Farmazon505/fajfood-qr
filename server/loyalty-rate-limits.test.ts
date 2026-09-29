import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createLoyaltyRateLimits } from "./loyalty-rate-limits";

test("shared Wi-Fi permits different guests; phone aliases share a retry budget and verification polling is isolated", async () => {
  const app = express(); const limits = createLoyaltyRateLimits();
  app.use(express.json(), limits.reads);
  app.post("/", limits.attempts, (_req, res) => res.status(202).json({ ok: true }));
  app.get("/", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  const post = (phone: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
  try {
    for (let n = 0; n < 12; n++) assert.equal((await post(`+790012340${String(n).padStart(2, "0")}`)).status, 202);
    for (const phone of ["89001234000", "9001234000", "+7 (900) 123-40-00", "79001234000"]) assert.equal((await post(phone)).status, 202);
    const limited = await post("+79001234000");
    assert.equal(limited.status, 429);
    const body = await limited.json();
    assert.equal(body.code, "LOYALTY_RATE_LIMIT");
    assert.ok(body.retryAfterSeconds > 0 && body.retryAfterSeconds <= 900);
    assert.match(body.error, /Повторите через/);
    assert.equal((await post("+79009999999")).status, 202);
    const get = (token: string) => fetch(url, { headers: { authorization: `Bearer ${token.repeat(43)}` } });
    for (let n = 0; n < 90; n++) assert.equal((await get("a")).status, 200);
    assert.equal((await get("a")).status, 429);
    assert.equal((await get("b")).status, 200);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
