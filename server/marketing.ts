import type { Express, Request, Response, RequestHandler } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { config, isProduction } from "./config";
import { crmLoyalty } from "./crm-loyalty";
import type { Store } from "./store";

export const marketingEnabled = () => config.MARKETING_ATTRIBUTION_ENABLED === "true";
const cookieName = "faj_marketing_visits";
const acquisitionCookieName = "faj_first_acquisition";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export function marketingTokens(request: Pick<Request, "headers">): string[] {
  try {
    const cookie = (request.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`));
    const values: unknown = JSON.parse(decodeURIComponent(cookie?.slice(cookieName.length + 1) || "[]"));
    const recent = Array.isArray(values) ? [...new Set(values.filter((v): v is string => typeof v === "string" && tokenPattern.test(v)))].slice(-5) : [];
    const first = (request.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith(`${acquisitionCookieName}=`))?.slice(acquisitionCookieName.length + 1);
    return first && tokenPattern.test(first) ? [first, ...recent.filter(t => t !== first)] : recent;
  } catch { return []; }
}
function saveTokens(response: Response, tokens: string[]) {
  response.cookie(cookieName, JSON.stringify([...new Set(tokens)].slice(-5)), {
    httpOnly: true, secure: isProduction, sameSite: "lax", path: "/", maxAge: 30 * 86_400_000,
  });
}
const startSchema = z.object({ tableSlug: z.string().max(80), token: z.string().regex(tokenPattern).optional(), requestId: z.string().uuid() }).strict();
const eventSchema = z.object({ event: z.enum(["popup_shown", "popup_closed", "popup_clicked", "form_started"]), token: z.string().regex(tokenPattern) }).strict();
const automated = (request: Request) => /bot|crawler|spider|preview|facebookexternalhit|headless|slack|telegrambot|whatsapp/i.test(request.get("user-agent") || "");

export function installMarketingRoutes(app: Express, store: Store, limiter: RequestHandler) {
  // Analytics has its own limiter; it must not consume the allowance for calling a waiter.
  app.post("/api/public/marketing/start", limiter, async (request, response) => {
    if (!marketingEnabled()) { response.status(204).end(); return; }
    const input = startSchema.safeParse(request.body);
    if (!input.success || (input.data.tableSlug && !store.findTableBySlug(input.data.tableSlug))) { response.status(400).json({ error: "Некорректный стол" }); return; }
    try {
      let token = input.data.token;
      let tokens = marketingTokens(request);
      if (token) {
        const result = await crmLoyalty.marketing<{ recorded: boolean; purpose: string | null }>({ action: "event", token, event: "landing" });
        if (result.recorded && result.purpose === "ACQUISITION" && !(request.headers.cookie || "").includes(`${acquisitionCookieName}=`)) {
          response.cookie(acquisitionCookieName, token, { httpOnly: true, secure: isProduction, sameSite: "lax", path: "/", maxAge: 30 * 86_400_000 });
        }
        if (!result.recorded) token = undefined;
      }
      if (!token) {
        const visit = await crmLoyalty.marketing<{ token: string }>({ action: "visit", tableSlug: input.data.tableSlug || "join", automated: automated(request), requestId: input.data.requestId });
        token = visit.token;
        await crmLoyalty.marketing({ action: "event", token, event: "landing" });
      }
      tokens = [...tokens, token];
      saveTokens(response, tokens);
      const bearer = (request.get("authorization") || "").replace(/^Bearer /, "");
      const lead = bearer ? store.findLoyaltyLeadByTokenHash(createHash("sha256").update(bearer).digest("hex")) : null;
      if (lead?.crmUserId && lead.phoneVerifiedAt) {
        await crmLoyalty.marketing({ action: "identify", token, userId: lead.crmUserId });
      }
      response.json({ ok: true, token });
    } catch {
      response.status(503).json({ error: "Учёт временно недоступен" });
    }
  });
  app.post("/api/public/marketing/event", limiter, async (request, response) => {
    if (!marketingEnabled()) { response.status(204).end(); return; }
    const input = eventSchema.safeParse(request.body);
    if (!input.success) { response.status(400).json({ error: "Некорректное событие" }); return; }
    const token = input.data.token;
    if (!marketingTokens(request).includes(token)) { response.status(204).end(); return; }
    try {
      await crmLoyalty.marketing({ action: "event", token, event: input.data.event });
      response.status(204).end();
    } catch { response.status(503).json({ error: "Учёт временно недоступен" }); }
  });
}

let syncing = false;
export async function retryMarketingRegistrations(store: Store) {
  if (!marketingEnabled() || syncing) return;
  syncing = true;
  try {
    const leads = store.snapshot().loyaltyLeads.filter(l => l.marketingSyncPending && l.crmUserId && l.phoneVerifiedAt && l.verificationId).slice(0, 20);
    for (const lead of leads) {
      try {
        let retry = false, ignored = false;
        for (const token of lead.marketingVisitTokens || []) {
          const result = await crmLoyalty.marketing<{ recorded: boolean; retryable: boolean }>({
            action: "registration", token, sourceRegistrationId: lead.id, verificationId: lead.verificationId,
          });
          retry ||= result.retryable;
          ignored ||= !result.recorded && !result.retryable;
        }
        await store.updateLoyaltyLead(lead.id, { marketingSyncPending: retry,
          marketingSyncError: retry ? "Ожидается подтверждение CRM" : ignored ? "Часть источников не привязана: переход истёк или принадлежит другому профилю" : "" });
      } catch {
        await store.updateLoyaltyLead(lead.id, { marketingSyncError: "CRM временно недоступна; повторная отправка запланирована" });
      }
    }
  } catch { console.error("[MARKETING] Registration queue is temporarily unavailable"); }
  finally { syncing = false; }
}
