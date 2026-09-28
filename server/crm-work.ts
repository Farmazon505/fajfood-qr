import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

type WorkNotice = { maxUserId: string; eventKey: string; text: string; view: "shift" | "checklists"; createdAt: string };

export class CrmWorkClient {
  private links = new Map<string, { linked: boolean; expires: number }>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private baseUrl = config.CRM_BASE_URL, private secret = config.CRM_STAFF_SERVICE_SECRET,
    private directory = config.APP_DATA_DIR, private fetcher: typeof fetch = fetch) {}
  private configured() { return Boolean(this.baseUrl && this.secret.length >= 32); }
  private request(maxUserId: string, notice?: WorkNotice) {
    return this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/api/integrations/qrnastol/work`, {
      method: notice ? "POST" : "GET", signal: AbortSignal.timeout(5_000),
      headers: { "x-qrnastol-staff-secret": this.secret, "x-faj-work-max-user": maxUserId, "Content-Type": "application/json" },
      ...(notice ? { body: JSON.stringify(notice) } : {}),
    });
  }
  async linked(maxUserId: string) {
    if (!this.configured() || !maxUserId) return false;
    const cached = this.links.get(maxUserId);
    if (cached && cached.expires > Date.now()) return cached.linked;
    const response = await this.request(maxUserId);
    if (!response.ok) throw new Error(`FAJ Work connection: ${response.status}`);
    const result = await response.json() as { linked?: boolean };
    const linked = result.linked === true;
    this.links.set(maxUserId, { linked, expires: Date.now() + 30_000 });
    return linked;
  }
  private async readQueue(): Promise<WorkNotice[]> {
    try { return JSON.parse(await readFile(path.join(this.directory, "faj-work-outbox.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  private async writeQueue(notices: WorkNotice[]) {
    await mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, "faj-work-outbox.json");
    await writeFile(`${file}.tmp`, JSON.stringify(notices), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const current = this.queue.catch(() => undefined).then(action);
    this.queue = current;
    return current;
  }
  async notify(maxUserId: string, eventKey: string, text: string, view: WorkNotice["view"] = "checklists") {
    if (!this.configured()) return false;
    // A confirmed unlinked employee keeps the existing bot until onboarding.
    // An outage must not move already separated notifications back into calls.
    const linked = await this.linked(maxUserId).catch(() => null);
    if (linked === false) return false;
    const key = createHash("sha256").update(`${maxUserId}:${eventKey}`).digest("hex");
    await this.serial(async () => {
      const notices = await this.readQueue();
      if (!notices.some((notice) => notice.eventKey === key)) {
        notices.push({ maxUserId, eventKey: key, text: text.slice(0, 3800), view, createdAt: new Date().toISOString() });
        await this.writeQueue(notices);
      }
    });
    await this.flush();
    return true;
  }
  async flush() {
    if (!this.configured()) return;
    await this.serial(async () => {
      const notices = await this.readQueue();
      let changed = false;
      const retained: WorkNotice[] = [];
      for (const [index, notice] of notices.entries()) {
        if (index >= 10) { retained.push(notice); continue; }
        try {
          const response = await this.request(notice.maxUserId, notice);
          if (response.ok && (await response.json() as { queued?: boolean }).queued) changed = true;
          else retained.push(notice);
        } catch { retained.push(notice); }
      }
      if (changed) await this.writeQueue(retained);
    });
  }
}

export const crmWork = new CrmWorkClient();
