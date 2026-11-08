import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { workCallAccess } from "./faj-work";
import type { Store } from "./store";
import type { ServiceCall } from "./types";

type Notice = {
  eventKey: string;
  callId: string;
  cycleStartedAt: string;
  stage: ServiceCall["routingStage"];
  stageStartedAt: string;
  maxUserId: string;
  tableName: string;
  zone: string;
  reason: string;
};
type Options = { enabled?: boolean; baseUrl?: string; secret?: string; directory?: string; fetcher?: typeof fetch; now?: () => number };

export class FajWorkCallPushQueue {
  private readonly enabled: boolean;
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly directory: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private flushing = false;
  private sent = new Set<string>();

  constructor(private readonly store: Store, options: Options = {}) {
    this.enabled = options.enabled ?? config.FAJ_WORK_CALL_PUSH_ENABLED === "true";
    this.baseUrl = (options.baseUrl ?? config.CRM_BASE_URL).replace(/\/$/, "");
    this.secret = options.secret ?? config.CRM_STAFF_SERVICE_SECRET;
    this.directory = options.directory ?? config.APP_DATA_DIR;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private configured() { return this.enabled && Boolean(this.baseUrl) && this.secret.length >= 32; }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(action);
    this.queue = next;
    return next;
  }
  private async read(): Promise<Notice[]> {
    try { return JSON.parse(await readFile(path.join(this.directory, "faj-work-call-push-outbox.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  private async write(notices: Notice[]) {
    await mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, "faj-work-call-push-outbox.json");
    await writeFile(`${file}.tmp`, JSON.stringify(notices), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }

  private noticesFor(input: ServiceCall): Notice[] {
    const call = this.store.findCallById(input.id);
    if (!call || !["new", "accepted"].includes(call.status) || (call.routingStage === "waiter" && call.status !== "new")) return [];
    const table = this.store.findTableById(call.tableId);
    if (!table) return [];
    const stageStartedAt = call.routingStage === "admin" ? call.adminEscalationStartedAt : call.routingStage === "owner" ? call.ownerEscalatedAt : call.cycleStartedAt;
    if (!stageStartedAt || !Number.isFinite(Date.parse(stageStartedAt)) || this.now() - Date.parse(stageStartedAt) >= 55_000) return [];
    return this.store.callNotificationRecipients(call, table).flatMap(({ member, recipientRole }) => {
      const maxUserId = member.maxUserId.trim();
      if (!/^\d{1,30}$/.test(maxUserId) || !workCallAccess(this.store, member, call).view) return [];
      const eventKey = createHash("sha256").update([call.id, call.cycleStartedAt, call.routingStage, stageStartedAt, recipientRole, member.id, maxUserId].join(":")).digest("hex");
      return [{ eventKey, callId: call.id, cycleStartedAt: call.cycleStartedAt, stage: call.routingStage, stageStartedAt,
        maxUserId, tableName: table.name.slice(0, 100), zone: table.zone.slice(0, 100), reason: call.actionLabel.slice(0, 200) }];
    });
  }

  async enqueue(call: ServiceCall) {
    if (!this.configured()) return;
    const candidates = this.noticesFor(call).filter(notice => !this.sent.has(notice.eventKey));
    if (!candidates.length) return;
    await this.serial(async () => {
      const notices = await this.read();
      const keys = new Set(notices.map(notice => notice.eventKey));
      const additions = candidates.filter(notice => !keys.has(notice.eventKey));
      if (additions.length) await this.write([...notices, ...additions]);
    });
  }

  private valid(notice: Notice) {
    if (this.now() - Date.parse(notice.stageStartedAt) >= 55_000) return false;
    const call = this.store.findCallById(notice.callId);
    return Boolean(call && this.noticesFor(call).some(current => current.eventKey === notice.eventKey));
  }

  private async remove(eventKey: string) {
    await this.serial(async () => {
      const notices = await this.read();
      const remaining = notices.filter(notice => notice.eventKey !== eventKey);
      if (remaining.length !== notices.length) await this.write(remaining);
    });
  }

  async flush() {
    if (!this.configured() || this.flushing) return;
    this.flushing = true;
    try {
      const notices = await this.serial(() => this.read());
      for (const notice of notices.slice(0, 25)) {
        if (!this.valid(notice)) { await this.remove(notice.eventKey); continue; }
        try {
          const { maxUserId, cycleStartedAt: _cycle, ...payload } = notice;
          const response = await this.fetcher(`${this.baseUrl}/api/integrations/qrnastol/call-push`, {
            method: "POST", signal: AbortSignal.timeout(5_000),
            headers: { "Content-Type": "application/json", "x-qrnastol-staff-secret": this.secret, "x-faj-work-max-user": maxUserId },
            body: JSON.stringify(payload),
          });
          const result = await response.json().catch(() => ({})) as { delivered?: boolean; expired?: boolean };
          if (response.ok && (result.delivered || result.expired)) {
            this.sent.add(notice.eventKey);
            if (this.sent.size > 500) this.sent.clear();
            await this.remove(notice.eventKey);
          }
        } catch { /* Keep the notice until the next retry or until it becomes stale. */ }
      }
    } finally { this.flushing = false; }
  }

  async reconcile() {
    if (!this.configured()) return;
    for (const call of this.store.snapshot().calls) await this.enqueue(call);
    await this.flush();
  }
}
