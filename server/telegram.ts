import type { Store } from "./store";
import type {
  DiningTable,
  ServiceCall,
  ShiftTask,
  TelegramMessageRef,
  VenueSettings,
  Waiter,
  WaiterShift
} from "./types";
import { config } from "./config";
import { generatePerformanceInsights } from "./performance-ai";

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number | string };
  text?: string;
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

const formatTime = (value: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: config.VENUE_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));

const venueDateKey = (value = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: config.VENUE_TIME_ZONE }).format(value);

const menuKeyboard = {
  keyboard: [[{ text: "Начать смену" }, { text: "Закончить смену" }], [{ text: "Моя смена" }]],
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

  constructor(private store: Store, token = config.TELEGRAM_BOT_TOKEN) {
    this.token = token;
  }

  enabled() {
    return Boolean(this.token);
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

  startPolling() {
    if (!this.enabled()) return;
    void this.configureBot();
    if (!this.escalationTimer) {
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
      for (const call of this.store.callsDueForAdminWarning(at)) {
        const table = this.store.findTableById(call.tableId);
        if (!table) continue;
        const admins = this.store.activeAdminsForTable(table);
        const refs: TelegramMessageRef[] = [];
        for (const admin of admins) {
          const sent = await this.request<TelegramMessage>("sendMessage", {
            chat_id: admin.telegramChatId,
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
        if (admins.length && !refs.length) continue;
        await this.store.markAdminWarningSent(call.id);
        if (refs.length) await this.store.appendTelegramMessages(call.id, refs);
      }

      for (const dueCall of this.store.callsDueForOwnerEscalation(at)) {
        if (!this.store.ownersForEscalation().length) continue;
        const call = await this.store.markOwnerEscalated(dueCall.id);
        const table = call ? this.store.findTableById(call.tableId) : null;
        if (!call || !table) continue;
        await this.notifyCall({
          call,
          table,
          waiters: [],
          settings: this.store.snapshot().settings
        });
        const delivered = this.store
          .findCallById(call.id)
          ?.telegramMessages.some((message) => message.kind === "call" && message.recipientRole === "owner");
        if (!delivered) await this.store.retryOwnerEscalation(call.id);
      }

      for (const task of this.store.getShiftTasksForNotification(venueDateKey(new Date(at)))) {
        if (await this.notifyShiftTask(task)) {
          await this.store.markShiftTaskNotified(task.id);
        }
      }
    } finally {
      this.escalationRunning = false;
    }
  }

  async handleUpdate(update: TelegramUpdate) {
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

    if (query.data.startsWith("call:")) {
      await this.handleCallCallback(query.id, query.message, query.data);
    }
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
      text: `Здравствуйте, ${waiter.name}!\nДолжность: ${role?.name || "Сотрудник"}\n${status}`,
      reply_markup: menuKeyboard
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
      text: this.shiftStartedText(result.shift),
      reply_markup: menuKeyboard
    });
    if (result.shift.status === "active" && result.shift.roleKind === "waiter") {
      await this.deliverPendingCalls(waiter.id);
    }
  }

  private shiftStartedText(shift: WaiterShift) {
    if (shift.roleKind === "admin") {
      return shift.status === "active"
        ? "Смена администратора зарегистрирована. Критические вызовы гостей включены."
        : "Смена администратора зарегистрирована. Критические вызовы уже включены; завершите рабочий чек-лист.";
    }
    if (shift.roleKind === "waiter") {
      return shift.status === "active"
        ? "Уведомления от ваших столов включены."
        : "Столы назначены. Уведомления включатся после обязательных пунктов чек-листа.";
    }
    return shift.status === "active"
      ? "Смена зарегистрирована."
      : "Смена зарегистрирована. Завершите обязательные пункты чек-листа.";
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
      text: [prefix, this.checklistText(shift)].filter(Boolean).join("\n\n"),
      reply_markup: this.checklistKeyboard(shift)
    });
  }

  private checklistText(shift: WaiterShift) {
    const required = shift.checklist.filter((item) => item.requiredForCalls);
    const requiredDone = required.filter((item) => item.completedAt).length;
    const rows = shift.checklist.length
      ? shift.checklist.map((item) => {
          const marker = item.completedAt ? "✅" : "⬜";
          const requiredLabel = item.requiredForCalls ? " · обязательно" : "";
          const ratingLabel = item.countsForRating === false ? " · без рейтинга" : "";
          return `${marker} ${item.title}${requiredLabel}${ratingLabel}`;
        })
      : ["Чек-лист на сегодня пуст."];
    const admission = shift.status === "active" ? "Обязательные пункты выполнены" : `Готовность: ${requiredDone}/${required.length}`;
    const criticalNote = shift.roleKind === "admin" ? "Критические вызовы гостей включены с начала смены." : "";
    return [
      `Чек-лист: ${shift.roleName}`,
      `Этажи: ${shift.zones.join(", ")}`,
      "",
      ...rows,
      "",
      admission,
      criticalNote
    ]
      .filter(Boolean)
      .join("\n");
  }

  private checklistKeyboard(shift: WaiterShift) {
    const buttons = shift.checklist
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.completedAt)
      .map(({ item, index }) => [
        {
          text: `Сделано: ${item.title}`.slice(0, 58),
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
    const shift = await this.store.completeShiftChecklistItem(shiftId, waiter.id, Number(rawIndex));
    if (!shift) {
      await this.answerCallback(callbackId, "Пункт или смена не найдены", true);
      return;
    }

    await this.answerCallback(callbackId, "Отмечено");
    await this.request("editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: this.checklistText(shift),
      reply_markup: this.checklistKeyboard(shift)
    });

    if (before?.status !== "active" && shift.status === "active") {
      await this.sendText(message.chat.id, "Все обязательные пункты выполнены. Чек-лист смены завершен.");
      if (shift.roleKind === "waiter") await this.deliverPendingCalls(waiter.id);
    }
  }

  private async deliverPendingCalls(waiterId: string) {
    const settings = this.store.snapshot().settings;
    for (const call of this.store.pendingCallsForWaiter(waiterId)) {
      const table = this.store.findTableById(call.tableId);
      if (!table) continue;
      await this.notifyCall({ call, table, waiters: this.store.waitersForTable(table), settings });
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
    const shift = await this.store.endWaiterShift(waiter.id);
    if (!shift) {
      await this.sendText(chatId, "У вас нет активной смены.");
      return;
    }

    await this.clearWaiterCallMessages(waiter);
    await this.request("sendMessage", {
      chat_id: chatId,
      text: shift.checklist.some((item) => item.countsForRating !== false)
        ? `Смена завершена. Столы сняты, уведомления отключены.\nРейтинг смены: ${shift.score} из 5 ★.`
        : "Смена завершена. Столы сняты, уведомления отключены.\nВ этой смене не было заданий, влияющих на рейтинг.",
      reply_markup: menuKeyboard
    });
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
        ? this.store.snapshot().waiters.find((item) => item.id === result.call.lastAcceptedByStaffId)?.name
        : "другой сотрудник";
      await this.answerCallback(
        callbackId,
        result.accepted ? "Вызов принят" : `Уже принял: ${acceptedBy}`,
        !result.accepted
      );
      const table = this.store.findTableById(result.call.tableId);
      if (table) {
        await this.notifyCall({
          call: result.call,
          table,
          waiters: this.store.waitersForTable(table),
          settings: this.store.snapshot().settings
        });
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
      if (call) await this.deleteCallMessages(call);
    }
  }

  private recipientsForCall(call: ServiceCall, table: DiningTable) {
    const recipients: Array<{ member: Waiter; recipientRole: "waiter" | "admin" | "owner" }> = [];
    if (call.routingStage === "waiter") {
      recipients.push(...this.store.waitersForTable(table).map((member) => ({ member, recipientRole: "waiter" as const })));
    } else {
      recipients.push(
        ...this.store.activeAdminsForTable(table).map((member) => ({ member, recipientRole: "admin" as const }))
      );
      if (call.routingStage === "owner") {
        recipients.push(
          ...this.store.ownersForEscalation().map((member) => ({ member, recipientRole: "owner" as const }))
        );
      }
    }
    const unique = new Map(recipients.map((recipient) => [recipient.member.telegramChatId.trim(), recipient]));
    return Array.from(unique.values()).filter((recipient) => recipient.member.telegramChatId.trim());
  }

  private callText(call: ServiceCall, table: DiningTable, settings: VenueSettings) {
    const reasons = call.reasonCounts.map((reason) => `• ${reason.label} — ${reason.count}`).join("\n");
    const acceptedBy = call.lastAcceptedByStaffId
      ? this.store.snapshot().waiters.find((waiter) => waiter.id === call.lastAcceptedByStaffId)?.name
      : "";
    const status = call.status === "accepted" ? `Принял: ${acceptedBy || "сотрудник"}` : "Ожидает принятия";
    const routingTitle =
      call.routingStage === "owner"
        ? "🚨 Эскалация владельцу"
        : call.routingStage === "admin"
          ? "⚠️ Вызов перенаправлен администратору"
          : `🔔 ${settings.name}`;
    return [
      routingTitle,
      "",
      `Стол: ${table.name}${table.zone ? `, ${table.zone}` : ""}`,
      "Причины:",
      reasons,
      call.guestName ? `Гость: ${call.guestName}` : "",
      call.comment ? `Комментарий: ${call.comment}` : "",
      call.routingStage !== "waiter" && call.routingReason ? `Причина перенаправления: ${call.routingReason}` : "",
      call.routingStage === "owner" ? "Администратор не принял вызов в течение 5 минут." : "",
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
      return { inline_keyboard: [[{ text: "Готово", callback_data: `call:done:${call.id}` }]] };
    }
    return { inline_keyboard: [] };
  }

  private async syncCallMessages(
    call: ServiceCall,
    table: DiningTable,
    recipients: Array<{ member: Waiter; recipientRole: "waiter" | "admin" | "owner" }>,
    settings: VenueSettings
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
          continue;
        }
      }

      const sent = await this.request<TelegramMessage>("sendMessage", {
        chat_id: chatId,
        text,
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
        { command: "end_shift", description: "Закончить смену" }
      ]
    });
  }

  /** Отправить персональное уведомление сотруднику о задании на смену */
  async notifyShiftTask(task: ShiftTask): Promise<boolean> {
    if (!task.waiterId) return false;
    const waiter = this.store.findWaiterById(task.waiterId);
    if (!waiter?.telegramChatId?.trim()) return false;

    const roleLabel = this.store.findRole(task.roleId)?.name || "Должность";
    const requiredLabel = task.requiredForCalls ? " (обязательное для допуска)" : "";
    const lines = [
      `🗓 Задание на смену ${task.date}`,
      "",
      `Должность: ${roleLabel}`,
      `Задание: ${task.title}${requiredLabel}`,
      task.description ? `Пояснение: ${task.description}` : ""
    ].filter(Boolean).join("\n");

    const sent = await this.request<TelegramMessage>("sendMessage", {
      chat_id: waiter.telegramChatId.trim(),
      text: lines,
      reply_markup: menuKeyboard
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
