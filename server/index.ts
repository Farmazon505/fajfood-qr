import "dotenv/config";
import compression from "compression";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  assertProductionSecrets,
  authenticateAdmin,
  createAdminToken,
  getAdminAccountSummary,
  getAdminAuth,
  initializeAdminCredentials,
  requireAdmin,
  requireOwner,
  updateAdminAccount
} from "./auth";
import { config, publicBaseUrl } from "./config";
import { Store, venueOperationalDateKey } from "./store";
import { TelegramService } from "./telegram";
import { MaxService } from "./max";
import { MessagingService } from "./messaging";
import { OwnerWebPushService } from "./web-push";
import { generatePerformanceInsights, isPerformanceAiConfigured } from "./performance-ai";
import type { CallStatus } from "./types";
import { crmLoyalty } from "./crm-loyalty";
import {
  CrmReservationsClient,
  CrmReservationsError,
} from "./crm-reservations";
import { validateTelegramInitData } from "./staff-auth";
import { filterSnapshotForZones } from "./staff-reservation-access";
import { ReservationMonitor } from "./reservation-monitor";
import {
  MARKETING_CONSENT_PATH,
  MARKETING_CONSENT_TEXT,
  PERSONAL_DATA_CONSENT_HASH,
  PERSONAL_DATA_CONSENT_PATH,
  PERSONAL_DATA_CONSENT_TEXT,
  PERSONAL_DATA_CONSENT_VERSION,
  PRIVACY_POLICY_URL,
  renderLegalDocument,
} from "./legal";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.resolve(config.APP_DATA_DIR, "uploads");
const reviewMediaDir = path.resolve(config.APP_DATA_DIR, "review-media");
assertProductionSecrets();
await initializeAdminCredentials();
const store = new Store();
await store.init();
const ownerWebPush = new OwnerWebPushService();
await ownerWebPush.init();
const telegram = new TelegramService(store);
const crmReservations = new CrmReservationsClient();
const max = new MaxService(store);
const messaging = new MessagingService(store, telegram, max, ownerWebPush);
const reservationMonitor = new ReservationMonitor(store, telegram, crmReservations);

async function refreshOffersFromCrm() {
  if (!crmLoyalty.configured()) return;
  try {
    const offers = await crmLoyalty.getOffers();
    await store.replaceOffers(offers);
  } catch (error) {
    console.error("[CRM] Не удалось обновить акции, сохранена локальная копия", error);
  }
}

const app = express();
app.disable("x-powered-by");
if (config.TRUST_PROXY === "true") app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
app.use(compression());
app.use((req, res, next) => {
  console.log("API REQUEST:", req.method, req.path);
  next();
});
app.use(
  "/uploads",
  express.static(uploadsDir, {
    maxAge: "1h"
  })
);
app.use(express.json({ limit: "1mb" }));

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

const loyaltyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false
});

const performanceAiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false
});

const staffReservationsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false
});

const dateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const reservationUpdateSchema = z.object({
  id: z.string().min(1).max(120),
  date: dateKeySchema,
  status: z.enum(["PENDING", "CONFIRMED", "SEATED", "COMPLETED", "CANCELLED", "NO_SHOW", "WAITLIST"]).optional(),
  tableId: z.string().min(1).max(120).optional(),
  notes: z.string().max(4000).optional(),
  reason: z.string().max(500).optional()
});

const staffAccess = (request: express.Request) => {
  const identity = validateTelegramInitData(
    String(request.headers["x-telegram-init-data"] || ""),
    config.TELEGRAM_BOT_TOKEN
  );
  if (!identity) return null;
  const waiter = store.findWaiterByChatId(identity.id);
  if (!waiter?.active) return null;
  const shift = store.currentShiftForWaiter(waiter.id);
  const role = store.roleForWaiter(waiter);
  if (!shift || !role?.active) return null;
  return { identity, waiter, shift, role };
};

const publicCallSchema = z.object({
  tableSlug: z.string().min(1),
  actionId: z.string().min(1),
  comment: z.string().max(240).optional().default(""),
  guestName: z.string().max(80).optional().default("")
});

const loyaltySchema = z.object({
  tableSlug: z.string().optional().default(""),
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().min(10).max(30),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")).default(""),
  personalDataConsent: z.literal(true),
  marketingConsent: z.boolean().default(false)
});

const normalizePhone = (value: string) => {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith("7")) return `+${digits}`;
  if (digits.length === 10) return `+7${digits}`;
  return null;
};

const tokenHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

const loyaltyRegistrationAllowed = (phone: string) => {
  const allowedPhones = config.LOYALTY_REGISTRATION_ALLOWLIST
    .split(",")
    .map((item) => normalizePhone(item.trim()))
    .filter((item): item is string => Boolean(item));
  return allowedPhones.length === 0 || allowedPhones.includes(phone);
};

const bearerToken = (request: express.Request) => {
  const header = request.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
};

const cachedLoyaltyProfile = (lead: ReturnType<Store["findLoyaltyLeadByTokenHash"]>) =>
  lead
    ? {
        userId: lead.crmUserId || "",
        name: lead.name,
        phoneMasked: `${lead.phone.slice(0, 2)} *** ***-${lead.phone.slice(-4, -2)}-${lead.phone.slice(-2)}`,
        iikoCustomerId: lead.iikoCustomerId,
        cardNumber: lead.cardNumber,
        bonusBalance: lead.bonusBalance,
        balanceUpdatedAt: lead.balanceUpdatedAt,
        welcomeBonus: {
          amount: lead.welcomeBonusAmount,
          status: lead.welcomeBonusStatus,
          granted: lead.welcomeBonusStatus === "GRANTED",
        },
      }
    : null;

const feedbackSchema = z.object({
  tableSlug: z.string().optional().default(""),
  rating: z.number().min(1).max(5),
  reasons: z.array(z.string()).optional().default([]),
  liked: z.string().max(2000).optional().default(""),
  disliked: z.string().max(2000).optional().default(""),
  guestName: z.string().max(80).optional().default(""),
  phone: z.string().max(40).optional().default("")
});

