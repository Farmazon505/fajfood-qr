import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import webpush from "web-push";
import { config, publicBaseUrl } from "./config";
import type { OwnerWebPushStatus } from "./types";

export type OwnerPushSubscription = webpush.PushSubscription & {
  createdAt: string;
  updatedAt: string;
  userAgent: string;
};

export type OwnerPushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  badgeCount?: number;
};

type Sender = (
  subscription: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions
) => Promise<webpush.SendResult>;

type WebPushOptions = {
  publicKey?: string;
  privateKey?: string;
  subject?: string;
  checklistOverdueMinutes?: number;
  sender?: Sender;
};

const timestamp = () => new Date().toISOString();

const normalizedSubscription = (value: Partial<OwnerPushSubscription>): OwnerPushSubscription | null => {
  const endpoint = String(value.endpoint || "").trim();
  const p256dh = String(value.keys?.p256dh || "").trim();
  const auth = String(value.keys?.auth || "").trim();
  if (!endpoint.startsWith("https://") || !p256dh || !auth) return null;
  const createdAt = String(value.createdAt || timestamp());
  return {
    endpoint,
    expirationTime: typeof value.expirationTime === "number" ? value.expirationTime : null,
    keys: { p256dh, auth },
    createdAt,
    updatedAt: String(value.updatedAt || createdAt),
    userAgent: String(value.userAgent || "").slice(0, 500)
  };
};

export class OwnerWebPushService {
  private subscriptions: OwnerPushSubscription[] = [];
  private writeQueue = Promise.resolve();
  private readonly dataFile: string;
  private readonly publicKey: string;
  private readonly privateKey: string;
  private readonly subject: string;
  private readonly checklistOverdueMinutes: number;
  private readonly sender: Sender;

  constructor(dataDir = config.APP_DATA_DIR, options: WebPushOptions = {}) {
    this.dataFile = path.join(path.resolve(dataDir), "owner-push-subscriptions.json");
    this.publicKey = String(options.publicKey ?? config.WEB_PUSH_VAPID_PUBLIC_KEY).trim();
    this.privateKey = String(options.privateKey ?? config.WEB_PUSH_VAPID_PRIVATE_KEY).trim();
    this.subject = String(
      options.subject ?? (config.WEB_PUSH_VAPID_SUBJECT || publicBaseUrl())
    ).trim();
    this.checklistOverdueMinutes = options.checklistOverdueMinutes ?? config.CHECKLIST_OVERDUE_MINUTES;
    this.sender = options.sender ?? webpush.sendNotification;
  }

  async init() {
    await mkdir(path.dirname(this.dataFile), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.dataFile, "utf8")) as { subscriptions?: Partial<OwnerPushSubscription>[] };
      this.subscriptions = (parsed.subscriptions ?? [])
        .map(normalizedSubscription)
        .filter((item): item is OwnerPushSubscription => Boolean(item));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  enabled() {
    return Boolean(this.publicKey && this.privateKey);
  }

  status(): OwnerWebPushStatus {
    return {
      enabled: this.enabled(),
      publicKey: this.enabled() ? this.publicKey : "",
      subscriptionCount: this.subscriptions.length,
      checklistOverdueMinutes: this.checklistOverdueMinutes
    };
  }

  listSubscriptions() {
    return structuredClone(this.subscriptions);
  }

  async subscribe(subscription: webpush.PushSubscription, userAgent = "") {
    if (!this.enabled()) throw new Error("Web Push is not configured");
    const next = normalizedSubscription({
      ...subscription,
      userAgent,
      createdAt: timestamp(),
      updatedAt: timestamp()
    });
    if (!next) throw new Error("Invalid Web Push subscription");
    const existing = this.subscriptions.find((item) => item.endpoint === next.endpoint);
    if (existing) {
      existing.expirationTime = next.expirationTime;
      existing.keys = next.keys;
      existing.updatedAt = timestamp();
      existing.userAgent = next.userAgent;
    } else {
      this.subscriptions.push(next);
      if (this.subscriptions.length > 20) {
        this.subscriptions.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
        this.subscriptions = this.subscriptions.slice(-20);
      }
    }
    await this.persist();
    return this.status();
  }

  async unsubscribe(endpoint: string) {
    const normalizedEndpoint = endpoint.trim();
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((item) => item.endpoint !== normalizedEndpoint);
    if (this.subscriptions.length !== before) await this.persist();
    return this.status();
  }

  async notify(payload: OwnerPushPayload) {
    if (!this.enabled() || !this.subscriptions.length) return { sent: 0, failed: 0, removed: 0 };
    const serialized = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url || "/admin",
      tag: payload.tag || "owner-alert",
      badgeCount: payload.badgeCount ?? 1,
      icon: "/faj-qr-icon-192.png",
      badge: "/faj-qr-icon-192.png"
    });
    const stale = new Set<string>();
    let sent = 0;
    let failed = 0;

    await Promise.all(this.subscriptions.map(async (subscription) => {
      try {
        await this.sender(subscription, serialized, {
          TTL: 5 * 60,
          urgency: "high",
          topic: String(payload.tag || "owner-alert").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32),
          vapidDetails: {
            subject: this.subject,
            publicKey: this.publicKey,
            privateKey: this.privateKey
          }
        });
        sent += 1;
      } catch (error) {
        failed += 1;
        const statusCode = Number((error as { statusCode?: number }).statusCode || 0);
        if (statusCode === 404 || statusCode === 410) stale.add(subscription.endpoint);
        else console.error("[web-push] delivery failed:", error);
      }
    }));

    if (stale.size) {
      this.subscriptions = this.subscriptions.filter((item) => !stale.has(item.endpoint));
      await this.persist();
    }
    return { sent, failed, removed: stale.size };
  }

  private async persist() {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      const tmp = `${this.dataFile}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify({ subscriptions: this.subscriptions }, null, 2), "utf8");
      try {
        await rename(tmp, this.dataFile);
      } catch {
        await copyFile(tmp, this.dataFile);
        await unlink(tmp).catch(() => undefined);
      }
    });
    await this.writeQueue;
  }
}
