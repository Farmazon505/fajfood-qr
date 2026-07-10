import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import type {
  AppData,
  CallAction,
  CallStatus,
  DiningTable,
  GuestFeedback,
  LoyaltyLead,
  Offer,
  ServiceCall,
  TelegramMessageRef,
  VenueSettings,
  Waiter
} from "./types";

const DATA_DIR = path.resolve(config.APP_DATA_DIR);
const DATA_FILE = path.join(DATA_DIR, "app.json");

const now = () => new Date().toISOString();

const defaultSettings: VenueSettings = {
  name: "Qrnastol Cafe",
  tagline: "Сканируйте QR и зовите персонал без ожидания",
  description:
    "Уютное городское кафе с завтраками, сезонными блюдами, быстрым сервисом и программой лояльности для постоянных гостей.",
  address: "Астрахань, ул. Набережная, 12",
  phone: "+7 999 000-00-00",
  hours: "Ежедневно 09:00-23:00",
  wifi: "QRNASTOL / coffee2026",
  logoUrl: "",
  heroImage:
    "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=1600&q=80",
  reviewUrl: "",
  loyaltyTitle: "Карта гостя",
  loyaltyText: "Зарегистрируйтесь один раз, чтобы копить и списывать бонусы в приложении и на кассе.",
  primaryColor: "#8b163f",
  accentColor: "#d6a45c",
  secondaryColor: "#f2c2c4",
  backgroundColor: "#120f17"
};

const defaultActions: CallAction[] = [
  {
    id: "action-waiter",
    label: "Позвать официанта",
    description: "Нужна помощь за столом",
    emoji: "🙋",
    active: true,
    sort: 10
  },
  {
    id: "action-order",
    label: "Сделать заказ",
    description: "Готовы выбрать блюда",
    emoji: "🍽️",
    active: true,
    sort: 20
  },
  {
    id: "action-card",
    label: "Счет картой",
    description: "Оплата банковской картой",
    emoji: "💳",
    active: true,
    sort: 30
  },
  {
    id: "action-cash",
    label: "Счет наличными",
    description: "Оплата наличными",
    emoji: "₽",
    active: true,
    sort: 40
  }
];

const defaultOffers: Offer[] = [
  {
    id: "offer-breakfast",
    title: "Завтраки до 12:00",
    description: "Кофе в подарок к любому завтраку из основного меню.",
    badge: "Утро",
    active: true
  },
  {
    id: "offer-loyalty",
    title: "500 ₽ за регистрацию",
    description: "Оформите карту гостя и получите приветственные бонусы на счет.",
    badge: "Бонус",
    active: true
  }
];

const defaultTables: DiningTable[] = [
  ...Array.from({ length: 9 }, (_, i) => {
    const num = i + 1; // 1 to 9
    return {
      id: `table-${num}`,
      name: `Стол ${num}`,
      slug: `table-${num}`,
      zone: "Зал 1-й этаж",
      waiterId: null,
      waiterIds: [],
      menuUrl: "https://fajfood.ru/qr?shop=1"
    };
  }),
  ...Array.from({ length: 12 }, (_, i) => {
    const num = i + 10; // 10 to 21
    return {
      id: `table-${num}`,
      name: `Стол ${num}`,
      slug: `table-${num}`,
      zone: "Зал 2-й этаж",
      waiterId: null,
      waiterIds: [],
      menuUrl: "https://fajfood.ru/qr?shop=1"
    };
  })
];

const createDefaultData = (): AppData => ({
  settings: defaultSettings,
  offers: defaultOffers,
  actions: defaultActions,
  waiters: [
    {
      id: "waiter-demo",
      name: "Дежурный официант",
      telegramChatId: "",
      tipUrl: "",
      active: true
    }
  ],
  tables: defaultTables,
  calls: [],
  loyaltyLeads: [],
  feedbacks: [],
  updatedAt: now()
});

const normalizeSlug = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const uniqueIds = (ids: string[]) => Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));

const tableWaiterIds = (table: Partial<DiningTable>) =>
  uniqueIds(Array.isArray(table.waiterIds) ? table.waiterIds : table.waiterId ? [table.waiterId] : []);

export class Store {
  private data: AppData = createDefaultData();
  private writeQueue = Promise.resolve();

  async init() {
    await mkdir(DATA_DIR, { recursive: true });
    try {
      const raw = await readFile(DATA_FILE, "utf-8");
      const stored = JSON.parse(raw) as Partial<AppData>;
      this.data = {
        ...createDefaultData(),
        ...stored,
        feedbacks: stored.feedbacks ?? [],
        loyaltyLeads: stored.loyaltyLeads ?? [],
        settings: {
          ...defaultSettings,
          ...(stored.settings ?? {})
        }
      };
      this.normalizeData();
    } catch {
      await this.persist();
    }
  }

  snapshot() {
    return structuredClone(this.data);
  }