const shiftReviewSchema = z.object({
  reviews: z.array(
    z.object({
      itemId: z.string().min(1),
      score: z.number().min(1).max(5).nullable(),
      comment: z.string().max(500).optional().default(""),
      photoUrl: z.string().trim().max(240).regex(/^$|^\/api\/admin\/review-media\/[A-Za-z0-9._-]+$/).optional()
    })
  )
});

const logoContentTypes: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

const logoUploadParser = express.raw({
  type: Object.keys(logoContentTypes),
  limit: "10mb"
});

const reviewImageUploadParser = express.raw({
  type: Object.keys(logoContentTypes),
  limit: "8mb"
});

const validImageSignature = (contentType: string, body: Buffer) => {
  if (contentType === "image/png") {
    return body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (contentType === "image/jpeg") {
    return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  }
  if (contentType === "image/webp") {
    return body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
};

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/ready", (_request, response) => {
  const snapshot = store.snapshot();
  response.json({
    ok: true,
    tables: snapshot.tables.length,
    telegramEnabled: telegram.enabled(),
    maxEnabled: max.enabled(),
    publicBaseUrl: publicBaseUrl()
  });
});

app.get("/api/staff/reservations", staffReservationsLimiter, async (request, response) => {
  const access = staffAccess(request);
  if (!access) {
    response.status(403).json({ error: "Откройте приложение из бота и сначала выйдите на смену" });
    return;
  }
  const parsedDate = dateKeySchema.safeParse(String(request.query.date || ""));
  if (!parsedDate.success) {
    response.status(400).json({ error: "Некорректная дата" });
    return;
  }

  try {
    const snapshot = filterSnapshotForZones(
      await crmReservations.getSnapshot(parsedDate.data),
      access.shift.zones
    );
    response.json({
      profile: {
        id: access.waiter.id,
        name: access.waiter.name,
        role: access.role.name,
        roleKind: access.role.kind,
        zones: access.shift.zones,
        shiftStatus: access.shift.status,
        canEdit: access.shift.status === "active"
      },
      ...snapshot
    });
  } catch (error) {
    const status = error instanceof CrmReservationsError ? error.status : 502;
    response.status(status).json({
      error: error instanceof Error ? error.message : "CRM временно недоступна"
    });
  }
});

app.patch("/api/staff/reservations/:id", staffReservationsLimiter, async (request, response) => {
  const access = staffAccess(request);
  if (!access) {
    response.status(403).json({ error: "Откройте приложение из бота и сначала выйдите на смену" });
    return;
  }
  if (access.shift.status !== "active") {
    response.status(403).json({ error: "Сначала завершите обязательный чек-лист смены" });
    return;
  }
  const parsed = reservationUpdateSchema.safeParse({
    ...request.body,
    id: request.params.id
  });
  if (!parsed.success) {
    response.status(400).json({ error: "Проверьте выбранное действие" });
    return;
  }

  try {
    const snapshot = filterSnapshotForZones(
      await crmReservations.getSnapshot(parsed.data.date),
      access.shift.zones
    );
    const existing = snapshot.tables
      .flatMap((table) => table.reservations.map((reservation) => ({ reservation, table })))
      .find((item) => item.reservation.id === parsed.data.id);
    if (!existing) {
      response.status(404).json({ error: "Бронь не найдена среди столов вашей смены" });
      return;
    }
    if (parsed.data.tableId && !snapshot.tables.some((table) => table.id === parsed.data.tableId)) {
      response.status(403).json({ error: "Этот стол не относится к вашей зоне" });
      return;
    }

    const result = await crmReservations.updateReservation({
      id: parsed.data.id,
      actor: `${access.waiter.name} · ${access.role.name}`,
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.tableId ? { tableId: parsed.data.tableId } : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
      ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {})
    });
    response.json(result);
  } catch (error) {
    const status = error instanceof CrmReservationsError ? error.status : 502;
    response.status(status).json({
      error: error instanceof Error ? error.message : "Не удалось изменить бронь"
    });
  }
});

app.get("/api/public/bootstrap", (request, response) => {
  const tableSlug = String(request.query.table || "");
  const table = tableSlug ? store.findTableBySlug(tableSlug) : null;
  const snapshot = store.publicSnapshot();

  response.json({
    settings: snapshot.settings,
    offers: snapshot.offers,
    actions: snapshot.actions,
    table,
    publicBaseUrl: publicBaseUrl(),
    legal: {
      personalDataConsentVersion: PERSONAL_DATA_CONSENT_VERSION,
      personalDataConsentUrl: `${publicBaseUrl()}${PERSONAL_DATA_CONSENT_PATH}`,
      marketingConsentUrl: `${publicBaseUrl()}${MARKETING_CONSENT_PATH}`,
      privacyPolicyUrl: PRIVACY_POLICY_URL,
    }
  });
});

app.post("/api/public/calls", publicLimiter, async (request, response) => {
  const parsed = publicCallSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Некорректные данные вызова" });
    return;
  }

  const table = store.findTableBySlug(parsed.data.tableSlug);
  const action = store.findAction(parsed.data.actionId);
  if (!table || !action) {
    response.status(404).json({ error: "Стол или действие не найдено" });
    return;
  }

  const waiters = store.waitersForTable(table);
  const admins = waiters.length ? [] : store.activeAdminsForTable(table);
  const routingStage = waiters.length ? "waiter" : admins.length ? "admin" : "owner";
  const fallbackReason = waiters.length
    ? ""
    : [
        store.callFallbackReason(table),
        admins.length ? "" : "Администратор не в сети."
      ].filter(Boolean).join(" ");
  const call = await store.upsertCall({
    table,
    action,
    comment: parsed.data.comment,
    guestName: parsed.data.guestName,
    assignedWaiterId: waiters.length === 1 ? waiters[0].id : null,
    waiterRecipientIds: waiters.map((waiter) => waiter.id),
    adminRecipientIds: admins.map((admin) => admin.id),
    routingStage,
    routingReason: fallbackReason
  });

  let notified = routingStage === "owner"
    ? await messaging.notifyOwnerEscalation(call)
    : await messaging.notifyCall({
        call,
        table,
        waiters,
        settings: store.snapshot().settings
      });
  if (routingStage === "admin" && notified === 0) {
    const ownerCall = await store.markOwnerEscalated(
      call.id,
      `${fallbackReason} Уведомление администратору не доставлено.`.trim()
    );
    if (ownerCall) notified += await messaging.notifyOwnerEscalation(ownerCall);
  }

  response.status(201).json({ ok: true, callId: call.id, notified, pressCount: call.pressCount });
});

