import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OwnerWebPushService } from "./web-push";

const subscription = {
  endpoint: "https://push.example.test/subscription-1",
  expirationTime: null,
  keys: {
    p256dh: "test-public-encryption-key",
    auth: "test-auth-secret"
  }
};

test("owner Web Push subscriptions persist, deliver payloads and remove expired endpoints", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrnastol-web-push-"));
  try {
    const payloads: string[] = [];
    const service = new OwnerWebPushService(directory, {
      publicKey: "test-vapid-public-key",
      privateKey: "test-vapid-private-key",
      subject: "https://qr.crunchhaus.ru",
      sender: async (_target, payload) => {
        payloads.push(payload);
        return { statusCode: 201, body: "", headers: {} };
      }
    });
    await service.init();
    assert.equal(service.status().subscriptionCount, 0);

    await service.subscribe(subscription, "Test iPhone");
    assert.equal(service.status().subscriptionCount, 1);
    const delivered = await service.notify({ title: "Проверка", body: "Сообщение", tag: "test" });
    assert.deepEqual(delivered, { sent: 1, failed: 0, removed: 0 });
    assert.match(payloads[0], /Проверка/);

    const restored = new OwnerWebPushService(directory, {
      publicKey: "test-vapid-public-key",
      privateKey: "test-vapid-private-key",
      subject: "https://qr.crunchhaus.ru",
      sender: async () => {
        throw Object.assign(new Error("Expired"), { statusCode: 410 });
      }
    });
    await restored.init();
    assert.equal(restored.status().subscriptionCount, 1);
    const expired = await restored.notify({ title: "Проверка", body: "Сообщение" });
    assert.deepEqual(expired, { sent: 0, failed: 1, removed: 1 });
    assert.equal(restored.status().subscriptionCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
