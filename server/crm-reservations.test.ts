import assert from "node:assert/strict";
import test from "node:test";

import { CrmReservationsClient, CrmReservationsError } from "./crm-reservations";

test("keeps the CRM staff secret on the server", async () => {
  let received: RequestInit | undefined;
  const fetcher = (async (_input, init) => {
    received = init;
    return new Response(JSON.stringify({ date: "2026-07-19", halls: [], decor: [], tables: [], iikoSync: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const client = new CrmReservationsClient("https://crm.example", "s".repeat(32), fetcher);
  await client.getSnapshot("2026-07-19");
  assert.equal((received?.headers as Record<string, string>)["x-qrnastol-staff-secret"], "s".repeat(32));
});

test("passes a safe CRM error to the Mini App API", async () => {
  const fetcher = (async () => new Response(JSON.stringify({ error: "Стол занят" }), {
    status: 409,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  const client = new CrmReservationsClient("https://crm.example", "s".repeat(32), fetcher);
  await assert.rejects(() => client.updateReservation({ id: "r1", actor: "Анна" }), (error) => {
    assert.ok(error instanceof CrmReservationsError);
    assert.equal(error.status, 409);
    assert.equal(error.message, "Стол занят");
    return true;
  });
});