app.get("/api/public/tips", publicLimiter, (request, response) => {
  const tableSlug = String(request.query.table || "");
  const table = tableSlug ? store.findTableBySlug(tableSlug) : null;
  if (!table) {
    response.status(404).json({ error: "Стол не найден" });
    return;
  }

  const waiter = store.tipTargetForTable(table);
  if (!waiter) {
    response.json({
      enabled: false,
      message: "Чаевые будут доступны после того, как официант примет вызов."
    });
    return;
  }

  response.json({
    enabled: true,
    waiterName: waiter.name,
    url: waiter.tipUrl
  });
});

app.post("/api/public/loyalty", publicLimiter, loyaltyLimiter, async (request, response) => {
  const parsed = loyaltySchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Проверьте имя, телефон и согласие на обработку данных" });
    return;
  }

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    response.status(400).json({ error: "Введите российский номер телефона из 10 или 11 цифр" });
    return;
  }
  if (!loyaltyRegistrationAllowed(phone)) {
    response.status(403).json({
      error: "Регистрация карты пока доступна только участникам тестирования. Скоро откроем ее для всех гостей."
    });
    return;
  }

  const table = parsed.data.tableSlug ? store.findTableBySlug(parsed.data.tableSlug) : null;
  const existingLead = store.findLoyaltyLeadByPhone(phone);
  if (existingLead?.crmUserId && existingLead.phoneVerifiedAt && existingLead.accessTokenHash) {
    response.status(409).json({
      error: "Этот номер уже зарегистрирован. Для переноса карты на другой телефон обратитесь к администратору."
    });
    return;
  }

  const acceptedAt = new Date().toISOString();
  const accessToken = randomBytes(32).toString("base64url");
  const commonLeadData = {
    name: parsed.data.name.trim(),
    phone,
    birthday: parsed.data.birthday,
    tableId: table?.id ?? null,
    personalDataConsent: true,
    personalDataConsentVersion: PERSONAL_DATA_CONSENT_VERSION,
    personalDataConsentHash: PERSONAL_DATA_CONSENT_HASH,
    personalDataConsentAcceptedAt: acceptedAt,
    marketingConsent: parsed.data.marketingConsent,
    consentIpAddress: request.ip || "",
    consentUserAgent: String(request.headers["user-agent"] || "").slice(0, 1000),
    accessTokenHash: tokenHash(accessToken),
    verificationId: null,
    verificationExpiresAt: null,
    phoneVerificationChannel: null,
    phoneVerifiedAt: null,
    crmUserId: null,
    iikoCustomerId: null,
    cardNumber: null,
    bonusBalance: 0,
    balanceUpdatedAt: null,
    welcomeBonusAmount: 500,
    welcomeBonusStatus: "PENDING",
    syncError: ""
  };

  const lead = existingLead
    ? await store.updateLoyaltyLead(existingLead.id, commonLeadData)
    : await store.addLoyaltyLead(commonLeadData);
  if (!lead) {
    response.status(500).json({ error: "Не удалось сохранить регистрацию" });
    return;
  }

  try {
    const verification = await crmLoyalty.startVerification({
      sourceRegistrationId: lead.id,
      name: lead.name,
      phone: lead.phone,
      birthday: lead.birthday || undefined,
      personalDataConsent: {
        accepted: true,
        acceptedAt: lead.personalDataConsentAcceptedAt,
        documentVersion: lead.personalDataConsentVersion,
        documentUrl: `${publicBaseUrl()}${PERSONAL_DATA_CONSENT_PATH}`,
        documentHash: lead.personalDataConsentHash,
      },
      marketingConsent: lead.marketingConsent,
      ipAddress: lead.consentIpAddress,
      userAgent: lead.consentUserAgent,
    });

    await store.updateLoyaltyLead(lead.id, {
      crmUserId: verification.pendingUserId,
      verificationId: verification.verificationId,
      verificationExpiresAt: verification.expiresAt,
      syncError: ""
    });
    response.status(202).json({
      ok: true,
      verification: {
        id: verification.verificationId,
        accessToken,
        expiresAt: verification.expiresAt,
        channels: verification.channels,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CRM временно недоступна";
    await store.updateLoyaltyLead(lead.id, { syncError: message, welcomeBonusStatus: "PENDING" });
    response.status(502).json({ error: message });
  }
});

app.get("/api/public/loyalty/verification/:verificationId", publicLimiter, async (request, response) => {
  const accessToken = bearerToken(request);
  const verificationId = Array.isArray(request.params.verificationId)
    ? request.params.verificationId[0]
    : request.params.verificationId;
  const lead = store.findLoyaltyLeadByVerificationId(verificationId);
  if (!lead || !accessToken || lead.accessTokenHash !== tokenHash(accessToken)) {
    response.status(401).json({ error: "Проверка номера не найдена" });
    return;
  }

  try {
    const verification = await crmLoyalty.getVerification(verificationId);
    if (["PENDING", "CONTACT_REQUESTED", "CONSUMING"].includes(verification.status)) {
      response.status(202).json({ ok: true, verification });
      return;
    }
    if (["EXPIRED", "SUPERSEDED"].includes(verification.status)) {
      response.status(410).json({ error: "Время подтверждения истекло. Заполните анкету еще раз." });
      return;
    }
    if (!["VERIFIED", "CONSUMED"].includes(verification.status)) {
      response.status(409).json({ error: "Номер еще не подтвержден" });
      return;
    }

    const table = lead.tableId ? store.findTableById(lead.tableId) : null;
    const profile = await crmLoyalty.register({
      sourceRegistrationId: lead.id,
      verificationId: verification.id,
      name: lead.name,
      phone: lead.phone,
      birthday: lead.birthday || undefined,
      tableSlug: table?.slug,
      personalDataConsent: {
        accepted: true,
        acceptedAt: lead.personalDataConsentAcceptedAt,
        documentVersion: lead.personalDataConsentVersion,
        documentUrl: `${publicBaseUrl()}${PERSONAL_DATA_CONSENT_PATH}`,
        documentHash: lead.personalDataConsentHash,
      },
      marketingConsent: lead.marketingConsent,
      ipAddress: lead.consentIpAddress,
      userAgent: lead.consentUserAgent,
    });

    await store.updateLoyaltyLead(lead.id, {
      crmUserId: profile.userId,
      iikoCustomerId: profile.iikoCustomerId,
      cardNumber: profile.cardNumber,
      bonusBalance: profile.bonusBalance,
      balanceUpdatedAt: profile.balanceUpdatedAt,
      welcomeBonusAmount: profile.welcomeBonus.amount,
      welcomeBonusStatus: profile.welcomeBonus.status,
      phoneVerificationChannel: verification.channel,
      phoneVerifiedAt: verification.verifiedAt,
      syncError: "",
    });
    response.status(201).json({ ok: true, accessToken, profile });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CRM временно недоступна";
    await store.updateLoyaltyLead(lead.id, { syncError: message });
    response.status(502).json({ error: message });
  }
});

app.get("/api/public/loyalty/profile", publicLimiter, async (request, response) => {
  const token = bearerToken(request);
  const lead = token ? store.findLoyaltyLeadByTokenHash(tokenHash(token)) : null;
  if (!lead) {
    response.status(401).json({ error: "Карта гостя не найдена на этом устройстве" });
    return;
  }
  if (!lead.crmUserId) {
    response.status(409).json({ error: lead.syncError || "Регистрация еще синхронизируется с CRM" });
    return;
  }

  try {
    const profile = await crmLoyalty.getProfile(lead.crmUserId);
    await store.updateLoyaltyLead(lead.id, {
      iikoCustomerId: profile.iikoCustomerId,
      cardNumber: profile.cardNumber,
      bonusBalance: profile.bonusBalance,
      balanceUpdatedAt: profile.balanceUpdatedAt,
      welcomeBonusAmount: profile.welcomeBonus.amount,
      welcomeBonusStatus: profile.welcomeBonus.status,
      syncError: ""
    });
    response.json({ ok: true, profile, stale: false });
  } catch (error) {
    response.json({
      ok: true,
      profile: cachedLoyaltyProfile(lead),
      stale: true,
      warning: error instanceof Error ? error.message : "Не удалось обновить баланс"
    });
  }
});

app.get(PERSONAL_DATA_CONSENT_PATH, (_request, response) => {
  response.type("html").send(renderLegalDocument("Согласие на обработку персональных данных", PERSONAL_DATA_CONSENT_TEXT));
});

app.get(MARKETING_CONSENT_PATH, (_request, response) => {
  response.type("html").send(renderLegalDocument("Согласие на получение сообщений", MARKETING_CONSENT_TEXT));
});

app.post("/api/public/feedback", publicLimiter, async (request, response) => {
  const parsed = feedbackSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Проверьте данные отзыва" });
    return;
  }

  const table = parsed.data.tableSlug ? store.findTableBySlug(parsed.data.tableSlug) : null;
  const waiter = table ? store.tipTargetForTable(table) : null;

  const feedback = await store.addFeedback({
    tableId: table?.id ?? null,
    waiterId: waiter?.id ?? null,
    rating: parsed.data.rating,
    reasons: parsed.data.reasons,
    liked: parsed.data.liked,
    disliked: parsed.data.disliked,
    guestName: parsed.data.guestName,
    phone: parsed.data.phone
  });

  response.status(201).json({ ok: true, feedbackId: feedback.id });
});

