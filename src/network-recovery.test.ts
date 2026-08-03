import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  claimClientRecovery,
  fetchWithNetworkRecovery,
  isSafeReadMethod,
  resetClientRecovery,
} from "./network-recovery";

test("retries temporary safe reads with bounded delays", async () => {
  const waits: number[] = [];
  const statuses = [503, 502, 200];
  let requests = 0;

  const response = await fetchWithNetworkRecovery("/api/public/bootstrap", {}, {
    fetcher: async () => {
      requests += 1;
      return new Response("{}", { status: statuses.shift() });
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });

  assert.equal(response.status, 200);
  assert.equal(requests, 3);
  assert.deepEqual(waits, [300, 900]);
  assert.equal(isSafeReadMethod(), true);
  assert.equal(isSafeReadMethod("HEAD"), true);
});

test("never automatically retries a write request", async () => {
  let requests = 0;
  await assert.rejects(
    fetchWithNetworkRecovery("/api/public/calls", { method: "POST" }, {
      fetcher: async () => {
        requests += 1;
        throw new TypeError("connection reset");
      },
      wait: async () => undefined,
    }),
    /connection reset/,
  );
  assert.equal(requests, 1);
  assert.equal(isSafeReadMethod("PATCH"), false);
});

test("does not retry an aborted request", async () => {
  const aborted = new Error("aborted");
  aborted.name = "AbortError";
  let requests = 0;

  await assert.rejects(
    fetchWithNetworkRecovery("/api/admin/overview", {}, {
      fetcher: async () => {
        requests += 1;
        throw aborted;
      },
      wait: async () => undefined,
    }),
    /aborted/,
  );
  assert.equal(requests, 1);
});

test("allows one automatic reload per recovery window", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };

  assert.equal(claimClientRecovery(storage, 1_000, 60_000), true);
  assert.equal(claimClientRecovery(storage, 2_000, 60_000), false);
  assert.equal(claimClientRecovery(storage, 62_000, 60_000), true);
  resetClientRecovery(storage);
  assert.equal(claimClientRecovery(storage, 63_000, 60_000), true);
});

test("Qrnastol root and data screens install recovery hooks", () => {
  const main = readFileSync(join(process.cwd(), "src", "main.tsx"), "utf8");
  const app = readFileSync(join(process.cwd(), "src", "App.tsx"), "utf8");
  const staff = readFileSync(join(process.cwd(), "src", "StaffReservations.tsx"), "utf8");
  const boundary = readFileSync(join(process.cwd(), "src", "ClientRecoveryBoundary.tsx"), "utf8");

  assert.match(main, /ClientRecoveryBoundary/);
  assert.match(app, /fetchWithNetworkRecovery/);
  assert.match(app, /window\.addEventListener\("online", loadGuest\)/);
  assert.match(app, /window\.addEventListener\("online", recoverAdmin\)/);
  assert.match(staff, /window\.addEventListener\("online", recover\)/);
  assert.match(boundary, /claimClientRecovery/);
  assert.match(boundary, /window\.location\.reload\(\)/);
});
