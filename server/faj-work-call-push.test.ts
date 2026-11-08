import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "./store";
import { FajWorkCallPushQueue } from "./faj-work-call-push";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "faj-call-push-"));
  const store = new Store(path.join(directory, "store"));
  await store.init();
  await store.replaceChecklistItems([]);
  await store.replaceWaiters([
    { id: "one", name: "Первый", roleId: "waiter", telegramChatId: "", maxUserId: "101", tipUrl: "", active: true },
    { id: "two", name: "Второй", roleId: "waiter", telegramChatId: "", maxUserId: "102", tipUrl: "", active: true },
    { id: "other", name: "Другой этаж", roleId: "waiter", telegramChatId: "", maxUserId: "103", tipUrl: "", active: true },
  ]);
  await store.replaceTables([
    { id: "one", slug: "one", name: "Стол 1", zone: "Первый этаж", waiterId: null, waiterIds: [] },
    { id: "two", slug: "two", name: "Стол 2", zone: "Второй этаж", waiterId: null, waiterIds: [] },
  ]);
  await store.startWaiterShift("one", ["Первый этаж"]);
  await store.startWaiterShift("two", ["Первый этаж"]);
  await store.startWaiterShift("other", ["Второй этаж"]);
  const table = store.snapshot().tables[0];
  const call = await store.upsertCall({ table, action: store.snapshot().actions[0], guestName: "Гость", comment: "Личное сообщение", assignedWaiterId: "one", routingStage: "waiter", routingReason: "" });
  return { directory, store, call };
}

async function cleanup(directory: string) {
  assert.equal(path.dirname(directory), os.tmpdir());
  assert.ok(path.basename(directory).startsWith("faj-call-push-"));
  await rm(directory, { recursive: true, force: true });
}

test("call push survives CRM outage, targets the assigned zone and omits guest details", async () => {
  const f = await fixture();
  const output = path.join(f.directory, "push");
  let failing = true;
  const deliveries: Array<{ user: string; body: Record<string, string> }> = [];
  const fetcher: typeof fetch = async (_url, init) => {
    if (failing) throw new Error("offline");
    deliveries.push({ user: new Headers(init?.headers).get("x-faj-work-max-user") || "", body: JSON.parse(String(init?.body)) });
    return Response.json({ delivered: true });
  };
  const options = { enabled: true, baseUrl: "https://crm.example.test", secret: "s".repeat(32), directory: output, fetcher };
  try {
    await new FajWorkCallPushQueue(f.store, options).reconcile();
    const queued = JSON.parse(await readFile(path.join(output, "faj-work-call-push-outbox.json"), "utf8"));
    assert.deepEqual(queued.map((item: { maxUserId: string }) => item.maxUserId).sort(), ["101", "102"]);
    failing = false;
    const restored = new FajWorkCallPushQueue(f.store, options);
    await restored.reconcile();
    await restored.reconcile();
    assert.deepEqual(deliveries.map(item => item.user).sort(), ["101", "102"]);
    assert.ok(deliveries.every(item => item.body.tableName === "Стол 1" && !JSON.stringify(item.body).includes("Личное сообщение") && !JSON.stringify(item.body).includes("Гость")));
    assert.deepEqual(JSON.parse(await readFile(path.join(output, "faj-work-call-push-outbox.json"), "utf8")), []);
  } finally { await cleanup(f.directory); }
});

test("acceptance or expiry cancels queued call alerts before recovery", async () => {
  const f = await fixture();
  const output = path.join(f.directory, "push");
  let requests = 0;
  let now = Date.now();
  const options = { enabled: true, baseUrl: "https://crm.example.test", secret: "s".repeat(32), directory: output, now: () => now,
    fetcher: (async () => { requests++; throw new Error("offline"); }) as typeof fetch };
  try {
    const queue = new FajWorkCallPushQueue(f.store, options);
    await queue.enqueue(f.call);
    await f.store.acceptCall(f.call.id, "one");
    await queue.flush();
    assert.equal(requests, 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(output, "faj-work-call-push-outbox.json"), "utf8")), []);
    const next = await f.store.upsertCall({ table: f.store.snapshot().tables[0], action: f.store.snapshot().actions[0], guestName: "", comment: "", assignedWaiterId: "one", routingStage: "waiter", routingReason: "" });
    await queue.enqueue(next);
    now += 56_000;
    await queue.flush();
    assert.equal(requests, 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(output, "faj-work-call-push-outbox.json"), "utf8")), []);
  } finally { await cleanup(f.directory); }
});

test("a queued alert is not sent to a waiter removed from the table", async () => {
  const f = await fixture();
  const recipients: string[] = [];
  const options = { enabled: true, baseUrl: "https://crm.example.test", secret: "s".repeat(32), directory: path.join(f.directory, "push"),
    fetcher: (async (_url, init) => { recipients.push(new Headers(init?.headers).get("x-faj-work-max-user") || ""); return Response.json({ delivered: true }); }) as typeof fetch };
  try {
    const queue = new FajWorkCallPushQueue(f.store, options);
    await queue.enqueue(f.call);
    const tables = f.store.snapshot().tables.map(table => table.id === "one" ? { ...table, waiterId: "two", waiterIds: ["two"] } : table);
    await f.store.replaceTables(tables);
    await queue.flush();
    assert.deepEqual(recipients, ["102"]);
  } finally { await cleanup(f.directory); }
});