app.post("/api/public/feedback/:id/review-click", publicLimiter, async (request, response) => {
  const feedback = await store.incrementFeedbackReviewClick(String(request.params.id));
  if (!feedback) {
    response.status(404).json({ error: "Отзыв не найден" });
    return;
  }
  response.json({ ok: true });
});

app.post("/api/telegram/webhook", async (request, response) => {
  await telegram.handleUpdate(request.body);
  response.json({ ok: true });
});

app.post("/api/max/webhook", async (request, response) => {
  if (!max.webhookConfigured()) {
    response.status(503).json({ error: "MAX webhook не настроен" });
    return;
  }
  if (!max.webhookAuthorized(request.header("x-max-bot-api-secret"))) {
    response.status(401).json({ error: "Некорректный секрет MAX webhook" });
    return;
  }
  response.json({ ok: true });
  void max.handleUpdate(request.body).catch((error) => console.error("[max webhook]", error));
});

const adminLoginSchema = z.object({
  username: z.string().max(64),
  password: z.string().max(128)
});

app.post("/api/admin/login", adminLoginLimiter, (request, response) => {
  const parsed = adminLoginSchema.safeParse(request.body);
  const auth = parsed.success ? authenticateAdmin(parsed.data.username, parsed.data.password) : null;
  if (!auth) {
    response.status(401).json({ error: "Неверный логин или пароль" });
    return;
  }

  response.json({ token: createAdminToken(auth), role: auth.role, username: auth.username });
});

app.use("/api/admin", requireAdmin);

app.post("/api/admin/session/refresh", (request, response) => {
  const auth = getAdminAuth(request);
  if (!auth) {
    response.status(401).json({ error: "Сессия истекла" });
    return;
  }
  const { exp: _expiredAt, ...renewedAuth } = auth;
  response.json({
    token: createAdminToken(renewedAuth),
    role: renewedAuth.role,
    username: renewedAuth.username
  });
});

const adminAccountUpdateSchema = z.object({
  username: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9._-]+$/),
  password: z.string().min(8).max(128)
});

