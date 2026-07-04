import "dotenv/config";
import compression from "compression";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assertProductionSecrets, createAdminToken, requireAdmin, adminPassword } from "./auth";
import { config, publicBaseUrl } from "./config";
import { Store } from "./store";
import { TelegramService } from "./telegram";
import type { CallStatus } from "./types";

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

const publicCallSchema = z.object({
  tableSlug: z.string().min(1),
  actionId: z.string().min(1),
  comment: z.string().max(240).optional().default(""),
  guestName: z.string().max(80).optional().default("")
});

const loyaltySchema = z.object({
  tableSlug: z.string().optional().default(""),
  name: z.string().min(2).max(80),
  phone: z.string().min(5).max(40),
  birthday: z.string().max(20).optional().default(""),
  consent: z.literal(true)
});

const feedbackSchema = z.object({
  tableSlug: z.string().optional().default(""),
  rating: z.number().min(1).max(5),
  reasons: z.array(z.string()).optional().default([]),
  liked: z.string().max(2000).optional().default(""),
  disliked: z.string().max(2000).optional().default(""),
  guestName: z.string().max(80).optional().default(""),
  phone: z.string().max(40).optional().default("")
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
    publicBaseUrl: publicBaseUrl()
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
  const call = await store.addCall({
    table,
    action,
    comment: parsed.data.comment,
    guestName: parsed.data.guestName,
    assignedWaiterId: waiters.length === 1 ? waiters[0].id : null
  });

  const messages = await telegram.notifyCall({
    call,
    table,
    waiters,
    settings: store.snapshot().settings
  });
  if (messages.length) await store.attachTelegramMessages(call.id, messages);

  response.status(201).json({ ok: true, callId: call.id, notified: messages.length });
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

app.post("/api/public/loyalty", publicLimiter, async (request, response) => {
  const parsed = loyaltySchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Проверьте имя и телефон" });
    return;
  }

  const table = parsed.data.tableSlug ? store.findTableBySlug(parsed.data.tableSlug) : null;
  const lead = await store.addLoyaltyLead({
    name: parsed.data.name,
    phone: parsed.data.phone,
    birthday: parsed.data.birthday,
    tableId: table?.id ?? null,
    consent: parsed.data.consent
  });

  response.status(201).json({ ok: true, leadId: lead.id });
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
  if (request.body?.password !== adminPassword) {
    response.status(401).json({ error: "Неверный пароль" });
    return;
  }

  response.json({ token: createAdminToken() });
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

app.get("/api/admin/overview", (_request, response) => {
  const data = store.snapshot();
  response.json({
    ...data,
    publicBaseUrl: publicBaseUrl(),
    telegramEnabled: telegram.enabled()
  });
});

app.put("/api/admin/settings", async (request, response) => {
  response.json(await store.updateSettings(request.body));
});

app.put("/api/admin/offers", async (request, response) => {
  response.json(await store.replaceOffers(Array.isArray(request.body) ? request.body : []));
});

app.put("/api/admin/actions", async (request, response) => {
  response.json(await store.replaceActions(Array.isArray(request.body) ? request.body : []));
});

app.put("/api/admin/tables", async (request, response) => {
  response.json(await store.replaceTables(Array.isArray(request.body) ? request.body : []));
});

app.put("/api/admin/waiters", async (request, response) => {
  response.json(await store.replaceWaiters(Array.isArray(request.body) ? request.body : []));
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
  console.log(`Admin password: ${adminPassword === "admin123" ? "admin123 (change ADMIN_PASSWORD)" : "configured"}`);
  telegram.startPolling();
});