  publicSnapshot() {
    const data = this.snapshot();
    return {
      settings: data.settings,
      offers: data.offers.filter((offer) => offer.active),
      actions: data.actions
        .filter((action) => action.active)
        .sort((left, right) => left.sort - right.sort),
      tables: data.tables
    };
  }

  findTableBySlug(slug: string) {
    return this.data.tables.find((table) => table.slug === slug) ?? null;
  }

  findTableById(id: string) {
    return this.data.tables.find((table) => table.id === id) ?? null;
  }

  findAction(id: string) {
    return this.data.actions.find((action) => action.id === id && action.active) ?? null;
  }

  findWaiterByChatId(chatId: string | number) {
    const normalized = String(chatId);
    return this.data.waiters.find((waiter) => waiter.telegramChatId.trim() === normalized) ?? null;
  }

  waitersForTable(table: DiningTable) {
    const activeWaiters = this.data.waiters.filter((waiter) => waiter.active && waiter.telegramChatId.trim());
    const assignedIds = tableWaiterIds(table);
    if (assignedIds.length) {
      const assigned = activeWaiters.filter((waiter) => assignedIds.includes(waiter.id));
      if (assigned.length) return assigned;
    }
    return activeWaiters;
  }

  tipTargetForTable(table: DiningTable) {
    const assignedIds = tableWaiterIds(table);
    const activeWaitersWithTips = this.data.waiters.filter((waiter) => waiter.active && waiter.tipUrl.trim());
    const candidates = assignedIds.length
      ? activeWaitersWithTips.filter((waiter) => assignedIds.includes(waiter.id))
      : activeWaitersWithTips;

    if (candidates.length === 1) return structuredClone(candidates[0]);

    const cutoff = Date.now() - 12 * 60 * 60 * 1000;
    const acceptedCall = this.data.calls.find((call) => {
      if (call.tableId !== table.id || !call.acceptedByWaiterId || !call.acceptedAt || call.status === "cancelled") {
        return false;
      }
      if (new Date(call.acceptedAt).getTime() < cutoff) return false;
      return candidates.some((waiter) => waiter.id === call.acceptedByWaiterId);
    });

    const target = acceptedCall
      ? candidates.find((waiter) => waiter.id === acceptedCall.acceptedByWaiterId)
      : null;

    return target ? structuredClone(target) : null;
  }

  async updateSettings(settings: VenueSettings) {
    this.data.settings = settings;
    await this.persist();
    return this.snapshot().settings;
  }

  private normalizeData() {
    this.data.waiters = this.data.waiters.map((waiter) => ({
      ...waiter,
      tipUrl: waiter.tipUrl ?? ""
    }));
    this.data.tables = this.data.tables.map((table) => {
      const waiterIds = tableWaiterIds(table);
      return {
        ...table,
        waiterId: waiterIds[0] ?? null,
        waiterIds
      };
    });
    this.data.calls = this.data.calls.map((call) => ({
      ...call,
      acceptedByWaiterId: call.acceptedByWaiterId ?? null
    }));
    this.data.loyaltyLeads = (this.data.loyaltyLeads ?? []).map((lead) => {
      const legacyLead = lead as LoyaltyLead & { consent?: boolean };
      return {
        ...lead,
        personalDataConsent: lead.personalDataConsent ?? legacyLead.consent ?? false,
        personalDataConsentVersion: lead.personalDataConsentVersion ?? "legacy",
        personalDataConsentHash: lead.personalDataConsentHash ?? "",
        personalDataConsentAcceptedAt: lead.personalDataConsentAcceptedAt ?? lead.createdAt,
        marketingConsent: lead.marketingConsent ?? legacyLead.consent ?? false,
        consentIpAddress: lead.consentIpAddress ?? "",
        consentUserAgent: lead.consentUserAgent ?? "",
        accessTokenHash: lead.accessTokenHash ?? "",
        verificationId: lead.verificationId ?? null,
        verificationExpiresAt: lead.verificationExpiresAt ?? null,
        phoneVerificationChannel: lead.phoneVerificationChannel ?? null,
        phoneVerifiedAt: lead.phoneVerifiedAt ?? null,
        crmUserId: lead.crmUserId ?? null,
        iikoCustomerId: lead.iikoCustomerId ?? null,
        cardNumber: lead.cardNumber ?? null,
        bonusBalance: Number.isFinite(lead.bonusBalance) ? lead.bonusBalance : 0,
        balanceUpdatedAt: lead.balanceUpdatedAt ?? null,
        welcomeBonusAmount: Number.isFinite(lead.welcomeBonusAmount) ? lead.welcomeBonusAmount : 0,
        welcomeBonusStatus: lead.welcomeBonusStatus ?? "LEGACY",
        syncError: lead.syncError ?? "",
        updatedAt: lead.updatedAt ?? lead.createdAt
      };
    });
  }

  async replaceOffers(offers: Offer[]) {
    this.data.offers = offers.map((offer) => ({
      ...offer,
      id: offer.id || randomUUID()
    }));
    await this.persist();
    return this.snapshot().offers;
  }