const ownerNotificationUpdateSchema = z.object({
  telegramChatId: z.string().trim().max(32).regex(/^$|^-?\d+$/),
  maxUserId: z.string().trim().max(32).regex(/^$|^\d+$/),
  sberCardNumber: z.string().trim().max(32).regex(/^$|^[\d\s-]{12,32}$/).default(""),
  telegramEnabled: z.boolean(),
  maxEnabled: z.boolean()
}).superRefine((value, context) => {
  if (value.telegramEnabled && !value.telegramChatId) {
    context.addIssue({
      code: "custom",
      path: ["telegramChatId"],
      message: "Укажите Telegram ID или выключите канал"
    });
  }
  if (value.maxEnabled && !value.maxUserId) {
    context.addIssue({
      code: "custom",
      path: ["maxUserId"],
      message: "Укажите MAX user_id или выключите канал"
    });
  }
});

const ownerPushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(4096).refine((value) => value.startsWith("https://")),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(16).max(512),
    auth: z.string().min(8).max(256)
  })
});

const ownerPushUnsubscribeSchema = z.object({
  endpoint: z.string().url().max(4096).refine((value) => value.startsWith("https://"))
});

app.put("/api/admin/admin-account", requireOwner, async (request, response) => {
  const parsed = adminAccountUpdateSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: "Логин: от 3 до 64 латинских символов, цифр, точки, дефиса или подчёркивания. Пароль: минимум 8 символов"
    });
    return;
  }
  try {
    response.json(await updateAdminAccount(parsed.data.username, parsed.data.password));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Не удалось обновить доступ администратора" });
  }
});

app.put("/api/admin/owner-notifications", requireOwner, async (request, response) => {
  const parsed = ownerNotificationUpdateSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: parsed.error.issues[0]?.message || "Проверьте настройки каналов владельца"
    });
    return;
  }

  const staff = store.snapshot().waiters.filter(
    (member) => store.findRole(member.roleId)?.kind !== "owner"
  );
  if (
    parsed.data.telegramChatId &&
    staff.some((member) => member.telegramChatId.trim() === parsed.data.telegramChatId)
  ) {
    response.status(400).json({ error: "Этот Telegram ID уже назначен сотруднику" });
    return;
  }
  if (
    parsed.data.maxUserId &&
    staff.some((member) => member.maxUserId.trim() === parsed.data.maxUserId)
  ) {
    response.status(400).json({ error: "Этот MAX user_id уже назначен сотруднику" });
    return;
  }

  response.json(await store.updateOwnerNotifications(parsed.data));
});

app.get("/api/admin/web-push/status", requireOwner, (_request, response) => {
  response.json(ownerWebPush.status());
});

app.post("/api/admin/web-push/subscriptions", requireOwner, async (request, response) => {
  const parsed = ownerPushSubscriptionSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Некорректная Web Push подписка" });
    return;
  }
  try {
    response.json(await ownerWebPush.subscribe(parsed.data, String(request.headers["user-agent"] || "")));
  } catch (error) {
    response.status(503).json({
      error: error instanceof Error ? error.message : "Не удалось включить системные уведомления"
    });
  }
});

app.delete("/api/admin/web-push/subscriptions", requireOwner, async (request, response) => {
  const parsed = ownerPushUnsubscribeSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Некорректная Web Push подписка" });
    return;
  }
  response.json(await ownerWebPush.unsubscribe(parsed.data.endpoint));
});

app.post("/api/admin/web-push/test", requireOwner, async (_request, response) => {
  if (!ownerWebPush.enabled()) {
    response.status(503).json({ error: "Web Push ещё не настроен на сервере" });
    return;
  }
  const result = await ownerWebPush.notify({
    title: "Faj QR: уведомления включены",
    body: "Тестовое системное уведомление доставлено на устройство владельца.",
    url: "/admin",
    tag: `test-${Date.now()}`
  });
  if (!result.sent) {
    response.status(409).json({ error: "Нет активной подписки устройства", ...result });
    return;
  }
  response.json(result);
});

app.post("/api/admin/review-media", reviewImageUploadParser, async (request, response) => {
  const contentType = String(request.headers["content-type"] || "").split(";")[0].toLowerCase();
  const extension = logoContentTypes[contentType];
  if (
    !extension ||
    !Buffer.isBuffer(request.body) ||
    request.body.length < 100 ||
    !validImageSignature(contentType, request.body)
  ) {
    response.status(400).json({ error: "Загрузите настоящее PNG, JPG или WEBP фото до 8 МБ" });
    return;
  }

  await mkdir(reviewMediaDir, { recursive: true });
  const filename = `review-${Date.now()}-${randomUUID()}.${extension}`;
  await writeFile(path.join(reviewMediaDir, filename), request.body);
  response.status(201).json({ url: `/api/admin/review-media/${filename}` });
});

app.get("/api/admin/review-media/:filename", (request, response) => {
  const filename = String(request.params.filename || "");
  if (!/^(?:review|penalty)-\d+-[0-9a-f-]+\.(?:png|jpg|webp)$/.test(filename)) {
    response.status(404).json({ error: "Фото не найдено" });
    return;
  }
  response.setHeader("Cache-Control", "private, max-age=3600");
  response.sendFile(filename, { root: reviewMediaDir, dotfiles: "deny" }, (error) => {
    if (error && !response.headersSent) response.status(404).json({ error: "Фото не найдено" });
  });
});

app.post("/api/admin/logo", logoUploadParser, async (request, response) => {
  const contentType = String(request.headers["content-type"] || "").split(";")[0].toLowerCase();
  const extension = logoContentTypes[contentType];
  if (!extension || !Buffer.isBuffer(request.body) || request.body.length < 100) {
    response.status(400).json({ error: "Загрузите PNG, JPG или WEBP логотип до 10 МБ" });
    return;
  }

  await mkdir(uploadsDir, { recursive: true });
  const filename = `logo-${Date.now()}-${randomUUID()}.${extension}`;
  await writeFile(path.join(uploadsDir, filename), request.body);

  const settings = await store.updateSettings({
    ...store.snapshot().settings,
    logoUrl: `/uploads/${filename}`
  });
  response.json(settings);
});

