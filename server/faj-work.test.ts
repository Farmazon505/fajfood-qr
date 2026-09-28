import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { Store } from "./store";
import { installFajWorkRoutes, workCallAccess, workSnapshot } from "./faj-work";
import { MaxService } from "./max";
import { CrmWorkClient } from "./crm-work";
import type { MessagingService } from "./messaging";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qr-work-"));
  const store = new Store(directory);
  await store.init();
  await store.replaceChecklistItems([]);
  const one = { id: "one", name: "Первый", roleId: "waiter", telegramChatId: "", maxUserId: "101", tipUrl: "", active: true };
  const two = { ...one, id: "two", name: "Второй", maxUserId: "102" };
  const stranger = { ...one, id: "other", name: "Другой этаж", maxUserId: "103" };
  await store.replaceWaiters([one, two, stranger]);
  await store.replaceTables([
    { id: "table-one", slug: "printed-qr-stays", name: "Стол 1", zone: "Первый этаж", waiterId: null, waiterIds: [] },
    { id: "table-two", slug: "another-printed-qr", name: "Стол 2", zone: "Второй этаж", waiterId: null, waiterIds: [] },
  ]);
  await store.startWaiterShift(one.id, ["Первый этаж"]);
  await store.startWaiterShift(two.id, ["Первый этаж"]);
  await store.startWaiterShift(stranger.id, ["Второй этаж"]);
  const table = store.snapshot().tables[0];
  const call = await store.upsertCall({ table, action: store.snapshot().actions[0], guestName: "", comment: "", assignedWaiterId: one.id, routingStage: "waiter", routingReason: "" });
  return { directory, store, one, two, stranger, table, call };
}

test("FAJ Work bridge verifies service auth, zones, exclusive acceptance and completion ownership", async () => {
  const f = await fixture();
  const urlsBefore = f.store.snapshot().tables.map(({ id, slug }) => ({ id, slug }));
  const app = express(); app.use(express.json());
  installFajWorkRoutes(app, f.store, { syncCall: async () => {}, closeCallMessages: async () => {} } as unknown as MessagingService,
    (request) => request.headers["x-test-secret"] === "trusted");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/integrations/crm/work`;
  const post = (id: string, action: string) => fetch(url, { method: "POST", headers: { "x-test-secret": "trusted", "x-faj-work-max-user": id, "Content-Type": "application/json" }, body: JSON.stringify({ action, callId: f.call.id }) });
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal(workCallAccess(f.store, f.stranger, f.call).view, false);
    assert.equal((await post("103", "accept")).status, 403);
    const statuses = await Promise.all([post("101", "accept"), post("102", "accept")]);
    assert.deepEqual(statuses.map((response) => response.status).sort(), [200, 409]);
    const accepted = f.store.findCallById(f.call.id)!;
    assert.equal(accepted.workManaged, true);
    const winner = accepted.lastAcceptedByStaffId === f.one.id ? "101" : "102";
    const loser = winner === "101" ? "102" : "101";
    assert.equal((await post(loser, "complete")).status, 403);
    assert.equal((await post(winner, "complete")).status, 200);
    assert.equal((await post(winner, "complete")).status, 200);
    assert.equal(f.store.findCallById(f.call.id)?.status, "done");
    assert.equal(workSnapshot(f.store, f.one).calls.length, 0);
    assert.equal(f.store.snapshot().calls.length, 1);
    assert.deepEqual(f.store.snapshot().tables.map(({ id, slug }) => ({ id, slug })), urlsBefore);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("accepted MAX card deletion survives success:false and process restart without losing call history", async () => {
  const f = await fixture();
  try {
    await f.store.replaceMaxMessages(f.call.id, [{ userId: "101", messageId: "mid-1", recipientRole: "waiter", kind: "call" }]);
    await f.store.acceptCall(f.call.id, f.one.id, true);
    const service = new MaxService(f.store, "test");
    (service as unknown as { request: () => Promise<unknown> }).request = async () => ({ success: false });
    await service.notifyCall({ call: f.call, table: f.table, waiters: [f.one], settings: f.store.snapshot().settings });
    assert.equal(f.store.findCallById(f.call.id)?.maxMessages[0].deletePending, true);
    assert.equal(f.store.findCallById(f.call.id)?.status, "accepted");
    assert.equal(f.store.callsDueForAdminEscalation(Date.now() + 125_000).some((call) => call.id === f.call.id), true);
    const restarted = new Store(f.directory); await restarted.init();
    const retry = new MaxService(restarted, "test");
    const methods: string[] = [];
    (retry as unknown as { request: (method: string) => Promise<unknown> }).request = async (method) => { methods.push(method); return { success: true }; };
    await retry.retryPendingDeletes();
    await retry.notifyCall({ call: f.call, table: f.table, waiters: [f.one], settings: f.store.snapshot().settings });
    assert.deepEqual(methods, ["DELETE"]);
    assert.deepEqual(restarted.findCallById(f.call.id)?.maxMessages, []);
    assert.equal(restarted.findCallById(f.call.id)?.status, "accepted");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("non-call notifications persist during CRM outage and deduplicate after retry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qr-work-outbox-"));
  let failing = true; const delivered = new Set<string>();
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method === "GET") return Response.json({ linked: true });
    if (failing) throw new Error("temporary outage");
    delivered.add(JSON.parse(String(init?.body)).eventKey);
    return Response.json({ queued: true });
  };
  try {
    const client = new CrmWorkClient("https://crm.example.test", "s".repeat(32), directory, fetcher);
    assert.equal(await client.notify("101", "task-1", "Персональная задача"), true);
    assert.equal(JSON.parse(await readFile(path.join(directory, "faj-work-outbox.json"), "utf8")).length, 1);
    failing = false;
    await new CrmWorkClient("https://crm.example.test", "s".repeat(32), directory, fetcher).flush();
    await client.notify("101", "task-1", "Персональная задача");
    assert.equal(delivered.size, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "faj-work-outbox.json"), "utf8")), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