  async replaceActions(actions: CallAction[]) {
    this.data.actions = actions
      .map((action, index) => ({
        ...action,
        id: action.id || randomUUID(),
        sort: Number.isFinite(action.sort) ? action.sort : (index + 1) * 10
      }))
      .sort((left, right) => left.sort - right.sort);
    await this.persist();
    return this.snapshot().actions;
  }

  async replaceTables(tables: DiningTable[]) {
    this.data.tables = tables.map((table, index) => ({
      ...table,
      id: table.id || randomUUID(),
      name: table.name.trim() || `Стол ${index + 1}`,
      slug: normalizeSlug(table.slug || table.name || `table-${index + 1}`),
      waiterIds: tableWaiterIds(table),
      waiterId: tableWaiterIds(table)[0] ?? null
    }));
    await this.persist();
    return this.snapshot().tables;
  }

  async replaceWaiters(waiters: Waiter[]) {
    this.data.waiters = waiters.map((waiter) => ({
      ...waiter,
      id: waiter.id || randomUUID(),
      telegramChatId: waiter.telegramChatId.trim(),
      tipUrl: waiter.tipUrl.trim()
    }));
    await this.persist();
    return this.snapshot().waiters;
  }

  async addCall(input: {
    table: DiningTable;
    action: CallAction;
    comment: string;
    guestName: string;
    assignedWaiterId: string | null;
  }) {
    const call: ServiceCall = {
      id: randomUUID(),
      tableId: input.table.id,
      actionId: input.action.id,
      actionLabel: input.action.label,
      comment: input.comment.trim(),
      guestName: input.guestName.trim(),
      status: "new",
      assignedWaiterId: input.assignedWaiterId,
      acceptedByWaiterId: null,
      telegramMessages: [],
      createdAt: now(),
      acceptedAt: null,
      doneAt: null
    };

    this.data.calls.unshift(call);
    this.data.calls = this.data.calls.slice(0, 500);
    await this.persist();
    return structuredClone(call);
  }

  async attachTelegramMessages(callId: string, messages: TelegramMessageRef[]) {
    const call = this.data.calls.find((item) => item.id === callId);
    if (!call) return null;
    call.telegramMessages = messages;
    await this.persist();
    return structuredClone(call);
  }

  async updateCallStatus(callId: string, status: CallStatus, waiterId?: string | null) {
    const call = this.data.calls.find((item) => item.id === callId);
    if (!call) return null;

    call.status = status;
    if (status === "accepted" && !call.acceptedAt) {
      call.acceptedAt = now();
      call.acceptedByWaiterId = waiterId || null;
    }
    if (status === "done" && !call.doneAt) call.doneAt = now();
    await this.persist();
    return structuredClone(call);
  }

  findLoyaltyLeadByPhone(phone: string) {
    return this.data.loyaltyLeads.find((lead) => lead.phone === phone) ?? null;
  }

  findLoyaltyLeadByTokenHash(accessTokenHash: string) {
    return this.data.loyaltyLeads.find((lead) => lead.accessTokenHash === accessTokenHash) ?? null;
  }

  findLoyaltyLeadByVerificationId(verificationId: string) {
    return this.data.loyaltyLeads.find((lead) => lead.verificationId === verificationId) ?? null;
  }

  async addLoyaltyLead(input: Omit<LoyaltyLead, "id" | "createdAt" | "updatedAt">) {
    const timestamp = now();
    const lead: LoyaltyLead = {
      id: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp,
      ...input
    };
    this.data.loyaltyLeads.unshift(lead);
    await this.persist();
    return structuredClone(lead);
  }

  async updateLoyaltyLead(id: string, patch: Partial<Omit<LoyaltyLead, "id" | "createdAt">>) {
    const lead = this.data.loyaltyLeads.find((item) => item.id === id);
    if (!lead) return null;
    Object.assign(lead, patch, { updatedAt: now() });
    await this.persist();
    return structuredClone(lead);
  }

  async addFeedback(input: {
    tableId: string | null;
    waiterId: string | null;
    rating: number;
    reasons: string[];
    liked: string;
    disliked: string;
    guestName: string;
    phone: string;
  }) {
    const feedback: GuestFeedback = {
      id: randomUUID(),
      createdAt: now(),
      reviewClickCount: 0,
      reviewClickedAt: null,
      ...input
    };
    this.data.feedbacks.unshift(feedback);
    await this.persist();
    return structuredClone(feedback);
  }

  async incrementFeedbackReviewClick(feedbackId: string) {
    const feedback = this.data.feedbacks.find((item) => item.id === feedbackId);
    if (!feedback) return null;
    feedback.reviewClickCount += 1;
    feedback.reviewClickedAt = now();
    await this.persist();
    return structuredClone(feedback);
  }

  private async persist() {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      this.data.updatedAt = now();
      const tmp = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf-8");
      await rename(tmp, DATA_FILE);
    });
    await this.writeQueue;
  }
}