app.post("/api/admin/upload", logoUploadParser, async (request, response) => {
  const contentType = String(request.headers["content-type"] || "").split(";")[0].toLowerCase();
  const extension = logoContentTypes[contentType];
  if (!extension || !Buffer.isBuffer(request.body) || request.body.length < 100) {
    response.status(400).json({ error: "Загрузите PNG, JPG или WEBP файл до 10 МБ" });
    return;
  }

  await mkdir(uploadsDir, { recursive: true });
  const filename = `file-${Date.now()}-${randomUUID()}.${extension}`;
  await writeFile(path.join(uploadsDir, filename), request.body);

  response.json({ url: `/uploads/${filename}` });
});

app.get("/api/admin/overview", (request, response) => {
  const data = store.snapshot();
  const auth = getAdminAuth(request);
  const isOwner = auth?.role === "owner";
  const visibleWaiters = isOwner
    ? data.waiters
    : data.waiters.filter((member) => store.findRole(member.roleId)?.kind !== "owner");
  const visibleShifts = isOwner
    ? data.shifts
    : data.shifts.filter((shift) => shift.roleKind !== "admin" && shift.roleKind !== "owner");
  const visibleRatings = store
    .waiterRatings()
    .filter((rating) => isOwner || (rating.roleKind !== "admin" && rating.roleKind !== "owner"));
  const visibleShiftTasks = store
    .listShiftTasks()
    .filter((task) => isOwner || store.findRole(task.roleId)?.kind !== "owner");
  const visibleRoleIds = data.staffRoles
    .filter((role) => isOwner || (role.kind !== "admin" && role.kind !== "owner"))
    .map((role) => role.id);
  response.json({
    ...data,
    ownerNotifications: isOwner
      ? data.ownerNotifications
      : {
          telegramChatId: "",
          maxUserId: "",
          sberCardNumber: "",
          telegramEnabled: false,
          maxEnabled: false,
          configured: true
        },
    staffRoles: data.staffRoles.filter((role) => isOwner || role.kind !== "owner"),
    waiters: visibleWaiters,
    checklistItems: data.checklistItems.filter(
      (item) => isOwner || store.findRole(item.roleId)?.kind !== "owner"
    ),
    shiftTasks: visibleShiftTasks,
    popups: store.listPopups(),
    shifts: visibleShifts,
    ratings: visibleRatings,
    performance: store.performanceAnalytics(visibleRoleIds),
    performanceAiEnabled: isPerformanceAiConfigured(),
    venueTimeZone: config.VENUE_TIME_ZONE,
    accessRole: auth?.role || "admin",
    username: auth?.username || "",
    adminAccount: isOwner ? getAdminAccountSummary() : null,
    publicBaseUrl: publicBaseUrl(),
    telegramEnabled: telegram.enabled(),
    telegramBotUrl: `https://t.me/${config.TELEGRAM_BOT_USERNAME.replace(/^@/, "")}`,
    maxEnabled: max.enabled(),
    maxBotUrl: config.MAX_BOT_USERNAME ? `https://max.ru/${config.MAX_BOT_USERNAME.replace(/^@/, "")}` : "",
    ownerWebPush: isOwner ? ownerWebPush.status() : {
      enabled: false,
      publicKey: "",
      subscriptionCount: 0,
      checklistOverdueMinutes: config.CHECKLIST_OVERDUE_MINUTES
    }
  });
});

app.put("/api/admin/settings", async (request, response) => {
  response.json(await store.updateSettings(request.body));
});

app.put("/api/admin/offers", async (request, response) => {
  const offers = (Array.isArray(request.body) ? request.body : []).map((offer) => ({
    ...offer,
    id: String(offer?.id || randomUUID())
  }));
  try {
    const synchronized = await crmLoyalty.replaceOffers(offers);
    response.json(await store.replaceOffers(synchronized));
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : "Не удалось сохранить акции в CRM"
    });
  }
});

app.post("/api/admin/offers/sync", async (_request, response) => {
  try {
    const offers = await crmLoyalty.getOffers();
    response.json(await store.replaceOffers(offers));
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : "Не удалось получить акции из CRM"
    });
  }
});

app.get("/api/admin/popups", (_request, response) => {
  response.json(store.listPopups());
});

app.post("/api/admin/popups", async (request, response) => {
  response.status(201).json(await store.addPopup(request.body));
});

app.put("/api/admin/popups/:id", async (request, response) => {
  const popup = await store.updatePopup(request.params.id, request.body);
  if (!popup) {
    response.status(404).json({ error: "Уведомление не найдено" });
    return;
  }
  response.json(popup);
});

app.delete("/api/admin/popups/:id", async (request, response) => {
  const deleted = await store.deletePopup(request.params.id);
  if (!deleted) {
    response.status(404).json({ error: "Уведомление не найдено" });
    return;
  }
  response.json({ ok: true });
});

app.put("/api/admin/actions", async (request, response) => {
  response.json(await store.replaceActions(Array.isArray(request.body) ? request.body : []));
});

app.put("/api/admin/checklist", async (request, response) => {
  const submitted = Array.isArray(request.body) ? request.body : [];
  const auth = getAdminAuth(request);
  if (auth?.role === "owner") {
    response.json(await store.replaceChecklistItems(submitted));
    return;
  }
  const ownerItems = store.snapshot().checklistItems.filter(
    (item) => store.findRole(item.roleId)?.kind === "owner"
  );
  const allowed = submitted.filter((item) => store.findRole(String(item.roleId || ""))?.kind !== "owner");
  response.json(await store.replaceChecklistItems([...ownerItems, ...allowed]));
});

app.put("/api/admin/staff-roles", requireOwner, async (request, response) => {
  response.json(await store.replaceStaffRoles(Array.isArray(request.body) ? request.body : []));
});

app.put("/api/admin/tables", async (request, response) => {
  response.json(await store.replaceTables(Array.isArray(request.body) ? request.body : []));
});

