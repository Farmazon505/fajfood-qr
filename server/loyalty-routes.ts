import { createHash, randomBytes } from "node:crypto";
import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { publicBaseUrl } from "./config";
import { crmLoyalty, type CrmLoyaltyService, type LoyaltyProfile } from "./crm-loyalty";
import { PERSONAL_DATA_CONSENT_HASH, PERSONAL_DATA_CONSENT_PATH, PERSONAL_DATA_CONSENT_VERSION } from "./legal";
import type { Store } from "./store";
import type { LoyaltyLead, LoyaltyVerificationAttempt } from "./types";

const schema = z.object({
  tableSlug: z.string().max(100).optional().default(""),
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().min(10).max(30),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")).default(""),
  personalDataConsent: z.literal(true),
  marketingConsent: z.boolean().default(false),
});
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const bearer = (request: Request) => (request.headers.authorization || "").replace(/^Bearer /, "").trim();
const normalizePhone = (value: string) => {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11 && /^[78]/.test(digits)) return `+7${digits.slice(1)}`;
  return digits.length === 10 ? `+7${digits}` : null;
};
const payload = (attempt: LoyaltyVerificationAttempt) => ({
  sourceRegistrationId: attempt.id, name: attempt.name, phone: attempt.phone, birthday: attempt.birthday || undefined,
  personalDataConsent: { accepted: true as const, acceptedAt: attempt.personalDataConsentAcceptedAt,
    documentVersion: attempt.personalDataConsentVersion, documentUrl: `${publicBaseUrl()}${PERSONAL_DATA_CONSENT_PATH}`,
    documentHash: attempt.personalDataConsentHash },
  marketingConsent: attempt.marketingConsent, ipAddress: attempt.consentIpAddress, userAgent: attempt.consentUserAgent,
});
const profilePatch = (profile: LoyaltyProfile) => ({
  crmUserId: profile.userId, name: profile.name, iikoCustomerId: profile.iikoCustomerId, cardNumber: profile.cardNumber,
  bonusBalance: profile.bonusBalance, balanceUpdatedAt: profile.balanceUpdatedAt,
  welcomeBonusAmount: profile.welcomeBonus.amount, welcomeBonusStatus: profile.welcomeBonus.status, syncError: "",
});
const cachedProfile = (lead: LoyaltyLead): LoyaltyProfile => ({
  userId: lead.crmUserId || "", name: lead.name, phoneMasked: `••• ${lead.phone.slice(-4)}`,
  iikoCustomerId: lead.iikoCustomerId, cardNumber: lead.cardNumber, bonusBalance: lead.bonusBalance,
  balanceUpdatedAt: lead.balanceUpdatedAt, alreadyRegistered: true, balanceIsFresh: false,
  welcomeBonus: { amount: lead.welcomeBonusAmount, status: lead.welcomeBonusStatus, granted: lead.welcomeBonusStatus === "GRANTED" },
});

