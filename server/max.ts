import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { Agent as HttpsAgent } from "node:https";
import path from "node:path";
import fetch from "node-fetch";
import { config, publicBaseUrl } from "./config";
import type { ShiftEndResult, Store } from "./store";
import type {
  DeliveryPickupAlert,
  DiningTable,
  MaxMessageRef,
  ServiceCall,
  ShiftTask,
  ShiftTaskRolloverRecord,
  VenueSettings,
  Waiter,
  WaiterShift
} from "./types";
import { shiftChecklistText, shiftStartedText, shiftTaskRolloverText, shiftTaskText } from "./shift-messages";
import { CHECKLIST_PHASE_META, formatChecklistWindow } from "../shared/checklists";
import { nextDateKey } from "../shared/shift-tasks";

type MaxUser = {
  user_id: number;
  name?: string;
  username?: string | null;
};

type MaxMessage = {
  sender?: MaxUser | null;
  recipient: { chat_id: number | null; chat_type: string };
  body: {
    mid: string;
    text?: string | null;
    attachments?: Array<{ type?: string; payload?: { url?: string; token?: string } }>;
  };
};

type MaxUpdate = {
  update_type: string;
  timestamp: number;
  chat_id?: number;
  user?: MaxUser;
  message?: MaxMessage | null;
  callback?: {
    callback_id: string;
    payload?: string;
    user: MaxUser;
  };
};

type MaxButton = {
  type: "callback";
  text: string;
  payload: string;
  intent?: "default" | "positive" | "negative";
};

type MaxMessageBody = {
  text: string;
  attachments?: Array<{
    type: "inline_keyboard";
    payload: { buttons: MaxButton[][] };
  }>;
  notify?: boolean;
};

type MaxCallCoordinator = {
  syncCall(call: ServiceCall): Promise<void>;
  closeCall(call: ServiceCall): Promise<void>;
  notifyClosingChecklistIncomplete?(shift: WaiterShift): Promise<void>;
  notifyAdminShiftSummary?(shift: WaiterShift): Promise<void>;
  processEndedShiftTasks?(shift: WaiterShift): Promise<ShiftTask[]>;
  acknowledgeDeliveryPickupAlert?(alertId: string, waiterId: string): Promise<any>;
};

type MaxApiRequest = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

const formatTime = (value: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: config.VENUE_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));

const callReasonIcon = (label: string) => {
  const normalized = label.toLocaleLowerCase("ru-RU");
  if (normalized.includes("карт")) return "💳";
  if (normalized.includes("налич")) return "💵";
  if (normalized.includes("заказ") || normalized.includes("блюд")) return "🍽️";
  if (normalized.includes("официант") || normalized.includes("помощ")) return "🙋";
  return "🔔";
};

export class MaxService {
  private callQueues = new Map<string, Promise<MaxMessageRef[]>>();
  private rolloverReasonDrafts = new Map<number, string>();
  private coordinator: MaxCallCoordinator | null = null;
  private httpsAgent: HttpsAgent | undefined;