app.put("/api/admin/waiters", async (request, response) => {
  const submitted = Array.isArray(request.body) ? request.body : [];
  const chatIds = submitted.map((member) => String(member.telegramChatId || "").trim()).filter(Boolean);
  if (new Set(chatIds).size !== chatIds.length) {
    response.status(400).json({ error: "Один Telegram Chat ID нельзя назначить нескольким сотрудникам" });
    return;
  }
  const maxUserIds = submitted.map((member) => String(member.maxUserId || "").trim()).filter(Boolean);
  if (new Set(maxUserIds).size !== maxUserIds.length) {
    response.status(400).json({ error: "Один MAX user_id нельзя назначить нескольким сотрудникам" });
    return;
  }
  const ownerNotifications = store.snapshot().ownerNotifications;
  const nonOwnerSubmitted = submitted.filter(
    (member) => store.findRole(String(member.roleId || ""))?.kind !== "owner"
  );
  if (
    ownerNotifications.telegramChatId &&
    nonOwnerSubmitted.some(
      (member) => String(member.telegramChatId || "").trim() === ownerNotifications.telegramChatId
    )
  ) {
    response.status(400).json({ error: "Этот Telegram ID уже используется в профиле владельца" });
    return;
  }
  if (
    ownerNotifications.maxUserId &&
    nonOwnerSubmitted.some(
      (member) => String(member.maxUserId || "").trim() === ownerNotifications.maxUserId
    )
  ) {
    response.status(400).json({ error: "Этот MAX user_id уже используется в профиле владельца" });
    return;
  }
  const auth = getAdminAuth(request);
  if (auth?.role === "owner") {
    response.json(await store.replaceWaiters(submitted));
    return;
  }
  const owners = store.snapshot().waiters.filter((member) => store.findRole(member.roleId)?.kind === "owner");
  const allowed = submitted.filter((member) => store.findRole(String(member.roleId || ""))?.kind !== "owner");
  const merged = [...owners, ...allowed];
  const mergedChatIds = merged.map((member) => String(member.telegramChatId || "").trim()).filter(Boolean);
  if (new Set(mergedChatIds).size !== mergedChatIds.length) {
    response.status(400).json({ error: "Этот Telegram Chat ID уже принадлежит владельцу" });
    return;
  }
  const mergedMaxUserIds = merged.map((member) => String(member.maxUserId || "").trim()).filter(Boolean);
  if (new Set(mergedMaxUserIds).size !== mergedMaxUserIds.length) {
    response.status(400).json({ error: "Этот MAX user_id уже принадлежит владельцу" });
    return;
  }
  response.json(await store.replaceWaiters(merged));
});

app.delete("/api/admin/waiters/:id", async (request, response) => {
  const result = await store.deleteWaiter(String(request.params.id || ""));
  if (result.status === "not_found") {
    response.status(404).json({ error: "Сотрудник не найден" });
    return;
  }
  if (result.status === "owner_forbidden") {
    response.status(403).json({ error: "Владельца нельзя удалить из списка сотрудников" });
    return;
  }
  if (result.status === "active_shift") {
    response.status(409).json({
      error: `Сначала завершите активную смену сотрудника «${result.shift.waiterName}»`,
      shiftId: result.shift.id
    });
    return;
  }
  response.json({ ok: true, waiter: result.waiter });
});

app.get("/api/admin/shift-tasks", (request, response) => {
  const auth = getAdminAuth(request);
  response.json(
    store.listShiftTasks().filter((task) => auth?.role === "owner" || store.findRole(task.roleId)?.kind !== "owner")
  );
});

const shiftTaskSchema = z.object({
  roleId: z.string().min(1),
  waiterId: z.string().nullable().default(null),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(500).optional().default(""),
  requiredForCalls: z.boolean().default(false),
  countsForRating: z.boolean().default(true)
});

app.post("/api/admin/shift-tasks", async (request, response) => {
  const parsed = shiftTaskSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Проверьте данные задания" });
    return;
  }
  const role = store.findRole(parsed.data.roleId);
  if (!role) {
    response.status(400).json({ error: "Должность не найдена" });
    return;
  }
  const auth = getAdminAuth(request);
  if (role.kind === "owner" && auth?.role !== "owner") {
    response.status(403).json({ error: "Задания владельца доступны только владельцу" });
    return;
  }
  if (parsed.data.waiterId) {
    const member = store.findWaiterById(parsed.data.waiterId);
    if (!member || member.roleId !== role.id) {
      response.status(400).json({ error: "Сотрудник не относится к выбранной должности" });
      return;
    }
  }
  const task = await store.addShiftTask({
    roleId: parsed.data.roleId,
    waiterId: parsed.data.waiterId,
    date: parsed.data.date,
    title: parsed.data.title,
    description: parsed.data.description,
    requiredForCalls: parsed.data.requiredForCalls,
    countsForRating: parsed.data.countsForRating
  });
  // Если задание на сегодня и для конкретного сотрудника — отправить уведомление немедленно
  const todayKey = venueOperationalDateKey();
  if (task.date === todayKey && task.waiterId) {
    if (await messaging.notifyShiftTask(task)) {
      await store.markShiftTaskNotified(task.id);
    }
  }
  response.status(201).json(task);
});

app.delete("/api/admin/shift-tasks/:id", async (request, response) => {
  const task = store.findShiftTask(request.params.id);
  if (task && store.findRole(task.roleId)?.kind === "owner" && getAdminAuth(request)?.role !== "owner") {
    response.status(403).json({ error: "Задания владельца доступны только владельцу" });
    return;
  }
  const deleted = await store.deleteShiftTask(request.params.id);
  if (!deleted) {
    response.status(404).json({ error: "Задание не найдено" });
    return;
  }
  response.json({ ok: true });
});

