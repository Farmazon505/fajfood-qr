import type { Store } from "./store";
import type { DiningTable, ServiceCall, VenueSettings, Waiter } from "./types";
import { config } from "./config";

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type SendMessageResult = {
  message_id: number;
  chat: { id: number | string };
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    chat: { id: number | string };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      message_id: number;
      chat: { id: number | string };
      text?: string;
    };
  };
};

export class TelegramService {
  private token = config.TELEGRAM_BOT_TOKEN;
  private offset = 0;
  private polling = false;

  constructor(private store: Store) {}

  enabled() {
    return Boolean(this.token);
  }

  async notifyCall(options: {
    call: ServiceCall;
    table: DiningTable;
    waiters: Waiter[];
    settings: VenueSettings;
  }) {
    const { call, table, waiters, settings } = options;
    const text = [
      `🔔 ${settings.name}`,
      "",
      `Стол: ${table.name}${table.zone ? `, ${table.zone}` : ""}`,
      `Причина: ${call.actionLabel}`,
      call.guestName ? `Гость: ${call.guestName}` : "",
      call.comment ? `Комментарий: ${call.comment}` : "",
      "",
      `Время: ${new Date(call.createdAt).toLocaleString("ru-RU")}`
    ]
      .filter(Boolean)
      .join("\n");

    if (!this.enabled()) {
      console.log("[telegram disabled] waiter call:", text);
      return [];
    }

    if (!waiters.length) {
      console.warn("[telegram] no active waiters with chat id");
      return [];
    }

    const refs = [];
    for (const waiter of waiters) {
      const result = await this.request<SendMessageResult>("sendMessage", {
        chat_id: waiter.telegramChatId,
        text,
        reply_markup: {
          inline_keyboard: [
            [{ text: "Принял", callback_data: `call:accepted:${call.id}` }]
          ]
        }
      });

      if (result?.message_id) {
        refs.push({ chatId: String(result.chat.id), messageId: result.message_id });
      }
    }

    return refs;
  }

  startPolling() {
    if (!this.enabled() || this.polling || config.TELEGRAM_ENABLE_POLLING !== "true") return;
    this.polling = true;
    void this.pollLoop();
  }

  async handleUpdate(update: TelegramUpdate) {
    if (update.message?.text?.startsWith("/start")) {
      const chatId = update.message.chat.id;
      await this.request("sendMessage", {
        chat_id: chatId,
        text: `Ваш Telegram chat_id: ${chatId}\nДобавьте его официанту в админке QR на стол.`
      });
      return;
    }

    const query = update.callback_query;
    if (!query?.data) return;

    const [, status, callId] = query.data.split(":");
    if ((status !== "accepted" && status !== "done") || !callId) return;

    const waiter = query.message ? this.store.findWaiterByChatId(query.message.chat.id) : null;
    const call = await this.store.updateCallStatus(callId, status, status === "accepted" ? waiter?.id : null);
    await this.request("answerCallbackQuery", {
      callback_query_id: query.id,
      text: status === "accepted" ? "Вызов принят" : "Вызов закрыт"
    });

    if (call && query.message) {
      const suffix = status === "accepted" ? "\n\nСтатус: принят" : "\n\nСтатус: готово";
      await this.request("editMessageText", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        text: `${query.message.text || "Вызов"}${suffix}`
      });
    }
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
      console.error(`[telegram] ${method}:`, json.description);
      return null;
    }

    return json.result ?? null;
  }
}