  constructor(
    private store: Store,
    private token = config.MAX_BOT_TOKEN,
    private apiBaseUrl = config.MAX_API_BASE_URL
  ) {
    if (config.MAX_CA_CERT_PATH) {
      try {
        this.httpsAgent = new HttpsAgent({
          ca: readFileSync(path.resolve(config.MAX_CA_CERT_PATH), "utf8")
        });
      } catch (error) {
        console.error(
          "[max] Не удалось загрузить MAX_CA_CERT_PATH:",
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  enabled() {
    return Boolean(this.token.trim());
  }

  setCallCoordinator(coordinator: MaxCallCoordinator) {
    this.coordinator = coordinator;
  }

  webhookConfigured() {
    return this.enabled() && Boolean(config.MAX_WEBHOOK_SECRET);
  }

  webhookAuthorized(headerValue: string | undefined) {
    const expected = config.MAX_WEBHOOK_SECRET;
    const actual = headerValue || "";
    if (!expected || expected.length !== actual.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  }

  async start() {
    if (!this.enabled()) return;
    const bot = await this.request<MaxUser>("GET", "me");
    if (!bot) {
      console.error("[max] Не удалось проверить токен бота");
      return;
    }
    console.log(`[max] Бот подключен: ${bot.username ? `@${bot.username}` : bot.name || bot.user_id}`);

    if (config.MAX_AUTO_SUBSCRIBE_WEBHOOK !== "true") return;
    if (!config.MAX_WEBHOOK_SECRET) {
      console.error("[max] Автоподписка отключена: задайте MAX_WEBHOOK_SECRET");
      return;
    }
    const webhookUrl = `${publicBaseUrl()}/api/max/webhook`;
    if (!webhookUrl.startsWith("https://")) {
      console.error("[max] Webhook требует PUBLIC_BASE_URL с HTTPS");
      return;
    }
    const result = await this.request<{ success: boolean; message?: string }>("POST", "subscriptions", {
      body: {
        url: webhookUrl,
        update_types: ["bot_started", "message_created", "message_callback"],
        secret: config.MAX_WEBHOOK_SECRET
      }
    });
    if (!result?.success) {
      console.error("[max] Не удалось зарегистрировать webhook:", result?.message || "неизвестная ошибка");
      return;
    }
    console.log(`[max] Webhook подключен: ${webhookUrl}`);
  }

  async handleUpdate(update: MaxUpdate) {
    if (update.update_type === "bot_started" && update.user) {
      await this.sendWelcome(update.user.user_id);
      return;
    }

    if (update.update_type === "message_created" && update.message) {
      const message = update.message;
      const userId = message.sender?.user_id;
      const image = message.body.attachments?.find((attachment) => attachment.type === "image");
      if (userId && image) {
        await this.handlePenaltyReceiptImage(userId, image.payload?.url || "");
        return;
      }
      const rawText = message.body.text?.trim();
      const text = rawText?.toLocaleLowerCase("ru-RU");
      if (!userId || !text || !rawText) return;
      if (["/start", "start", "/id", "id", "мой id", "помощь", "/help"].includes(text)) {
        await this.sendWelcome(userId);
        return;
      }
      if (["/shift", "начать смену"].includes(text)) {
        await this.showZonePicker(userId);
        return;
      }
      if (["/end_shift", "закончить смену"].includes(text)) {
        await this.finishShift(userId);
        return;
      }
      if (["/status", "моя смена"].includes(text)) {
        await this.sendShiftStatus(userId);
        return;
      }
      const waiter = this.store.findWaiterByMaxUserId(userId);
      const selectedRecordId = this.rolloverReasonDrafts.get(userId);
      if (waiter && selectedRecordId) {
        if (rawText.length < 3) {
          await this.sendMessage(String(userId), { text: "Причина слишком короткая. Опишите, что помешало выполнить задание." });
          return;
        }
        const saved = await this.store.setShiftTaskRolloverReason(selectedRecordId, waiter.id, rawText);
        if (saved) {
          this.rolloverReasonDrafts.delete(userId);
          await this.sendMessage(String(userId), { text: `✅ Причина переноса сохранена для задания «${saved.task.title}».` });
          return;
        }
        this.rolloverReasonDrafts.delete(userId);
      }
      if (waiter) {
        const pending = this.store.pendingShiftTaskRolloverReasons(waiter.id);
        if (pending.length === 1) {
          const saved = await this.store.setShiftTaskRolloverReason(pending[0].record.id, waiter.id, rawText);
          if (saved) {
            await this.sendMessage(String(userId), { text: `✅ Причина переноса сохранена для задания «${saved.task.title}».` });
            return;
          }
        }
        if (pending.length > 1) {
          await this.sendMessage(String(userId), { text: "Есть несколько перенесённых заданий. Нажмите «Указать причину» под нужным заданием, затем отправьте комментарий." });
          return;
        }
      }
      await this.sendWelcome(userId);
      return;
    }

    if (update.update_type !== "message_callback" || !update.callback) return;
    const payload = update.callback.payload || "";
    const callbackId = update.callback.callback_id;
    const userId = update.callback.user.user_id;
    if (payload === "shift:start") {
      await this.showZonePicker(userId, callbackId);
      return;
    }
    if (payload === "shift:status") {
      await this.sendShiftStatus(userId, callbackId);
      return;
    }
    if (payload === "shift:end") {
      await this.finishShift(userId, callbackId);
      return;
    }
    if (payload.startsWith("shift:zone:")) {
      await this.handleZoneSelection(callbackId, userId, payload.slice("shift:zone:".length));
      return;
    }
    if (payload.startsWith("check:")) {
      await this.handleChecklistCallback(callbackId, userId, payload);
      return;
    }
    if (payload.startsWith("task:complete:")) {
      await this.handleShiftTaskCallback(callbackId, userId, payload);
      return;
    }
    if (payload.startsWith("task:reason:")) {
      await this.handleShiftTaskReasonCallback(callbackId, userId, payload);
      return;
    }
    if (payload.startsWith("delivery:pickup:ack:")) {
      await this.handleDeliveryPickupAlertCallback(callbackId, userId, payload);
      return;
    }
    if (payload.startsWith("call:")) {
      await this.handleCallCallback(callbackId, userId, payload);
    }
  }

  private async handlePenaltyReceiptImage(userId: number, imageUrl: string) {
    const waiter = this.store.findWaiterByMaxUserId(userId);
    const shift = waiter ? this.store.latestUnpaidAdminPenaltyShift(waiter.id) : null;
    if (!waiter || !shift) {
      await this.sendMessage(String(userId), { text: "Фото получено, но у вас нет неоплаченного штрафа по завершённой смене администратора." });
      return;
    }
    let url: URL;
    try {
      url = new URL(imageUrl);
    } catch {
      await this.sendMessage(String(userId), { text: "MAX не передал ссылку на изображение. Отправьте чек в Telegram-бот или загрузите его в CRM." });
      return;
    }
    if (url.protocol !== "https:" || (url.hostname !== "max.ru" && !url.hostname.endsWith(".max.ru"))) {
      await this.sendMessage(String(userId), { text: "Не удалось безопасно получить изображение. Отправьте чек в Telegram-бот или загрузите его в CRM." });
      return;
    }
    const response = await fetch(url, { agent: this.httpsAgent });
    if (!response.ok) {
      await this.sendMessage(String(userId), { text: "Не удалось скачать скриншот. Отправьте фото ещё раз или используйте Telegram-бот." });
      return;
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length < 100 || body.length > 8 * 1024 * 1024) {
      await this.sendMessage(String(userId), { text: "Скриншот чека повреждён или превышает 8 МБ." });
      return;
    }
    const extension = body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      ? "jpg"
      : body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        ? "png"
        : body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP"
          ? "webp"
          : "";
    if (!extension) {
      await this.sendMessage(String(userId), { text: "Отправьте чек как JPG, PNG или WEBP фото." });
      return;
    }
    const mediaDir = this.store.reviewMediaDirectory();
    await mkdir(mediaDir, { recursive: true });
    const filename = `penalty-${Date.now()}-${randomUUID()}.${extension}`;
    await writeFile(path.join(mediaDir, filename), body);
    await this.store.attachAdminPenaltyReceipt(
      shift.id,
      waiter.id,
      `/api/admin/review-media/${filename}`,
      "max"
    );
    await this.sendMessage(String(userId), {
      text: `✅ Чек по штрафу ${shift.adminPenaltyAmount} ₽ сохранён в смене за ${shift.morningGreetingDate}.`
    });
  }

  async notifyCall(options: {
    call: ServiceCall;
    table: DiningTable;
    waiters: Waiter[];
    settings: VenueSettings;
  }) {
    const previous = this.callQueues.get(options.call.id) ?? Promise.resolve([]);
    const task = previous
      .catch(() => [])
      .then(async () => {
        const call = this.store.findCallById(options.call.id) ?? options.call;
        const table = this.store.findTableById(call.tableId) ?? options.table;
        return this.syncCallMessages(call, table, this.recipientsForCall(call, table), options.settings);
      });

    this.callQueues.set(options.call.id, task);
    try {
      return await task;
    } finally {
      if (this.callQueues.get(options.call.id) === task) this.callQueues.delete(options.call.id);
    }
  }

  async notifyAdminWarning(call: ServiceCall, table: DiningTable, admins: Waiter[]) {
    const refs: MaxMessageRef[] = [];
    for (const admin of admins) {
      const userId = admin.maxUserId.trim();
      if (!userId) continue;
      const sent = await this.sendMessage(userId, {
        text: `⏳ Осталась 1 минута\n${table.name}: вызов не принят. Через минуту уведомление получит владелец.`,
        attachments: this.keyboard([[this.callbackButton("Принято", `call:accepted:${call.id}`, "positive")]])
      });
      if (sent?.message.body.mid) {
        refs.push({
          userId,
          messageId: sent.message.body.mid,
          recipientRole: "admin",
          kind: "warning"
        });
      }
    }
    if (refs.length) await this.store.appendMaxMessages(call.id, refs);
    return refs;
  }

  async notifyDeliveryCorrectionApproval(admins: Waiter[], text: string) {
    if (!this.enabled()) return 0;
    let delivered = 0;
    for (const admin of admins) {
      const userId = admin.maxUserId.trim();
      if (!userId) continue;
      const sent = await this.sendMessage(userId, { text, notify: true });
      if (sent) delivered += 1;
    }
    return delivered;
  }

  async notifyDeliveryPickupAlert(recipients: Waiter[], alert: DeliveryPickupAlert) {
    if (!this.enabled()) return 0;
    let delivered = 0;
    for (const recipient of recipients) {
      const userId = recipient.maxUserId.trim();
      if (!userId) continue;
      const sent = await this.sendMessage(userId, {
        text: [
          "📦 Нужно вынести заказ курьеру",
          alert.message,
          `Заказ: ${alert.orderNumber}`,
          alert.etaMinutes === null ? "" : `Ожидаемое прибытие: через ${alert.etaMinutes} мин.`,
          "Способ: от подъезда до подъезда."
        ].filter(Boolean).join("\n"),
        attachments: this.keyboard([[
          this.callbackButton("✅ Принял, выношу", `delivery:pickup:ack:${alert.id}`, "positive")
        ]]),
        notify: true
      });
      if (sent) delivered += 1;
    }
    return delivered;
  }

  private async handleDeliveryPickupAlertCallback(callbackId: string, userId: number, data: string) {
    const waiter = this.store.findWaiterByMaxUserId(userId);
    if (!waiter?.active || !this.coordinator?.acknowledgeDeliveryPickupAlert) {
      await this.answerCallback(callbackId, "MAX не привязан к активному сотруднику");
      return;
    }
    const alertId = data.slice("delivery:pickup:ack:".length);
    const result = await this.coordinator.acknowledgeDeliveryPickupAlert(alertId, waiter.id);
    if (result.status === "forbidden") {
      await this.answerCallback(callbackId, "Уведомление назначено другому сотруднику");
      return;
    }
    if (result.status === "not_found") {
      await this.answerCallback(callbackId, "Уведомление уже недоступно");
      return;
    }
    if (result.status === "already_acknowledged") {
      await this.answerCallback(callbackId, `Уже принял: ${result.alert?.acknowledgedByName || "сотрудник"}`);
      return;
    }
    await this.answerCallback(callbackId, "Принято. Вынесите заказ ко входу.", {
      text: `✅ Заказ ${result.alert?.orderNumber || ""} закреплён за вами.`
    });
  }

  async notifyShiftTask(task: ShiftTask): Promise<boolean> {
    if (!task.waiterId) return false;
    const waiter = this.store.findWaiterById(task.waiterId);
    const userId = waiter?.maxUserId?.trim();
    if (!userId) return false;
    const sent = await this.sendMessage(userId, this.shiftTaskBody(task));
    return Boolean(sent);
  }

  async notifyShiftTaskRollover(task: ShiftTask, record: ShiftTaskRolloverRecord): Promise<boolean> {
    if (!task.waiterId) return false;
    const waiter = this.store.findWaiterById(task.waiterId);
    const userId = waiter?.maxUserId?.trim();
    if (!userId) return false;
    const sent = await this.sendMessage(userId, {
      text: shiftTaskRolloverText(task, record),
      attachments: this.keyboard([[
        this.callbackButton("✍️ Указать причину", `task:reason:${record.id}`, "positive")
      ]]),
      notify: true
    });
    return Boolean(sent);
  }

  async notifyClosingChecklistIncomplete(shift: WaiterShift) {
    if (!this.enabled()) return 0;
    const pending = shift.checklist.filter((item) => item.phase === "closing" && !item.completedAt);
    if (!pending.length) return 0;
    let delivered = 0;
    for (const admin of this.store.adminsForClosingShift(shift)) {
      const userId = admin.maxUserId.trim();
      if (!userId) continue;
      const sent = await this.sendMessage(userId, {
        text: [
          "⚠️ Не выполнен чек-лист закрытия",
          `Сотрудник: ${shift.waiterName} · ${shift.roleName}`,
          `Смена: ${shift.morningGreetingDate}`,
          `Не выполнено: ${pending.length}`,
          ...pending.slice(0, 8).map((item) => `• ${item.title}`),
          pending.length > 8 ? `• и ещё ${pending.length - 8}` : "",
          "Проверьте каждый пункт, добавьте фото и оценку в разделе «Контроль сотрудников»."
        ].filter(Boolean).join("\n")
      });
      if (sent) delivered += 1;
    }
    return delivered;
  }

  async notifyAdminShiftSummary(shift: WaiterShift) {
    if (!this.enabled() || shift.roleKind !== "admin") return 0;
    const admin = this.store.findWaiterById(shift.waiterId);
    const userId = admin?.maxUserId.trim();
    if (!userId) return 0;
    const card = this.store.snapshot().ownerNotifications.sberCardNumber.trim();
    const sent = await this.sendMessage(userId, {
      text: [
        "📊 Итоги смены администратора",
        `Дата: ${shift.morningGreetingDate}`,
        `Оценка: ${shift.score} из 5 ★`,
        shift.adminRatingPenaltyStars > 0 ? `Снижение за неподтверждённые пункты: −${shift.adminRatingPenaltyStars} ★` : "Неподтверждённых пунктов нет.",
        `Невыполненных пунктов сотрудников: ${shift.adminPenaltyItemCount}`,
        `Штраф: ${shift.adminPenaltyAmount} ₽`,
        shift.adminPenaltyAmount > 0
          ? card ? `Переведите штраф на карту СберБанка владельца: ${card}` : "Карта СберБанка владельца не указана. Обратитесь к владельцу."
          : "Штраф не начислен.",
        shift.adminPenaltyAmount > 0 ? "После перевода отправьте скриншот чека в Telegram-бот или загрузите его в CRM." : ""
      ].filter(Boolean).join("\n")
    });
    return sent ? 1 : 0;
  }

  private shiftTaskBody(task: ShiftTask): MaxMessageBody {
    const roleLabel = this.store.findRole(task.roleId)?.name || "Должность";
    return {
      text: shiftTaskText(task, roleLabel),
      attachments: task.completedAt
        ? []
        : this.keyboard([[
            this.callbackButton("✅ Отметить выполненным", `task:complete:${task.id}`, "positive")
          ]])
    };
  }

  async closeCallMessages(call: ServiceCall) {
    for (const message of call.maxMessages) {
      await this.request("DELETE", "messages", { query: { message_id: message.messageId } });
    }
    await this.store.replaceMaxMessages(call.id, []);
  }

  private async handleCallCallback(callbackId: string, userId: number, data: string) {
    const waiter = this.store.findWaiterByMaxUserId(userId);
    if (!waiter?.active) {
      await this.answerCallback(callbackId, "MAX не привязан к активному сотруднику");
      return;
    }

    const [, action, callId] = data.split(":");
    if (!callId) return;
    if (action === "accepted") {
      const result = await this.store.acceptCall(callId, waiter.id);
      if (!result) {
        await this.answerCallback(callbackId, "Вызов не найден");
        return;
      }
      if (!result.allowed) {
        await this.answerCallback(callbackId, "Этот вызов назначен другому сотруднику");
        return;
      }
      const acceptedBy = result.call.lastAcceptedByStaffId
        ? this.store.findWaiterById(result.call.lastAcceptedByStaffId)?.name
        : "другой сотрудник";
      await this.answerCallback(
        callbackId,
        result.accepted ? "Вызов принят" : `Уже принял: ${acceptedBy || "другой сотрудник"}`
      );
      if (this.coordinator) await this.coordinator.syncCall(result.call);
      else {
        const table = this.store.findTableById(result.call.tableId);
        if (table) {
          await this.notifyCall({
            call: result.call,
            table,
            waiters: this.store.waitersForTable(table),
            settings: this.store.snapshot().settings
          });
        }
      }
      return;
    }

    if (action === "ack") {
      const current = this.store.findCallById(callId);
      const roleKind = this.store.roleForWaiter(waiter)?.kind;
      const acknowledgementRole =
        current?.routingStage === "admin" && roleKind === "admin"
          ? "admin"
          : current?.routingStage === "owner" && roleKind === "owner"
            ? "owner"
            : null;
      const call = acknowledgementRole
        ? await this.store.acknowledgeEscalation(callId, acknowledgementRole)
        : null;
      if (!call) {
        await this.answerCallback(callbackId, "Эскалация уже закрыта или назначена другому сотруднику");
        return;
      }
      await this.answerCallback(callbackId, "Контроль подтвержден");
      if (this.coordinator) await this.coordinator.syncCall(call);
      else {
        const table = this.store.findTableById(call.tableId);
        if (table) {
          await this.notifyCall({
            call,
            table,
            waiters: this.store.waitersForTable(table),
            settings: this.store.snapshot().settings
          });
        }
      }
      return;
    }

    if (action !== "done") return;
    const current = this.store.findCallById(callId);
    if (!current || current.status !== "accepted") {
      await this.answerCallback(callbackId, "Вызов уже закрыт");
      return;
    }
    const call = await this.store.completeCall(callId);
    await this.answerCallback(callbackId, "Стол убран из чата");
    if (!call) return;
    if (this.coordinator) await this.coordinator.closeCall(call);
    else await this.closeCallMessages(call);
  }

  private async sendWelcome(userId: number) {
    const waiter = this.store.findWaiterByMaxUserId(userId);
    if (!waiter?.active) {
      await this.sendMessage(String(userId), {
        text: [
          "QR на стол — подключение к MAX",
          "",
          `Ваш MAX user_id: ${userId}`,
          "Передайте этот номер администратору. Он укажет его в карточке сотрудника."
        ].join("\n")
      });
      return;
    }

    const shift = this.store.currentShiftForWaiter(waiter.id);
    const role = this.store.roleForWaiter(waiter);
    const status = shift
      ? shift.status === "active"
        ? "Смена активна, уведомления включены."
        : "Смена начата, завершите обязательный чек-лист."
      : "Смена сейчас не начата.";
    await this.sendMessage(String(userId), {
      text: [
        `Здравствуйте, ${waiter.name}!`,
        `Должность: ${role?.name || "Сотрудник"}`,
        status,
        "",
        "Управляйте сменой кнопками ниже.",
        `Ваш MAX user_id: ${userId}`
      ].join("\n"),
      attachments: this.menuKeyboard(Boolean(shift))
    });
  }

  private async showZonePicker(userId: number, callbackId?: string) {
    const waiter = await this.requireWaiter(userId, callbackId);
    if (!waiter) return;

    const current = this.store.currentShiftForWaiter(waiter.id);
    if (current) {
      await this.sendChecklist(userId, current, callbackId, "Смена уже начата.");
      return;
    }

    const zones = this.store.listZones();
    if (!zones.length) {
      await this.respond(userId, callbackId, {
        text: "В админке пока нет столов с этажами или зонами.",
        attachments: this.menuKeyboard(false)
      });
      return;
    }

    const buttons = zones.map((zone, index) => [
      this.callbackButton(zone, `shift:zone:${index}`)
    ]);
    if (zones.length > 1) buttons.push([this.callbackButton("Все этажи", "shift:zone:all")]);
    await this.respond(userId, callbackId, {
      text: "На каком этаже вы начинаете смену?",
      attachments: this.keyboard(buttons)
    });
  }

  private async handleZoneSelection(callbackId: string, userId: number, selection: string) {
    const waiter = await this.requireWaiter(userId, callbackId);
    if (!waiter) return;

    const zones = this.store.listZones();
    const selectedZones = selection === "all" ? zones : [zones[Number(selection)]].filter(Boolean);
    if (!selectedZones.length) {
      await this.answerCallback(callbackId, "Список этажей изменился. Нажмите «Начать смену» заново.");
      return;
    }

    const result = await this.store.startWaiterShift(waiter.id, selectedZones);
    if (!result) {
      await this.answerCallback(callbackId, "Не удалось начать смену");
      return;
    }

    await this.answerCallback(
      callbackId,
      result.created ? "Смена начата" : "Смена уже активна",
      this.checklistBody(result.shift)
    );
    if (result.created && result.firstShiftToday) await this.sendMorningGreeting(userId, waiter);
    await this.sendMessage(String(userId), {
      text: shiftStartedText(result.shift),
      attachments: this.menuKeyboard(true)
    });
    if (result.shift.status === "active" && result.shift.roleKind === "waiter") {
      await this.deliverPendingCalls(waiter.id);
    }
  }

  private async sendMorningGreeting(userId: number, waiter: Waiter) {
    const role = this.store.roleForWaiter(waiter);
    if (role?.kind === "admin") {
      await this.sendMessage(String(userId), {
        text: `Доброе утро, ${waiter.name}!\nЖелаем спокойной и успешной смены.`
      });
      return;
    }

    const ratings = this.store.waiterRatings(waiter.roleId);
    const ranking = ratings.length
      ? ratings.map((item) =>
          item.shiftCount
            ? `${item.rank}. ${item.waiterName} — ${item.score} ★ (${item.shiftCount} смен, всего ${item.totalStars} ★)`
            : `${item.rank}. ${item.waiterName} — пока нет завершенных смен`
        ).join("\n")
      : "Рейтинг появится после первой завершенной смены.";
    await this.sendMessage(String(userId), {
      text: [
        `Доброе утро, ${waiter.name}!`,
        "Желаем спокойной и успешной смены.",
        "",
        `Рейтинг подразделения «${role?.name || "Команда"}»:`,
        ranking
      ].join("\n")
    });
  }

  private checklistBody(shift: WaiterShift, prefix = ""): MaxMessageBody {
    const buttons = shift.checklist
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.completedAt)
      .map(({ index }) => [
        this.callbackButton(`Сделано: пункт ${index + 1}`, `check:${shift.id}:${index}`, "positive")
      ]);
    return {
      text: [prefix, shiftChecklistText(
        shift,
        this.store.snapshot().checklistWindows,
        config.VENUE_TIME_ZONE
      )].filter(Boolean).join("\n\n"),
      attachments: this.keyboard(buttons)
    };
  }

  private async sendChecklist(userId: number, shift: WaiterShift, callbackId?: string, prefix = "") {
    await this.respond(userId, callbackId, this.checklistBody(shift, prefix));
  }

  private async handleChecklistCallback(callbackId: string, userId: number, data: string) {
    const waiter = await this.requireWaiter(userId, callbackId);
    if (!waiter) return;

    const [, shiftId, rawIndex] = data.split(":");
    const before = this.store.findShiftById(shiftId);
    const result = await this.store.completeShiftChecklistItem(shiftId, waiter.id, Number(rawIndex));
    if (result.status === "not_found") {
      await this.answerCallback(callbackId, "Пункт или смена не найдены");
      return;
    }
    if (result.status === "already_completed") {
      await this.answerCallback(callbackId, "Этот пункт уже отмечен");
      return;
    }
    if (result.status === "cooldown") {
      await this.answerCallback(callbackId, `Следующий пункт можно отметить через ${result.retryAfterSeconds} сек.`);
      return;
    }
    if (result.status === "outside_window") {
      const meta = CHECKLIST_PHASE_META[result.phase];
      await this.answerCallback(
        callbackId,
        result.windowStatus === "not_started"
          ? `${meta.shortTitle}: заполнение доступно с ${result.window.start} до ${result.window.end}`
          : `${meta.shortTitle}: время заполнения ${formatChecklistWindow(result.window)} уже истекло`
      );
      return;
    }

    const shift = result.shift;
    await this.answerCallback(callbackId, "Отмечено", this.checklistBody(shift));
    if (before?.status !== "active" && shift.status === "active") {
      await this.sendMessage(String(userId), {
        text: "Все обязательные пункты выполнены. Чек-лист смены завершен.",
        attachments: this.menuKeyboard(true)
      });
      if (shift.roleKind === "waiter") await this.deliverPendingCalls(waiter.id);
    }
  }

  private async handleShiftTaskCallback(callbackId: string, userId: number, data: string) {
    const waiter = await this.requireWaiter(userId, callbackId);
    if (!waiter) return;

    const taskId = data.slice("task:complete:".length);
    const before = this.store.currentShiftForWaiter(waiter.id);
    const result = await this.store.completeShiftTask(taskId, waiter.id);
    if (result.status === "not_found") {
      await this.answerCallback(callbackId, "Задание не найдено или назначено другому сотруднику");
      return;
    }

    await this.answerCallback(
      callbackId,
      result.status === "completed" ? "Задание выполнено" : "Задание уже отмечено",
      this.shiftTaskBody(result.task)
    );

    const shift = this.store.currentShiftForWaiter(waiter.id);
    if (before?.status !== "active" && shift?.status === "active") {
      await this.sendMessage(String(userId), {
        text: "Все обязательные пункты выполнены. Чек-лист смены завершен.",
        attachments: this.menuKeyboard(true)
      });
      if (shift.roleKind === "waiter") await this.deliverPendingCalls(waiter.id);
    }
  }

  private async handleShiftTaskReasonCallback(callbackId: string, userId: number, data: string) {
    const waiter = await this.requireWaiter(userId, callbackId);
    if (!waiter) return;
    const recordId = data.slice("task:reason:".length);
    const pending = this.store.findPendingShiftTaskRolloverReason(recordId, waiter.id);
    if (!pending) {
      await this.answerCallback(callbackId, "Причина уже сохранена или перенос не найден");
      return;
    }
    this.rolloverReasonDrafts.set(userId, recordId);
    await this.answerCallback(callbackId, "Отправьте причину одним сообщением");
    await this.sendMessage(String(userId), {
      text: `Почему не выполнено задание «${pending.task.title}»? Отправьте причину одним сообщением до 500 символов.`
    });
  }

  private async deliverPendingCalls(waiterId: string) {
    const settings = this.store.snapshot().settings;
    for (const call of this.store.pendingCallsForWaiter(waiterId)) {
      const table = this.store.findTableById(call.tableId);
      if (!table) continue;
      if (this.coordinator) await this.coordinator.syncCall(call);
      else {
        await this.notifyCall({
          call,
          table,
          waiters: this.store.waitersForTable(table),
          settings
        });
      }
    }
  }

  private async sendShiftStatus(userId: number, callbackId?: string) {
    const waiter = await this.requireWaiter(userId, callbackId);
    if (!waiter) return;
    const shift = this.store.currentShiftForWaiter(waiter.id);
    if (!shift) {
      await this.respond(userId, callbackId, {
        text: "Смена не начата. Нажмите «Начать смену».",
        attachments: this.menuKeyboard(false)
      });
      return;
    }
    await this.sendChecklist(userId, shift, callbackId);
  }

  private async finishShift(userId: number, callbackId?: string) {
    const waiter = await this.requireWaiter(userId, callbackId);
    if (!waiter) return;
    const result: ShiftEndResult = await this.store.requestEndWaiterShift(waiter.id);
    if (result.status === "not_found") {
      await this.respond(userId, callbackId, {
        text: "У вас нет активной смены.",
        attachments: this.menuKeyboard(false)
      });
      return;
    }
    if (result.status === "closing_checklist_incomplete") {
      await this.sendChecklist(userId, result.shift, callbackId, `Смена не завершена: выполните чек-лист закрытия (${result.pendingCount} пунктов).`);
      if (result.shift.roleKind === "waiter" || result.shift.roleId === "barista") {
        if (this.coordinator?.notifyClosingChecklistIncomplete) await this.coordinator.notifyClosingChecklistIncomplete(result.shift);
        else await this.notifyClosingChecklistIncomplete(result.shift);
      }
      return;
    }
    if (result.status === "employee_shifts_active") {
      await this.respond(userId, callbackId, {
        text: `Смена не завершена: сначала дождитесь завершения ${result.activeCount} смен официантов или бариста.`,
        attachments: this.menuKeyboard(true)
      });
      return;
    }
    if (result.status === "admin_reviews_incomplete") {
      await this.respond(userId, callbackId, {
        text: `Смена не завершена. В разделе «Контроль сотрудников» добавьте фото и оценку ещё к ${result.missingCount} пунктам чек-листов закрытия официантов и бариста.`,
        attachments: this.menuKeyboard(true)
      });
      return;
    }
    const shift = result.shift;

    await this.clearWaiterCallMessages(waiter);
    await this.respond(userId, callbackId, {
      text: shift.checklist.some((item) => item.countsForRating !== false)
        ? `Смена завершена. Столы сняты, уведомления отключены.\nРейтинг смены: ${shift.score} из 5 ★.`
        : "Смена завершена. Столы сняты, уведомления отключены.\nВ этой смене не было заданий, влияющих на рейтинг.",
      attachments: this.menuKeyboard(false)
    });
    if (shift.roleKind === "admin") {
      if (this.coordinator?.notifyAdminShiftSummary) await this.coordinator.notifyAdminShiftSummary(shift);
      else await this.notifyAdminShiftSummary(shift);
    }
    if (this.coordinator?.processEndedShiftTasks) {
      await this.coordinator.processEndedShiftTasks(shift);
    } else {
      const carried = await this.store.rolloverIncompleteShiftTasksForShift(
        shift.id,
        nextDateKey(shift.morningGreetingDate)
      );
      for (const task of carried) {
        const record = [...(task.rolloverHistory || [])].at(-1);
        if (record) await this.notifyShiftTaskRollover(task, record);
      }
    }
  }

  private recipientsForCall(call: ServiceCall, table: DiningTable) {
    const recipients: Array<{ member: Waiter; recipientRole: "waiter" | "admin" | "owner" }> = [];
    if (call.routingStage === "waiter") {
      recipients.push(...this.store.waitersForTable(table).map((member) => ({ member, recipientRole: "waiter" as const })));
    } else if (call.routingStage === "admin") {
      recipients.push(
        ...this.store.activeAdminsForTable(table).map((member) => ({ member, recipientRole: "admin" as const }))
      );
    } else {
      recipients.push(
        ...this.store.ownersForEscalation().map((member) => ({ member, recipientRole: "owner" as const }))
      );
    }
    const unique = new Map(recipients.map((recipient) => [recipient.member.maxUserId.trim(), recipient]));
    return Array.from(unique.values()).filter((recipient) => recipient.member.maxUserId.trim());
  }

  private callText(call: ServiceCall, table: DiningTable, settings: VenueSettings) {
    const latestLabel = call.actionLabel || "Вызов официанта";
    const latestReason = `${callReasonIcon(latestLabel)} ${latestLabel}`;
    const reasons = call.reasonCounts
      .map((reason) => `${reason.actionId === call.actionId ? "➡️" : "•"} ${reason.label} — ${reason.count}`)
      .join("\n");
    const acceptedBy = call.lastAcceptedByStaffId
      ? this.store.findWaiterById(call.lastAcceptedByStaffId)?.name
      : "";
    const status = call.status === "new"
      ? "🔴 ОЖИДАЕТ ПРИНЯТИЯ"
      : call.status === "accepted"
        ? `🟢 Принял: ${acceptedBy || "сотрудник"}`
        : "⚪ Завершён";
    const callHeading = call.status === "new"
      ? ["🟥🟥🟥 НОВЫЙ ВЫЗОВ 🟥🟥🟥", `🚨 ПОСЛЕДНИЙ ЗАПРОС: ${latestReason.toLocaleUpperCase("ru-RU")}`]
      : ["✅ ВЫЗОВ ПРИНЯТ", `Последний запрос: ${latestReason}`];
    const routingTitle = call.routingStage === "owner"
      ? "🚨 Эскалация владельцу"
      : call.routingStage === "admin"
        ? "⚠️ Вызов перенаправлен администратору"
        : `🔔 ${settings.name}`;
    return [
      ...callHeading,
      "",
      routingTitle,
      "",
      `Стол: ${table.name}${table.zone ? `, ${table.zone}` : ""}`,
      "Причины:",
      reasons,
      call.guestName ? `Гость: ${call.guestName}` : "",
      call.comment ? `Комментарий: ${call.comment}` : "",
      call.routingStage !== "waiter" && call.routingReason ? `Причина перенаправления: ${call.routingReason}` : "",
      call.routingStage === "admin" && call.adminAcknowledgedAt ? "Администратор подтвердил контроль вызова." : "",
      call.routingStage === "owner" && call.ownerAcknowledgedAt ? "Владелец подтвердил контроль вызова." : "",
      "",
      `Количество вызовов: ${call.pressCount}`,
      `Первый вызов: ${formatTime(call.cycleStartedAt)}`,
      `Последний вызов: ${formatTime(call.lastRequestedAt)}`,
      `Статус: ${status}`
    ].filter(Boolean).join("\n");
  }

  private callButtons(call: ServiceCall): MaxButton[][] {
    if (call.status === "new") {
      return [[this.callbackButton("Принято", `call:accepted:${call.id}`, "positive")]];
    }
    if (call.status === "accepted") {
      const needsEscalationAcknowledgement =
        (call.routingStage === "admin" && !call.adminAcknowledgedAt) ||
        (call.routingStage === "owner" && !call.ownerAcknowledgedAt);
      if (needsEscalationAcknowledgement) {
        return [
          [this.callbackButton("Подтвердить контроль", `call:ack:${call.id}`, "positive")],
          [this.callbackButton("Готово", `call:done:${call.id}`, "positive")]
        ];
      }
      return [[this.callbackButton("Готово", `call:done:${call.id}`, "positive")]];
    }
    return [];
  }

  private async syncCallMessages(
    call: ServiceCall,
    table: DiningTable,
    recipients: Array<{ member: Waiter; recipientRole: "waiter" | "admin" | "owner" }>,
    settings: VenueSettings
  ) {
    const text = this.callText(call, table, settings);
    if (!this.enabled()) {
      console.log("[max disabled] waiter call:", text);
      return [];
    }

    const targetKeys = new Set(
      recipients.map((recipient) => `${recipient.member.maxUserId.trim()}:${recipient.recipientRole}`)
    );
    const allWarningRefs = call.maxMessages.filter((message) => message.kind === "warning");
    const warningRefs = call.adminWarningSentAt ? allWarningRefs : [];
    if (!call.adminWarningSentAt) {
      for (const message of allWarningRefs) {
        await this.request("DELETE", "messages", { query: { message_id: message.messageId } });
      }
    }
    const primaryRefs = call.maxMessages.filter((message) => message.kind === "call");
    const existingByTarget = new Map(
      primaryRefs.map((message) => [`${message.userId}:${message.recipientRole}`, message])
    );

    for (const message of primaryRefs) {
      if (!targetKeys.has(`${message.userId}:${message.recipientRole}`)) {
        await this.request("DELETE", "messages", { query: { message_id: message.messageId } });
      }
    }

    const refs: MaxMessageRef[] = [];
    for (const recipient of recipients) {
      const userId = recipient.member.maxUserId.trim();
      if (!userId) continue;
      const body: MaxMessageBody = {
        text,
        attachments: this.keyboard(this.callButtons(call)),
        notify: true
      };
      const existing = existingByTarget.get(`${userId}:${recipient.recipientRole}`);
      if (existing) {
        const edited = await this.request<{ success: boolean }>("PUT", "messages", {
          query: { message_id: existing.messageId },
          body
        });
        if (edited?.success) {
          refs.push(existing);
          continue;
        }
      }

      const sent = await this.sendMessage(userId, body);
      if (sent?.message.body.mid) {
        refs.push({
          userId,
          messageId: sent.message.body.mid,
          recipientRole: recipient.recipientRole,
          kind: "call"
        });
      }
    }

    await this.store.replaceMaxMessages(call.id, [...warningRefs, ...refs]);
    return refs;
  }

  private callbackButton(text: string, payload: string, intent: MaxButton["intent"] = "default"): MaxButton {
    return { type: "callback", text, payload, intent };
  }

  private keyboard(buttons: MaxButton[][]): MaxMessageBody["attachments"] {
    return buttons.length ? [{ type: "inline_keyboard", payload: { buttons } }] : [];
  }

  private menuKeyboard(hasShift: boolean): MaxMessageBody["attachments"] {
    const buttons = hasShift
      ? [
          [this.callbackButton("Моя смена", "shift:status")],
          [this.callbackButton("Закончить смену", "shift:end", "negative")]
        ]
      : [[this.callbackButton("Начать смену", "shift:start", "positive")]];
    return this.keyboard(buttons);
  }

  private async respond(userId: number, callbackId: string | undefined, body: MaxMessageBody) {
    if (callbackId) {
      await this.answerCallback(callbackId, undefined, body);
      return;
    }
    await this.sendMessage(String(userId), body);
  }

  private async clearWaiterCallMessages(waiter: Waiter) {
    const refs = this.store.activeCallMessagesForMaxUser(waiter.maxUserId);
    for (const ref of refs) {
      await this.request("DELETE", "messages", { query: { message_id: ref.messageId } });
    }
    await this.store.removeMaxMessagesForUser(waiter.maxUserId);
  }

  private async requireWaiter(userId: number, callbackId?: string) {
    const waiter = this.store.findWaiterByMaxUserId(userId);
    if (waiter?.active) return waiter;

    if (callbackId) await this.answerCallback(callbackId, "MAX не привязан к активному сотруднику");
    else await this.sendWelcome(userId);
    return null;
  }

  private async sendMessage(userId: string, body: MaxMessageBody) {
    return this.request<{ message: MaxMessage }>("POST", "messages", {
      query: { user_id: userId },
      body
    });
  }

  private async answerCallback(callbackId: string, notification?: string, message?: MaxMessageBody) {
    await this.request("POST", "answers", {
      query: { callback_id: callbackId },
      body: {
        ...(notification ? { notification } : {}),
        ...(message ? { message } : {})
      }
    });
  }

  private async request<T>(method: string, endpoint: string, options: MaxApiRequest = {}): Promise<T | null> {
    if (!this.enabled()) return null;
    const baseUrl = this.apiBaseUrl.endsWith("/") ? this.apiBaseUrl : `${this.apiBaseUrl}/`;
    const url = new URL(endpoint, baseUrl);
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: this.token,
          ...(options.body === undefined ? {} : { "content-type": "application/json" })
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        agent: this.httpsAgent
      });
    } catch (error) {
      console.error(`[max] ${method} /${endpoint}:`, error instanceof Error ? error.message : error);
      return null;
    }
    const raw = await response.text();
    let result: unknown = null;
    try {
      result = raw ? JSON.parse(raw) : null;
    } catch {
      result = null;
    }
    if (!response.ok) {
      const message = result && typeof result === "object" && "message" in result
        ? String((result as { message?: unknown }).message || response.statusText)
        : response.statusText;
      console.error(`[max] ${method} /${endpoint}: ${response.status} ${message}`);
      return null;
    }
    return result as T;
  }
}