app.post("/api/admin/shifts/:id/end", async (request, response) => {
  const result = await store.endWaiterShiftBySupervisor(request.params.id);
  if (result.status === "not_found") {
    response.status(404).json({ error: "Смена не найдена" });
    return;
  }
  if (result.status === "already_ended") {
    response.status(409).json({ error: "Смена уже завершена" });
    return;
  }
  if (result.status === "not_waiter") {
    response.status(403).json({ error: "Ручное завершение доступно только для смены официанта" });
    return;
  }
  if (result.status === "tables_assigned") {
    response.status(409).json({
      error: `Сначала снимите официанта с назначенных столов: ${result.tableCount}`,
      tableCount: result.tableCount
    });
    return;
  }
  if (result.status === "closing_checklist_incomplete") {
    response.status(409).json({
      error: `Сначала завершите чек-лист закрытия: осталось пунктов — ${result.pendingCount}`,
      pendingCount: result.pendingCount
    });
    return;
  }
  response.json(result.shift);
});

app.put("/api/admin/shifts/:id/review", async (request, response) => {
  const parsed = shiftReviewSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Проверьте оценки чек-листа" });
    return;
  }

  const existingShift = store.findShiftById(request.params.id);
  const auth = getAdminAuth(request);
  if (existingShift && auth?.role !== "owner" && (existingShift.roleKind === "admin" || existingShift.roleKind === "owner")) {
    response.status(403).json({ error: "Оценка администраторов доступна только владельцу" });
    return;
  }
  let shift;
  try {
    shift = await store.reviewShiftChecklist(
      request.params.id,
      parsed.data.reviews,
      auth?.role ?? null,
      auth?.username ?? ""
    );
  } catch (error) {
    response.status(409).json({ error: error instanceof Error ? error.message : "Оценка не сохранена" });
    return;
  }
  if (!shift) {
    response.status(404).json({ error: "Смена не найдена" });
    return;
  }
  response.json(shift);
});

const performanceInsightSchema = z.object({
  roleIds: z.array(z.string().min(1)).max(20).optional().default([])
});

app.post("/api/admin/performance-insights", performanceAiLimiter, async (request, response) => {
  const parsed = performanceInsightSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Проверьте выбранные подразделения" });
    return;
  }
  const auth = getAdminAuth(request);
  const allowedRoles = store.snapshot().staffRoles.filter(
    (role) => auth?.role === "owner" || (role.kind !== "admin" && role.kind !== "owner")
  );
  const allowedIds = new Set(allowedRoles.map((role) => role.id));
  const requestedRoleIds = parsed.data.roleIds.length ? parsed.data.roleIds : Array.from(allowedIds);
  if (requestedRoleIds.some((roleId) => !allowedIds.has(roleId))) {
    response.status(403).json({ error: "Нет доступа к аналитике выбранного подразделения" });
    return;
  }
  response.json(await generatePerformanceInsights(store.performanceAnalytics(requestedRoleIds)));
});

app.post("/api/admin/employees/:id/performance-insights", performanceAiLimiter, async (request, response) => {
  const auth = getAdminAuth(request);
  const waiter = store.snapshot().waiters.find((item) => item.id === request.params.id);
  const role = waiter ? store.findRole(waiter.roleId) : null;
  if (!waiter || !role) {
    response.status(404).json({ error: "Сотрудник не найден" });
    return;
  }
  if (role.kind === "owner" || (auth?.role !== "owner" && role.kind === "admin")) {
    response.status(403).json({ error: "Нет доступа к аналитике этого сотрудника" });
    return;
  }

  const analytics = store.performanceAnalytics([role.id], [waiter.id]);
  response.json(await generatePerformanceInsights(analytics, {
    focusEmployee: {
      waiterId: waiter.id,
      waiterName: waiter.name,
      roleName: role.name
    }
  }));
});

app.patch("/api/admin/calls/:id", async (request, response) => {
  const status = request.body?.status as CallStatus;
  if (!["new", "accepted", "done", "cancelled"].includes(status)) {
    response.status(400).json({ error: "Некорректный статус" });
    return;
  }

  const call = await store.updateCallStatus(
    request.params.id,
    status,
    null,
    getAdminAuth(request)?.role
  );
  if (!call) {
    response.status(404).json({ error: "Вызов не найден" });
    return;
  }

  if (status === "done" || status === "cancelled") await messaging.closeCallMessages(call);

  response.json(call);
});

app.post("/api/admin/calls/:id/acknowledge", async (request, response) => {
  const auth = getAdminAuth(request);
  const call = auth ? await store.acknowledgeEscalation(request.params.id, auth.role) : null;
  if (!call) {
    response.status(409).json({ error: "Эскалация уже закрыта или назначена другой роли" });
    return;
  }

  await messaging.syncCall(call);
  response.json(call);
});

const staticDir = path.resolve(__dirname, "../dist/client");
app.use(
  express.static(staticDir, {
    immutable: true,
    maxAge: "1y",
    setHeaders(response, filePath) {
      if (
        filePath.endsWith("index.html") ||
        filePath.endsWith("admin-sw.js") ||
        filePath.endsWith("manifest.webmanifest")
      ) {
        response.setHeader("cache-control", "no-store");
      }
    }
  })
);
app.get(/.*/, (_request, response) => {
  response.setHeader("cache-control", "no-store");
  response.sendFile(path.join(staticDir, "index.html"));
});

app.use((error: unknown, request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (typeof error === "object" && error && "type" in error && error.type === "entity.too.large") {
    response.status(413).json({
      error: request.originalUrl.startsWith("/api/admin/review-media")
        ? "Фото слишком большое. Загрузите фото до 8 МБ"
        : "Файл слишком большой. Загрузите логотип до 10 МБ"
    });
    return;
  }

  console.error(error);
  response.status(500).json({ error: "Internal server error" });
});

app.listen(config.PORT, config.HOST, () => {
  console.log(`API started on http://${config.HOST}:${config.PORT}`);
  console.log(`Admin accounts: ${getAdminAccountSummary().username}, ${config.OWNER_USERNAME}`);
  messaging.start();
  reservationMonitor.start();
  void refreshOffersFromCrm();
  setInterval(() => void refreshOffersFromCrm(), 5 * 60 * 1000).unref();
});
