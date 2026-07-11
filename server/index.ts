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
  getAdminAuth,
  requireAdmin,
  requireOwner
} from "./auth";
import { config, publicBaseUrl } from "./config";
import { Store } from "./store";
import { TelegramService } from "./telegram";
import { generatePerformanceInsights, isPerformanceAiConfigured } from "./performance-ai";
import type { CallStatus } from "./types";
import { crmLoyalty } from "./crm-loyalty";
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
assertProductionSecrets();
const store = new Store();
await store.init();
const telegram = new TelegramService(store);

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
      comment: z.string().max(500).optional().default("")
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

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/ready", (_request, response) => {
  const snapshot = store.snapshot();
  response.json({
    ok: true,
    tables: snapshot.tables.length,
    telegramEnabled: telegram.enabled(),
    publicBaseUrl: publicBaseUrl()
  });
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
  const routingStage = waiters.length ? "waiter" : "admin";
  const call = await store.upsertCall({
    table,
    action,
    comment: parsed.data.comment,
    guestName: parsed.data.guestName,
    assignedWaiterId: waiters.length === 1 ? waiters[0].id : null,
    routingStage,
    routingReason: routingStage === "admin" ? store.callFallbackReason(table) : ""
  });

  const messages = await telegram.notifyCall({
    call,
    table,
    waiters,
    settings: store.snapshot().settings
  });

  response.status(201).json({ ok: true, callId: call.id, notified: messages.length, pressCount: call.pressCount });
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
  if (existingLead?.crmUserId && existingLead.accessTokenHash) {
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
    const verification = await crmLoyalty.startVerification(phone);

    await store.updateLoyaltyLead(lead.id, {
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

app.post("/api/admin/login", adminLoginLimiter, (request, response) => {
  const auth = authenticateAdmin(String(request.body?.username || ""), String(request.body?.password || ""));
  if (!auth) {
    response.status(401).json({ error: "Неверный логин или пароль" });
    return;
  }

  response.json({ token: createAdminToken(auth), role: auth.role, username: auth.username });
});

app.use("/api/admin", requireAdmin);

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
    accessRole: auth?.role || "admin",
    username: auth?.username || "",
    publicBaseUrl: publicBaseUrl(),
    telegramEnabled: telegram.enabled(),
    telegramBotUrl: `https://t.me/${config.TELEGRAM_BOT_USERNAME.replace(/^@/, "")}`
  });
});

app.put("/api/admin/settings", async (request, response) => {
  response.json(await store.updateSettings(request.body));
});

app.put("/api/admin/offers", async (request, response) => {
  response.json(await store.replaceOffers(Array.isArray(request.body) ? request.body : []));
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
  response.json(await store.replaceWaiters(merged));
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
  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: config.VENUE_TIME_ZONE }).format(new Date());
  if (task.date === todayKey && task.waiterId) {
    if (await telegram.notifyShiftTask(task)) {
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
  const shift = await store.reviewShiftChecklist(request.params.id, parsed.data.reviews);
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

app.patch("/api/admin/calls/:id", async (request, response) => {
  const status = request.body?.status as CallStatus;
  if (!["new", "accepted", "done", "cancelled"].includes(status)) {
    response.status(400).json({ error: "Некорректный статус" });
    return;
  }

  const call = await store.updateCallStatus(request.params.id, status);
  if (!call) {
    response.status(404).json({ error: "Вызов не найден" });
    return;
  }

  if (status === "done" || status === "cancelled") await telegram.closeCallMessages(call);

  response.json(call);
});

const staticDir = path.resolve(__dirname, "../dist/client");
app.use(
  express.static(staticDir, {
    immutable: true,
    maxAge: "1y",
    setHeaders(response, filePath) {
      if (filePath.endsWith("index.html")) {
        response.setHeader("cache-control", "no-store");
      }
    }
  })
);
app.get(/.*/, (_request, response) => {
  response.setHeader("cache-control", "no-store");
  response.sendFile(path.join(staticDir, "index.html"));
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (typeof error === "object" && error && "type" in error && error.type === "entity.too.large") {
    response.status(413).json({ error: "Файл слишком большой. Загрузите логотип до 10 МБ" });
    return;
  }

  console.error(error);
  response.status(500).json({ error: "Internal server error" });
});

app.listen(config.PORT, config.HOST, () => {
  console.log(`API started on http://${config.HOST}:${config.PORT}`);
  console.log(`Admin accounts: ${config.ADMIN_USERNAME}, ${config.OWNER_USERNAME}`);
  telegram.startPolling();
});
