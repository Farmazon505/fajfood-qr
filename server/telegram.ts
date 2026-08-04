import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { venueOperationalDateKey, type ShiftEndResult, type Store } from "./store";
import type {
  DeliveryPickupAlert,
  DiningTable,
  ServiceCall,
  ShiftTask,
  ShiftTaskRolloverRecord,
  TelegramMessageRef,
  VenueSettings,
  Waiter,
  WaiterShift
} from "./types";
import { config, publicBaseUrl } from "./config";
import type { CrmStaffReservation } from "./crm-reservations";
import { generatePerformanceInsights } from "./performance-ai";
import { shiftChecklistText, shiftStartedText, shiftTaskRolloverText, shiftTaskText } from "./shift-messages";
import { CHECKLIST_PHASE_META, formatChecklistWindow } from "../shared/checklists";
import { nextDateKey } from "../shared/shift-tasks";

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number | string };
  text?: string;
  photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    data?: string;
    message?: TelegramMessage;
  };
};

type TelegramCallCoordinator = {
  syncCall(call: ServiceCall): Promise<void>;
  closeCall(call: ServiceCall): Promise<void>;
  notifyClosingChecklistIncomplete?(shift: WaiterShift): Promise<void>;
  notifyAdminShiftSummary?(shift: WaiterShift): Promise<void>;
  processEndedShiftTasks?(shift: WaiterShift): Promise<ShiftTask[]>;
  acknowledgeDeliveryPickupAlert?(alertId: string, waiterId: string): Promise<any>;
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

const REPEAT_ALERT_LIFETIME_MS = 8_000;

const menuKeyboard = {
  keyboard: [
    [{ text: "Брони столов", web_app: { url: `${publicBaseUrl()}/staff/reservations` } }],
    [{ text: "Начать смену" }, { text: "Закончить смену" }],
    [{ text: "Моя смена" }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

export class TelegramService {
  private token: string;
  private offset = 0;
  private polling = false;
  private escalationTimer: ReturnType<typeof setInterval> | null = null;
  private escalationRunning = false;
  private callQueues = new Map<string, Promise<TelegramMessageRef[]>>();
  private rolloverReasonDrafts = new Map<string, string>();
  private coordinator: TelegramCallCoordinator | null = null;

  constructor(
    private store: Store,
    token = config.TELEGRAM_BOT_TOKEN,
    private repeatAlertLifetimeMs = REPEAT_ALERT_LIFETIME_MS
  ) {
    this.token = token;
  }

  enabled() {
    return Boolean(this.token.trim());
  }

  setCallCoordinator(coordinator: TelegramCallCoordinator) {
    this.coordinator = coordinator;
  }

  async closeCallMessages(call: ServiceCall) {
    await this.deleteCallMessages(call);
  }

  async notifyCall(options: {
    call: ServiceCall;
    table: DiningTable;
    waiters: Waiter[];
    settings: VenueSettings;
  }) {
    const notificationEvent = options.call;
    const previous = this.callQueues.get(options.call.id) ?? Promise.resolve([]);
    const task = previous
      .catch(() => [])
      .then(async () => {
        const call = this.store.findCallById(options.call.id) ?? options.call;
        const table = this.store.findTableById(call.tableId) ?? options.table;
        return this.syncCallMessages(
          call,
          table,
          this.recipientsForCall(call, table),
          options.settings,
          notificationEvent
        );
      });

    this.callQueues.set(options.call.id, task);
    try {
      return await task;
    } finally {
      if (this.callQueues.get(options.call.id) === task) this.callQueues.delete(options.call.id);
    }
  }

  startPolling(manageEscalations = true) {
    if (!this.enabled()) return;
    void this.configureBot();
    if (manageEscalations && !this.escalationTimer) {
      this.escalationTimer = setInterval(() => void this.processEscalations(), 15_000);
      this.escalationTimer.unref();
      void this.processEscalations();
    }
    if (!this.polling && config.TELEGRAM_ENABLE_POLLING === "true") {
      this.polling = true;
      void this.pollLoop();
    }
  }

  async processEscalations(at = Date.now()) {
    if (this.escalationRunning) return;
    this.escalationRunning = true;
    try {
      for (const dueCall of this.store.callsDueForAdminEscalation(at)) {
        const table = this.store.findTableById(dueCall.tableId);
        if (!table) continue;
        const reason = dueCall.status === "accepted"
          ? "Официант принял вызов, но не завершил его в течение 2 минут."
          : "Официант не принял вызов в течение 1 минуты.";
        const admins = this.store.activeAdminsForTable(table);
        if (!admins.length) {
          const ownerCall = await this.store.markOwnerEscalated(
            dueCall.id,
            `${reason} Администратор не в сети.`,
            new Date(at)
          );
          if (ownerCall) {
            await this.notifyCall({
              call: ownerCall,
              table,
              waiters: [],
              settings: this.store.snapshot().settings
            });
          }
          continue;
        }

        const adminCall = await this.store.startAdminEscalation(
          dueCall.id,
          reason,
          admins.map((admin) => admin.id),
          new Date(at)
        );
        if (!adminCall) continue;
        const refs = await this.notifyCall({
          call: adminCall,
          table,
          waiters: [],
          settings: this.store.snapshot().settings
        });
        if (refs.length) continue;

        const ownerCall = await this.store.markOwnerEscalated(
          adminCall.id,
          `${reason} Уведомление администратору не доставлено.`,
          new Date(at)
        );
        if (ownerCall) {
          await this.notifyCall({
            call: ownerCall,
            table,
            waiters: [],
            settings: this.store.snapshot().settings
          });
        }
      }

      for (const dueCall of this.store.callsDueForOwnerEscalation(at)) {
        const call = await this.store.markOwnerEscalated(
          dueCall.id,
          `${dueCall.routingReason} Администратор не подтвердил вызов в течение 1 минуты.`.trim(),
          new Date(at)
        );
        const table = call ? this.store.findTableById(call.tableId) : null;
        if (!call || !table) continue;
        await this.notifyCall({
          call,
          table,
          waiters: [],
          settings: this.store.snapshot().settings
        });
      }

      for (const task of this.store.getShiftTasksForNotification(venueOperationalDateKey(new Date(at)))) {
        if (await this.notifyShiftTask(task)) {
          await this.store.markShiftTaskNotified(task.id);
        }
      }
    } finally {
      this.escalationRunning = false;
    }
  }

  async notifyAdminWarning(call: ServiceCall, table: DiningTable, admins: Waiter[]) {
    const refs: TelegramMessageRef[] = [];
    for (const admin of admins) {
      const chatId = admin.telegramChatId.trim();
      if (!chatId) continue;
      const sent = await this.request<TelegramMessage>("sendMessage", {
        chat_id: chatId,
        text: `⏳ Осталась 1 минута\n${table.name}: вызов не принят. Через минуту уведомление получит владелец.`,
        reply_markup: this.callKeyboard(call)
      });
      if (sent?.message_id) {
        refs.push({
          chatId: String(sent.chat.id),
          messageId: sent.message_id,
          recipientRole: "admin",
          kind: "warning"
        });
      }
    }
    if (refs.length) await this.store.appendTelegramMessages(call.id, refs);
    return refs;
  }

  async notifyOwnerAlert(text: string) {
    if (!this.enabled()) return 0;
    const chatIds = Array.from(new Set(
      this.store.ownersForEscalation().map((owner) => owner.telegramChatId.trim()).filter(Boolean)
    ));
    let delivered = 0;
    for (const chatId of chatIds) {
      const sent = await this.request<TelegramMessage>("sendMessage", {
        chat_id: chatId,
        text,
        disable_notification: false
      });
      if (sent?.message_id) delivered += 1;
    }
    return delivered;
  }

  async notifyDeliveryCorrectionApproval(admins: Waiter[], text: string) {
    if (!this.enabled()) return 0;
    let delivered = 0;
    for (const admin of admins) {
      const chatId = admin.telegramChatId.trim();
      if (!chatId) continue;
      const sent = await this.request<TelegramMessage>("sendMessage", {
        chat_id: chatId,
        text,
        disable_notification: false
      });
      if (sent?.message_id) delivered += 1;
    }
    return delivered;
  }

  async notifyDeliveryPickupAlert(recipients: Waiter[], alert: DeliveryPickupAlert) {
    if (!this.enabled()) return 0;
    let delivered = 0;
    for (const recipient of recipients) {
      const chatId = recipient.telegramChatId.trim();
      if (!chatId) continue;
      const sent = await this.request<TelegramMessage>("sendMessage", {
        chat_id: chatId,
        text: [
          "📦 Нужно вынести заказ курьеру",
          alert.message,
          `Заказ: ${alert.orderNumber}`,
          alert.etaMinutes === null ? "" : `Ожидаемое прибытие: через ${alert.etaMinutes} мин.`,
          "Способ: от подъезда до подъезда."
        ].filter(Boolean).join("\n"),
        disable_notification: false,
        reply_markup: {
          inline_keyboard: [[{
            text: "✅ Принял, выношу",
            callback_data: `delivery:pickup:ack:${alert.id}`
          }]]
        }
      });
      if (sent?.message_id) delivered += 1;
    }
    return delivered;
  }

  private async handleDeliveryPickupAlertCallback(callbackId: string, message: TelegramMessage, data: string) {
    const waiter = this.store.findWaiterByChatId(message.chat.id);
    if (!waiter?.active || !this.coordinator?.acknowledgeDeliveryPickupAlert) {
      await this.answerCallback(callbackId, "Telegram не привязан к активному сотруднику", true);
      return;
    }
    const alertId = data.slice("delivery:pickup:ack:".length);
    const result = await this.coordinator.acknowledgeDeliveryPickupAlert(alertId, waiter.id);
    if (result.status === "forbidden") {
      await this.answerCallback(callbackId, "Уведомление назначено другому сотруднику", true);
      return;
    }
    if (result.status === "not_found") {
      await this.answerCallback(callbackId, "Уведомление уже недоступно", true);
      return;
    }
    if (result.status === "already_acknowledged") {
      await this.answerCallback(callbackId, `Уже принял: ${result.alert?.acknowledgedByName || "сотрудник"}`);
      return;
    }
    await this.answerCallback(callbackId, "Принято. Вынесите заказ ко входу.");
    await this.sendText(message.chat.id, `✅ Заказ ${result.alert?.orderNumber || ""} закреплён за вами.`);
  }

  async notifyClosingChecklistIncomplete(shift: WaiterShift) {
    if (!this.enabled()) return 0;
    const pending = shift.checklist.filter((item) => item.phase === "closing" && !item.completedAt);
    if (!pending.length) return 0;
    let delivered = 0;
    for (const admin of this.store.adminsForClosingShift(shift)) {
      const chatId = admin.telegramChatId.trim();
      if (!chatId) continue;
      const sent = await this.request<TelegramMessage>("sendMessage", {
        chat_id: chatId,
        text: [
          "⚠️ Не выполнен чек-лист закрытия",
          `Сотрудник: ${shift.waiterName} · ${shift.roleName}`,
          `Смена: ${shift.morningGreetingDate}`,
          `Не выполнено: ${pending.length}`,
          ...pending.slice(0, 8).map((item) => `• ${item.title}`),
          pending.length > 8 ? `• и ещё ${pending.length - 8}` : "",
          "Проверьте каждый пункт, добавьте фото и оценку в разделе «Контроль сотрудников»."
        ].filter(Boolean).join("\n"),
        disable_notification: false
      });
      if (sent?.message_id) delivered += 1;
    }
    return delivered;
  }

  async notifyAdminShiftSummary(shift: WaiterShift) {
    if (!this.enabled() || shift.roleKind !== "admin") return 0;
    const admin = this.store.findWaiterById(shift.waiterId);
    const chatId = admin?.telegramChatId.trim();
    if (!chatId) return 0;
    const card = this.store.snapshot().ownerNotifications.sberCardNumber.trim();
    const text = [
      "📊 Итоги смены администратора",
      `Дата: ${shift.morningGreetingDate}`,
      `Оценка: ${shift.score} из 5 ★`,
      shift.adminRatingPenaltyStars > 0 ? `Снижение за неподтверждённые пункты: −${shift.adminRatingPenaltyStars} ★` : "Неподтверждённых пунктов нет.",
      `Невыполненных пунктов сотрудников: ${shift.adminPenaltyItemCount}`,
      `Штраф: ${shift.adminPenaltyAmount} ₽`,
      shift.adminPenaltyAmount > 0
        ? card ? `Переведите штраф на карту СберБанка владельца: ${card}` : "Карта СберБанка владельца не указана. Обратитесь к владельцу."
        : "Штраф не начислен.",
      shift.adminPenaltyAmount > 0 ? "После перевода отправьте сюда скриншот чека одним фото." : ""
    ].filter(Boolean).join("\n");
    const sent = await this.request<TelegramMessage>("sendMessage", { chat_id: chatId, text, disable_notification: false });
    return sent?.message_id ? 1 : 0;
  }

  async handleUpdate(update: TelegramUpdate) {
    if (update.message?.photo?.length) {
      await this.handlePenaltyReceiptPhoto(update.message);
      return;
    }
    const text = update.message?.text?.trim();
    if (text) {
      await this.handleMessage(update.message as TelegramMessage, text);
      return;
    }

    const query = update.callback_query;
    if (!query?.data || !query.message) return;

    if (query.data === "shift:start") {
      await this.answerCallback(query.id);
      await this.showZonePicker(query.message.chat.id);
      return;
    }

    if (query.data === "shift:end") {
      await this.answerCallback(query.id);
      await this.finishShift(query.message.chat.id);
      return;
    }

    if (query.data.startsWith("shift:zone:")) {
      await this.handleZoneSelection(query.id, query.message, query.data.slice("shift:zone:".length));
      return;
    }

    if (query.data.startsWith("check:")) {
      await this.handleChecklistCallback(query.id, query.message, query.data);
      return;
    }

    if (query.data.startsWith("task:complete:")) {
      await this.handleShiftTaskCallback(query.id, query.message, query.data);
      return;
    }

    if (query.data.startsWith("task:reason:")) {
      await this.handleShiftTaskReasonCallback(query.id, query.message, query.data);
      return;
    }

    if (query.data.startsWith("delivery:pickup:ack:")) {
      await this.handleDeliveryPickupAlertCallback(query.id, query.message, query.data);
      return;
    }

    if (query.data.startsWith("call:")) {
      await this.handleCallCallback(query.id, query.message, query.data);
    }
  }

  private async handlePenaltyReceiptPhoto(message: TelegramMessage) {
    const waiter = this.store.findWaiterByChatId(message.chat.id);
    const shift = waiter ? this.store.latestUnpaidAdminPenaltyShift(waiter.id) : null;
    if (!waiter || !shift) {
      await this.sendText(message.chat.id, "Фото получено, но у вас нет неоплаченного штрафа по завершённой смене администратора.");
      return;
    }
    const photo = [...(message.photo || [])].sort((left, right) => (right.file_size || 0) - (left.file_size || 0))[0];
    if (!photo || (photo.file_size || 0) > 8 * 1024 * 1024) {
      await this.sendText(message.chat.id, "Скриншот чека должен быть не больше 8 МБ.");
      return;
    }
    const file = await this.request<{ file_path?: string }>("getFile", { file_id: photo.file_id });
    if (!file?.file_path) {
      await this.sendText(message.chat.id, "Не удалось получить скриншот из Telegram. Отправьте фото ещё раз.");
      return;
    }
    const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) {
      await this.sendText(message.chat.id, "Не удалось скачать скриншот из Telegram. Отправьте фото ещё раз.");
      return;
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length < 100 || body.length > 8 * 1024 * 1024) {
      await this.sendText(message.chat.id, "Скриншот чека повреждён или превышает 8 МБ.");
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
      await this.sendText(message.chat.id, "Отправьте чек как настоящее JPG, PNG или WEBP фото.");
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
      "telegram"
    );
    await this.sendText(
      message.chat.id,
      `✅ Чек по штрафу ${shift.adminPenaltyAmount} ₽ сохранён в смене за ${shift.morningGreetingDate}.`
    );
  }

  private async handleMessage(message: TelegramMessage, text: string) {
    const normalized = text.toLowerCase();
    if (normalized.startsWith("/start")) {
      await this.sendWelcome(message.chat.id);
      return;
    }
    if (normalized === "/shift" || normalized === "начать смену") {
      await this.showZonePicker(message.chat.id);
      return;
    }
    if (normalized === "/end_shift" || normalized === "закончить смену") {
      await this.finishShift(message.chat.id);
      return;
    }
    if (normalized === "/status" || normalized === "моя смена") {
      await this.sendShiftStatus(message.chat.id);
      return;
    }
    if (normalized === "/reservations" || normalized === "брони столов") {
      await this.sendReservationsButton(message.chat.id);
      return;
    }

    const waiter = this.store.findWaiterByChatId(message.chat.id);
    const draftKey = String(message.chat.id);
    const selectedRecordId = this.rolloverReasonDrafts.get(draftKey);
    if (waiter && selectedRecordId) {
      if (text.trim().length < 3) {
        await this.sendText(message.chat.id, "Причина слишком короткая. Опишите, что помешало выполнить задание.");
        return;
      }
      const saved = await this.store.setShiftTaskRolloverReason(selectedRecordId, waiter.id, text);
      if (saved) {
        this.rolloverReasonDrafts.delete(draftKey);
        await this.sendText(message.chat.id, `✅ Причина переноса сохранена для задания «${saved.task.title}».`);
        return;
      }
      this.rolloverReasonDrafts.delete(draftKey);
    }
    if (waiter) {
      const pending = this.store.pendingShiftTaskRolloverReasons(waiter.id);
      if (pending.length === 1) {
        const saved = await this.store.setShiftTaskRolloverReason(pending[0].record.id, waiter.id, text);
        if (saved) {
          await this.sendText(message.chat.id, `✅ Причина переноса сохранена для задания «${saved.task.title}».`);
          return;
        }
      }
      if (pending.length > 1) {
        await this.sendText(message.chat.id, "Есть несколько перенесённых заданий. Нажмите «Указать причину» под нужным заданием, затем отправьте комментарий.");
        return;
      }
    }

    await this.sendWelcome(message.chat.id);
  }

  private async sendWelcome(chatId: string | number) {
    const waiter = this.store.findWaiterByChatId(chatId);
    if (!waiter) {
      await this.request("sendMessage", {
        chat_id: chatId,
        text: [
          "Telegram пока не привязан к карточке сотрудника.",
          "",
          `Ваш chat_id: ${chatId}`,
          "Передайте его администратору и добавьте в карточку сотрудника в админке."
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
    await this.request("sendMessage", {
      chat_id: chatId,
      text: `Здравствуйте, ${waiter.name}!\nДолжность: ${role?.name || "Сотрудник"}\n${status}\n\nШахматка и ближайшие брони доступны по кнопке «Брони столов».`,
      reply_markup: menuKeyboard
    });
  }

  private async sendReservationsButton(chatId: string | number) {
    const waiter = await this.requireWaiter(chatId);
    if (!waiter) return;
    const shift = this.store.currentShiftForWaiter(waiter.id);
    if (!shift) {
      await this.sendText(chatId, "Сначала нажмите «Начать смену», затем откройте шахматку.");
      return;
    }
    await this.request("sendMessage", {
      chat_id: chatId,
      text: shift.status === "active"
        ? "Шахматка готова. Здесь можно менять статусы броней, столы и комментарии."
        : "Шахматка доступна для просмотра. Завершите обязательный чек-лист, чтобы менять брони.",
      reply_markup: {
        inline_keyboard: [[{
          text: "Открыть брони столов",
          web_app: { url: `${publicBaseUrl()}/staff/reservations` }
        }]]
      }
    });
  }

  private async showZonePicker(chatId: string | number) {
    const waiter = await this.requireWaiter(chatId);
    if (!waiter) return;

    const current = this.store.currentShiftForWaiter(waiter.id);
    if (current) {
      await this.sendChecklist(chatId, current, "Смена уже начата.");
      return;
    }

    const zones = this.store.listZones();
    if (!zones.length) {
      await this.sendText(chatId, "В админке пока нет столов с этажами или зонами.");
      return;
    }

    const keyboard = zones.map((zone, index) => [{ text: zone, callback_data: `shift:zone:${index}` }]);
    if (zones.length > 1) keyboard.push([{ text: "Все этажи", callback_data: "shift:zone:all" }]);
    await this.request("sendMessage", {
      chat_id: chatId,
      text: "На каком этаже вы начинаете смену?",
      reply_markup: { inline_keyboard: keyboard }
    });
  }

  private async handleZoneSelection(callbackId: string, message: TelegramMessage, selection: string) {
    const waiter = await this.requireWaiter(message.chat.id, callbackId);
    if (!waiter) return;

    const zones = this.store.listZones();
    const selectedZones = selection === "all" ? zones : [zones[Number(selection)]].filter(Boolean);
    if (!selectedZones.length) {
      await this.answerCallback(callbackId, "Список этажей изменился. Выберите заново.", true);
      await this.showZonePicker(message.chat.id);
      return;
    }

    const result = await this.store.startWaiterShift(waiter.id, selectedZones);
    if (!result) {
      await this.answerCallback(callbackId, "Не удалось начать смену", true);
      return;
    }

    await this.answerCallback(callbackId, result.created ? "Смена начата" : "Смена уже активна");
    await this.request("editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: `Смена: ${result.shift.zones.join(", ")}`
    });

    if (result.created && result.firstShiftToday) await this.sendMorningGreeting(message.chat.id, waiter);
    await this.sendChecklist(message.chat.id, result.shift);
    await this.request("sendMessage", {
      chat_id: message.chat.id,
      text: shiftStartedText(result.shift),
      reply_markup: menuKeyboard
    });
    if (result.shift.status === "active" && result.shift.roleKind === "waiter") {
      await this.deliverPendingCalls(waiter.id);
    }
  }

  private async sendMorningGreeting(chatId: string | number, waiter: Waiter) {
    const role = this.store.roleForWaiter(waiter);
    if (role?.kind === "admin") {
      await this.sendText(chatId, `Доброе утро, ${waiter.name}!\nЖелаем спокойной и успешной смены.`);
      return;
    }
    const ratings = this.store.waiterRatings(waiter.roleId);
    const ranking = ratings.length
      ? ratings
          .map((item) =>
            item.shiftCount
              ? `${item.rank}. ${item.waiterName} — ${item.score} ★ (${item.shiftCount} смен, всего ${item.totalStars} ★)`
              : `${item.rank}. ${item.waiterName} — пока нет завершенных смен`
          )
          .join("\n")
      : "Рейтинг появится после первой завершенной смены.";

    await this.sendText(
      chatId,
      [
        `Доброе утро, ${waiter.name}!`,
        "Желаем спокойной и успешной смены.",
        "",
        `Рейтинг подразделения «${role?.name || "Команда"}»:`,
        ranking
      ].join("\n")
    );

    const analytics = this.store.performanceAnalytics([waiter.roleId]);
    if (analytics.analyzedShiftCount > 0) {
      const report = await generatePerformanceInsights(analytics);
      const advice = report.employeeAdvice.find((item) => item.waiterId === waiter.id)?.advice;
      if (advice) await this.sendText(chatId, `Рекомендация по рейтингу:\n${advice}`);
    }
  }

  private async sendChecklist(chatId: string | number, shift: WaiterShift, prefix = "") {
    await this.request("sendMessage", {
      chat_id: chatId,
      text: [prefix, shiftChecklistText(
        shift,
        this.store.snapshot().checklistWindows,
        config.VENUE_TIME_ZONE
      )].filter(Boolean).join("\n\n"),
      reply_markup: this.checklistKeyboard(shift)
    });
  }

  private checklistKeyboard(shift: WaiterShift) {
    const buttons = shift.checklist
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.completedAt)
      .map(({ item, index }) => [
        {
          text: `Сделано: пункт ${index + 1}`,
          callback_data: `check:${shift.id}:${index}`
        }
      ]);
    return { inline_keyboard: buttons };
  }

  private async handleChecklistCallback(callbackId: string, message: TelegramMessage, data: string) {
    const waiter = await this.requireWaiter(message.chat.id, callbackId);
    if (!waiter) return;

    const [, shiftId, rawIndex] = data.split(":");
    const before = this.store.findShiftById(shiftId);
    const result = await this.store.completeShiftChecklistItem(shiftId, waiter.id, Number(rawIndex));
    if (result.status === "not_found") {
      await this.answerCallback(callbackId, "Пункт или смена не найдены", true);
      return;
    }
    if (result.status === "already_completed") {
      await this.answerCallback(callbackId, "Этот пункт уже отмечен", true);
      return;
    }
    if (result.status === "cooldown") {
      await this.answerCallback(
        callbackId,
        `Следующий пункт можно отметить через ${result.retryAfterSeconds} сек.`,
        true
      );
      return;
    }
    if (result.status === "outside_window") {
      const meta = CHECKLIST_PHASE_META[result.phase];
      await this.answerCallback(
        callbackId,
        result.windowStatus === "not_started"
          ? `${meta.shortTitle}: заполнение доступно с ${result.window.start} до ${result.window.end}`
          : `${meta.shortTitle}: время заполнения ${formatChecklistWindow(result.window)} уже истекло`,
        true
      );
      return;
    }

    const shift = result.shift;

    await this.answerCallback(callbackId, "Отмечено");
    await this.request("editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: shiftChecklistText(
        shift,
        this.store.snapshot().checklistWindows,
        config.VENUE_TIME_ZONE
      ),
      reply_markup: this.checklistKeyboard(shift)
    });

    if (before?.status !== "active" && shift.status === "active") {
      await this.sendText(message.chat.id, "Все обязательные пункты выполнены. Чек-лист смены завершен.");
      if (shift.roleKind === "waiter") await this.deliverPendingCalls(waiter.id);
    }
  }

  private async handleShiftTaskCallback(callbackId: string, message: TelegramMessage, data: string) {
    const waiter = await this.requireWaiter(message.chat.id, callbackId);
    if (!waiter) return;

    const taskId = data.slice("task:complete:".length);
    const before = this.store.currentShiftForWaiter(waiter.id);
    const result = await this.store.completeShiftTask(taskId, waiter.id);
    if (result.status === "not_found") {
      await this.answerCallback(callbackId, "Задание не найдено или назначено другому сотруднику", true);
      return;
    }

    const roleLabel = this.store.findRole(result.task.roleId)?.name || "Должность";
    await this.answerCallback(
      callbackId,
      result.status === "completed" ? "Задание выполнено" : "Задание уже отмечено"
    );
    await this.request("editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: shiftTaskText(result.task, roleLabel),
      reply_markup: { inline_keyboard: [] }
    });

    const shift = this.store.currentShiftForWaiter(waiter.id);
    if (before?.status !== "active" && shift?.status === "active") {
      await this.sendText(message.chat.id, "Все обязательные пункты выполнены. Чек-лист смены завершен.");
      if (shift.roleKind === "waiter") await this.deliverPendingCalls(waiter.id);
    }
  }

  private async handleShiftTaskReasonCallback(callbackId: string, message: TelegramMessage, data: string) {
    const waiter = await this.requireWaiter(message.chat.id, callbackId);
    if (!waiter) return;
    const recordId = data.slice("task:reason:".length);
    const pending = this.store.findPendingShiftTaskRolloverReason(recordId, waiter.id);
    if (!pending) {
      await this.answerCallback(callbackId, "Причина уже сохранена или перенос не найден", true);
      return;
    }
    this.rolloverReasonDrafts.set(String(message.chat.id), recordId);
    await this.answerCallback(callbackId, "Отправьте причину одним сообщением");
    await this.sendText(
      message.chat.id,
      `Почему не выполнено задание «${pending.task.title}»? Отправьте причину одним сообщением до 500 символов.`
    );
  }

  private async deliverPendingCalls(waiterId: string) {
    const settings = this.store.snapshot().settings;
    for (const call of this.store.pendingCallsForWaiter(waiterId)) {
      const table = this.store.findTableById(call.tableId);
      if (!table) continue;
      if (this.coordinator) await this.coordinator.syncCall(call);
      else await this.notifyCall({ call, table, waiters: this.store.waitersForTable(table), settings });
    }
  }

  private async sendShiftStatus(chatId: string | number) {
    const waiter = await this.requireWaiter(chatId);
    if (!waiter) return;
    const shift = this.store.currentShiftForWaiter(waiter.id);
    if (!shift) {
      await this.sendText(chatId, "Смена не начата. Нажмите «Начать смену».");
      return;
    }
    await this.sendChecklist(chatId, shift);
  }

  private async finishShift(chatId: string | number) {
    const waiter = await this.requireWaiter(chatId);
    if (!waiter) return;
    const result: ShiftEndResult = await this.store.requestEndWaiterShift(waiter.id);
    if (result.status === "not_found") {
      await this.sendText(chatId, "У вас нет активной смены.");
      return;
    }
    if (result.status === "closing_checklist_incomplete") {
      await this.sendChecklist(chatId, result.shift, `Смена не завершена: выполните чек-лист закрытия (${result.pendingCount} пунктов).`);
      if (result.shift.roleKind === "waiter" || result.shift.roleId === "barista") {
        if (this.coordinator?.notifyClosingChecklistIncomplete) await this.coordinator.notifyClosingChecklistIncomplete(result.shift);
        else await this.notifyClosingChecklistIncomplete(result.shift);
      }
      return;
    }
    if (result.status === "employee_shifts_active") {
      await this.sendText(chatId, `Смена не завершена: сначала дождитесь завершения ${result.activeCount} смен официантов или бариста.`);
      return;
    }
    if (result.status === "admin_reviews_incomplete") {
      await this.sendText(chatId, `Смена не завершена. В разделе «Контроль сотрудников» добавьте фото и оценку ещё к ${result.missingCount} пунктам чек-листов закрытия официантов и бариста.`);
      return;
    }
    const shift = result.shift;

    await this.clearWaiterCallMessages(waiter);
    await this.request("sendMessage", {
      chat_id: chatId,
      text: shift.checklist.some((item) => item.countsForRating !== false)
        ? `Смена завершена. Столы сняты, уведомления отключены.\nРейтинг смены: ${shift.score} из 5 ★.`
        : "Смена завершена. Столы сняты, уведомления отключены.\nВ этой смене не было заданий, влияющих на рейтинг.",
      reply_markup: menuKeyboard
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

  private async handleCallCallback(callbackId: string, message: TelegramMessage, data: string) {
    const [, action, callId] = data.split(":");
    const waiter = await this.requireWaiter(message.chat.id, callbackId);
    if (!waiter || !callId) return;

    if (action === "accepted") {
      const result = await this.store.acceptCall(callId, waiter.id);
      if (!result) {
        await this.answerCallback(callbackId, "Вызов уже закрыт", true);
        return;
      }
      if (!result.allowed) {
        await this.answerCallback(callbackId, "Этот вызов назначен другому сотруднику", true);
        return;
      }

      const acceptedBy = result.call.lastAcceptedByStaffId
        ? this.store.findWaiterById(result.call.lastAcceptedByStaffId)?.name
        : "другой сотрудник";
      await this.answerCallback(
        callbackId,
        result.accepted ? "Вызов принят" : `Уже принял: ${acceptedBy}`,
        !result.accepted
      );
      const table = this.store.findTableById(result.call.tableId);
      if (table) {
        if (this.coordinator) await this.coordinator.syncCall(result.call);
        else {
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
        await this.answerCallback(callbackId, "Эскалация уже закрыта или назначена другому сотруднику", true);
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

    if (action === "done") {
      const current = this.store.findCallById(callId);
      if (!current || current.status !== "accepted") {
        await this.answerCallback(callbackId, "Вызов уже закрыт", true);
        return;
      }
      await this.answerCallback(callbackId, "Стол убран из чата");
      const call = await this.store.completeCall(callId);
      if (call) {
        if (this.coordinator) await this.coordinator.closeCall(call);
        else await this.deleteCallMessages(call);
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
    const unique = new Map(recipients.map((recipient) => [recipient.member.telegramChatId.trim(), recipient]));
    return Array.from(unique.values()).filter((recipient) => recipient.member.telegramChatId.trim());
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
    const status =
      call.status === "new"
        ? "🔴 ОЖИДАЕТ ПРИНЯТИЯ"
        : call.status === "accepted"
          ? `🟢 Принял: ${acceptedBy || "сотрудник"}`
          : "⚪ Завершен";
    const callHeading =
      call.status === "new"
        ? [
            "🟥🟥🟥 НОВЫЙ ВЫЗОВ 🟥🟥🟥",
            `🚨 ПОСЛЕДНИЙ ЗАПРОС: ${latestReason.toLocaleUpperCase("ru-RU")}`
          ]
        : ["✅ ВЫЗОВ ПРИНЯТ", `Последний запрос: ${latestReason}`];
    const routingTitle =
      call.routingStage === "owner"
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
    ]
      .filter(Boolean)
      .join("\n");
  }

  private callKeyboard(call: ServiceCall) {
    if (call.status === "new") {
      return { inline_keyboard: [[{ text: "Принято", callback_data: `call:accepted:${call.id}` }]] };
    }
    if (call.status === "accepted") {
      const needsEscalationAcknowledgement =
        (call.routingStage === "admin" && !call.adminAcknowledgedAt) ||
        (call.routingStage === "owner" && !call.ownerAcknowledgedAt);
      if (needsEscalationAcknowledgement) {
        return {
          inline_keyboard: [
            [{ text: "Подтвердить контроль", callback_data: `call:ack:${call.id}` }],
            [{ text: "Готово", callback_data: `call:done:${call.id}` }]
          ]
        };
      }
      return { inline_keyboard: [[{ text: "Готово", callback_data: `call:done:${call.id}` }]] };
    }
    return { inline_keyboard: [] };
  }

  private async syncCallMessages(
    call: ServiceCall,
    table: DiningTable,
    recipients: Array<{ member: Waiter; recipientRole: "waiter" | "admin" | "owner" }>,
    settings: VenueSettings,
    notificationEvent: ServiceCall
  ) {
    const text = this.callText(call, table, settings);
    if (!this.enabled()) {
      console.log("[telegram disabled] waiter call:", text);
      return [];
    }

    const targetKeys = new Set(
      recipients.map((recipient) => `${recipient.member.telegramChatId.trim()}:${recipient.recipientRole}`)
    );
    const allWarningRefs = call.telegramMessages.filter((message) => message.kind === "warning");
    const warningRefs = call.adminWarningSentAt ? allWarningRefs : [];
    if (!call.adminWarningSentAt) {
      for (const message of allWarningRefs) {
        await this.request("deleteMessage", { chat_id: message.chatId, message_id: message.messageId });
      }
    }
    const primaryRefs = call.telegramMessages.filter((message) => message.kind === "call");
    const existingByTarget = new Map(
      primaryRefs.map((message) => [`${message.chatId}:${message.recipientRole}`, message])
    );

    for (const message of primaryRefs) {
      if (!targetKeys.has(`${message.chatId}:${message.recipientRole}`)) {
        await this.request("deleteMessage", { chat_id: message.chatId, message_id: message.messageId });
      }
    }

    const refs: TelegramMessageRef[] = [];
    for (const recipient of recipients) {
      const chatId = recipient.member.telegramChatId.trim();
      if (!chatId) continue;
      const existing = existingByTarget.get(`${chatId}:${recipient.recipientRole}`);
      if (existing) {
        const edited = await this.request<TelegramMessage | true>("editMessageText", {
          chat_id: chatId,
          message_id: existing.messageId,
          text,
          reply_markup: this.callKeyboard(call)
        });
        if (edited) {
          refs.push(existing);
          if (call.status === "new" && notificationEvent.status === "new") {
            await this.sendAudibleCallAlert(chatId, existing.messageId, table, notificationEvent);
          }
          continue;
        }
      }

      const sent = await this.request<TelegramMessage>("sendMessage", {
        chat_id: chatId,
        text,
        disable_notification: false,
        reply_markup: this.callKeyboard(call)
      });
      if (sent?.message_id) {
        refs.push({
          chatId: String(sent.chat.id),
          messageId: sent.message_id,
          recipientRole: recipient.recipientRole,
          kind: "call"
        });
      }
    }

    await this.store.replaceTelegramMessages(call.id, [...warningRefs, ...refs]);
    return refs;
  }

  private async sendAudibleCallAlert(
    chatId: string,
    primaryMessageId: number,
    table: DiningTable,
    notificationEvent: ServiceCall
  ) {
    const latestLabel = notificationEvent.actionLabel || "Вызов официанта";
    const alertTitle = notificationEvent.pressCount > 1 ? "ПОВТОРНЫЙ ВЫЗОВ" : "НОВЫЙ ВЫЗОВ";
    const sent = await this.request<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text: [
        `🚨🚨 ${alertTitle} 🚨🚨`,
        `🟥 ${table.name}${table.zone ? `, ${table.zone}` : ""}`,
        `Последний запрос: ${callReasonIcon(latestLabel)} ${latestLabel.toLocaleUpperCase("ru-RU")}`,
        `Нажатие № ${notificationEvent.pressCount} в текущем вызове`
      ].join("\n"),
      disable_notification: false,
      reply_parameters: {
        message_id: primaryMessageId,
        allow_sending_without_reply: true
      }
    });

    if (!sent?.message_id || this.repeatAlertLifetimeMs <= 0) return;
    const alertChatId = String(sent.chat.id);
    const timer = setTimeout(() => {
      void this.request("deleteMessage", {
        chat_id: alertChatId,
        message_id: sent.message_id
      }).catch((error) => console.error("[telegram] repeat alert cleanup:", error));
    }, this.repeatAlertLifetimeMs);
    timer.unref();
  }

  private async deleteCallMessages(call: ServiceCall) {
    for (const message of call.telegramMessages) {
      await this.request("deleteMessage", { chat_id: message.chatId, message_id: message.messageId });
    }
    await this.store.replaceTelegramMessages(call.id, []);
  }

  private async clearWaiterCallMessages(waiter: Waiter) {
    const refs = this.store.activeCallMessagesForChat(waiter.telegramChatId);
    for (const ref of refs) {
      await this.request("deleteMessage", { chat_id: ref.chatId, message_id: ref.messageId });
    }
    await this.store.removeTelegramMessagesForChat(waiter.telegramChatId);
  }

  private async requireWaiter(chatId: string | number, callbackId?: string) {
    const waiter = this.store.findWaiterByChatId(chatId);
    if (waiter?.active) return waiter;

    if (callbackId) await this.answerCallback(callbackId, "Telegram не привязан к активному сотруднику", true);
    else await this.sendWelcome(chatId);
    return null;
  }

  private async configureBot() {
    await this.request("setMyCommands", {
      commands: [
        { command: "shift", description: "Начать смену" },
        { command: "status", description: "Моя смена и чек-лист" },
        { command: "reservations", description: "Брони столов" },
        { command: "end_shift", description: "Закончить смену" }
      ]
    });
  }

  async notifyReservationEvent(input: {
    recipients: Waiter[];
    reservation: CrmStaffReservation;
    tableNumber: number;
    hallName: string;
    event: "new" | "changed" | "reminder";
  }) {
    const title = input.event === "new"
      ? "📌 Новая бронь"
      : input.event === "reminder"
        ? "⏰ Бронь через 30 минут"
        : "🔄 Бронь изменена";
    const status = input.reservation.status === "PENDING"
      ? "новая"
      : input.reservation.status === "CONFIRMED"
        ? "подтверждена"
        : input.reservation.status === "SEATED"
          ? "гости пришли"
          : input.reservation.status === "COMPLETED"
            ? "завершена"
            : input.reservation.status === "CANCELLED"
              ? "отменена"
              : input.reservation.status === "NO_SHOW"
                ? "не пришли"
                : "лист ожидания";
    const text = [
      title,
      "",
      `${formatTime(input.reservation.date)} · стол №${input.tableNumber} · ${input.hallName}`,
      `${input.reservation.guestName} · ${input.reservation.guestsCount} чел.`,
      `Статус: ${status}`,
      input.reservation.notes ? `Комментарий: ${input.reservation.notes}` : ""
    ].filter(Boolean).join("\n");
    let delivered = 0;
    for (const recipient of input.recipients) {
      if (!recipient.telegramChatId.trim()) continue;
      const sent = await this.request<TelegramMessage>("sendMessage", {
        chat_id: recipient.telegramChatId,
        text,
        reply_markup: {
          inline_keyboard: [[{
            text: "Открыть шахматку",
            web_app: { url: `${publicBaseUrl()}/staff/reservations` }
          }]]
        }
      });
      if (sent) delivered += 1;
    }
    return delivered;
  }

  /** Отправить персональное уведомление сотруднику о задании на смену */
  async notifyShiftTask(task: ShiftTask): Promise<boolean> {
    if (!task.waiterId) return false;
    const waiter = this.store.findWaiterById(task.waiterId);
    if (!waiter?.telegramChatId?.trim()) return false;

    const roleLabel = this.store.findRole(task.roleId)?.name || "Должность";

    const sent = await this.request<TelegramMessage>("sendMessage", {
      chat_id: waiter.telegramChatId.trim(),
      text: shiftTaskText(task, roleLabel),
      reply_markup: {
        inline_keyboard: [[{
          text: "✅ Отметить выполненным",
          callback_data: `task:complete:${task.id}`
        }]]
      }
    });
    return Boolean(sent);
  }

  async notifyShiftTaskRollover(task: ShiftTask, record: ShiftTaskRolloverRecord): Promise<boolean> {
    if (!task.waiterId) return false;
    const waiter = this.store.findWaiterById(task.waiterId);
    if (!waiter?.telegramChatId?.trim()) return false;
    const sent = await this.request<TelegramMessage>("sendMessage", {
      chat_id: waiter.telegramChatId.trim(),
      text: shiftTaskRolloverText(task, record),
      reply_markup: {
        inline_keyboard: [[{
          text: "✍️ Указать причину",
          callback_data: `task:reason:${record.id}`
        }]]
      }
    });
    return Boolean(sent);
  }

  private async sendText(chatId: string | number, text: string) {
    await this.request("sendMessage", { chat_id: chatId, text, reply_markup: menuKeyboard });
  }

  private async answerCallback(id: string, text = "", showAlert = false) {
    await this.request("answerCallbackQuery", {
      callback_query_id: id,
      text: text || undefined,
      show_alert: showAlert
    });
  }

  private async pollLoop() {
    while (this.polling) {
      try {
        const updates = await this.request<TelegramUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ["message", "callback_query"]
        });

        for (const update of updates || []) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (error) {
        console.error("[telegram polling]", error);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  private async request<T>(method: string, payload: unknown): Promise<T | null> {
    if (!this.enabled()) return null;

    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    const json = (await response.json()) as TelegramResponse<T>;
    if (!json.ok) {
      if (json.description?.includes("message is not modified")) return true as T;
      console.error(`[telegram] ${method}:`, json.description);
      return null;
    }

    return json.result ?? null;
  }
}