export function createLoyaltyRouter(options: {
  store: Store;
  limiter: RequestHandler;
  crm?: Pick<CrmLoyaltyService, "startVerification" | "getVerification" | "register" | "getProfile">;
  visitTokens?: (request: Request) => string[];
  onRegistered?: () => void;
}) {
  const { store } = options;
  const crm = options.crm || crmLoyalty;
  const router = Router();
  router.use((_request, response, next) => { response.setHeader("Cache-Control", "no-store"); next(); });

  router.post("/", options.limiter, async (request, response) => {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: "Проверьте имя, телефон и согласие на обработку данных" }); return; }
    const phone = normalizePhone(parsed.data.phone);
    if (!phone) { response.status(400).json({ error: "Введите российский номер телефона из 10 или 11 цифр" }); return; }
    const table = parsed.data.tableSlug ? store.findTableBySlug(parsed.data.tableSlug) : null;
    if (parsed.data.tableSlug && !table) { response.status(400).json({ error: "Стол не найден. Откройте QR-код на столе ещё раз." }); return; }
    const accessToken = randomBytes(32).toString("base64url");
    const { leadId, attempt } = await store.beginLoyaltyVerification({
      name: parsed.data.name, phone, birthday: parsed.data.birthday, tableId: table?.id || null,
      marketingVisitTokens: options.visitTokens?.(request) || [], marketingSyncPending: false, marketingSyncError: "",
      personalDataConsent: true, personalDataConsentVersion: PERSONAL_DATA_CONSENT_VERSION,
      personalDataConsentHash: PERSONAL_DATA_CONSENT_HASH, personalDataConsentAcceptedAt: new Date().toISOString(),
      marketingConsent: parsed.data.marketingConsent, consentIpAddress: request.ip || "",
      consentUserAgent: String(request.headers["user-agent"] || "").slice(0, 1000),
      accessTokenHash: hash(accessToken), verificationId: null, verificationExpiresAt: null,
      phoneVerificationChannel: null, phoneVerifiedAt: null, crmUserId: null, iikoCustomerId: null,
      cardNumber: null, bonusBalance: 0, balanceUpdatedAt: null, welcomeBonusAmount: 500, welcomeBonusStatus: "PENDING", syncError: "",
    });
    try {
      const verification = await crm.startVerification(payload(attempt));
      await store.updateLoyaltyVerification(leadId, attempt.id, { verificationId: verification.verificationId, verificationExpiresAt: verification.expiresAt });
      response.status(202).json({ ok: true, verification: { id: verification.verificationId, accessToken,
        expiresAt: verification.expiresAt, channels: verification.channels } });
    } catch {
      response.status(502).json({ error: "Не удалось начать подтверждение номера. Повторите попытку позже." });
    }
  });

  router.get("/verification/:verificationId", async (request, response) => {
    const verificationId = String(request.params.verificationId);
    const accessToken = bearer(request);
    const found = store.findLoyaltyVerification(verificationId);
    if (!accessToken || !found || found.attempt.accessTokenHash !== hash(accessToken)) {
      response.status(401).json({ error: "Проверка номера не найдена" }); return;
    }
    const { leadId, attempt } = found;
    try {
      // A lost HTTP response can be retried without re-registering or issuing bonuses.
      if (attempt.completedAt && attempt.crmUserId && attempt.phoneVerifiedAt) {
        const profile = await crm.getProfile(attempt.crmUserId);
        response.json({ ok: true, accessToken, profile: { ...profile, alreadyRegistered: attempt.alreadyRegistered }, stale: profile.balanceIsFresh === false });
        return;
      }
      const verification = await crm.getVerification(verificationId);
      if (["PENDING", "CONTACT_REQUESTED", "CONSUMING"].includes(verification.status)) {
        response.status(202).json({ ok: true, verification }); return;
      }
      if (["EXPIRED", "SUPERSEDED"].includes(verification.status)) {
        response.status(410).json({ error: "Время подтверждения истекло. Введите номер ещё раз." }); return;
      }
      if (!["VERIFIED", "CONSUMED"].includes(verification.status) || !verification.verifiedAt) {
        response.status(409).json({ error: "Номер ещё не подтверждён" }); return;
      }
      const table = attempt.tableId ? store.findTableById(attempt.tableId) : null;
      const profile = await crm.register({ ...payload(attempt), verificationId, tableSlug: table?.slug });
      if (!profile.cardNumber || ["SYNCHRONIZING", "PROCESSING"].includes(profile.welcomeBonus.status)) {
        response.status(202).json({ ok: true, verification }); return;
      }
      const alreadyRegistered = profile.alreadyRegistered === true || profile.welcomeBonus.status === "SKIPPED_EXISTING_MEMBER";
      await store.completeLoyaltyVerification(leadId, attempt, { ...profilePatch(profile),
        phoneVerificationChannel: verification.channel, phoneVerifiedAt: verification.verifiedAt }, alreadyRegistered);
      response.status(201).json({ ok: true, accessToken, profile: { ...profile, alreadyRegistered }, stale: profile.balanceIsFresh === false });
      options.onRegistered?.();
    } catch {
      response.status(502).json({ error: "Не удалось открыть карту. Проверим ещё раз через несколько секунд." });
    }
  });

  router.get("/profile", async (request, response) => {
    const token = bearer(request);
    const lead = token ? store.findLoyaltyLeadByTokenHash(hash(token)) : null;
    if (!lead || !lead.phoneVerifiedAt || !lead.crmUserId) {
      response.status(401).json({ error: "Карта гостя не найдена на этом устройстве. Подтвердите свой номер." }); return;
    }
    try {
      const profile = await crm.getProfile(lead.crmUserId);
      await store.updateLoyaltyLead(lead.id, profilePatch(profile));
      response.json({ ok: true, profile: { ...profile, alreadyRegistered: true }, stale: profile.balanceIsFresh === false });
    } catch {
      response.json({ ok: true, profile: cachedProfile(lead), stale: true });
    }
  });
  return router;
}
