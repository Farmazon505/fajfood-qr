import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import type {
  AppData,
  AdminAccessRole,
  CallAction,
  CallRoutingStage,
  CallStatus,
  ChecklistItem,
  DiningTable,
  GuestFeedback,
  LoyaltyLead,
  MaxMessageRef,
  Offer,
  OwnerNotificationSettings,
  PerformanceAnalytics,
  ServiceCall,
  ShiftTask,
  StaffRoleDefinition,
  StaffRoleKind,
  TelegramMessageRef,
  VenueSettings,
  Waiter,
  WaiterRating,
  WaiterShift
} from "./types";

const now = () => new Date().toISOString();
const OWNER_NOTIFICATION_RECIPIENT_ID = "owner-profile-notifications";
export const CHECKLIST_ITEM_COOLDOWN_MS = 60_000;
export const WAITER_ACCEPT_TIMEOUT_MS = 60_000;
export const WAITER_COMPLETE_TIMEOUT_MS = 2 * 60_000;
export const ADMIN_ACK_TIMEOUT_MS = 60_000;
export const CHECKLIST_OVERDUE_TIMEOUT_MS = config.CHECKLIST_OVERDUE_MINUTES * 60_000;

export type ChecklistCompletionResult =
  | { status: "completed"; shift: WaiterShift }
  | { status: "already_completed"; shift: WaiterShift }
  | { status: "cooldown"; shift: WaiterShift; retryAfterSeconds: number }
  | { status: "not_found"; shift: null };

export type ShiftTaskCompletionResult =
  | { status: "completed"; task: ShiftTask }
  | { status: "already_completed"; task: ShiftTask }
  | { status: "not_found"; task: null };

export type SupervisorShiftEndResult =
  | { status: "ended"; shift: WaiterShift }
  | { status: "not_found" }
  | { status: "already_ended" }
  | { status: "not_waiter" }
  | { status: "tables_assigned"; tableCount: number };

const venueDateKey = (value = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: config.VENUE_TIME_ZONE }).format(value);

const roundStars = (value: number) => Math.round(value * 100) / 100;
const clampStars = (value: number) => roundStars(Math.max(1, Math.min(5, value)));

const normalizeStoredStars = (value: unknown, completed: boolean) => {
  if (!completed || typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value > 5) return clampStars(value / 20);
  return clampStars(value);
};

const ratedChecklistItems = (shift: Pick<WaiterShift, "checklist">) =>
  shift.checklist.filter((item) => item.countsForRating !== false);

const checklistItemStars = (item: WaiterShift["checklist"][number]) => {
  if (!item.completedAt) return 0;
  return item.adminScore === null ? 5 : clampStars(item.adminScore);
};

const calculateShiftScore = (shift: Pick<WaiterShift, "checklist">) => {
  const ratedItems = ratedChecklistItems(shift);
  if (!ratedItems.length) return 0;
  return roundStars(ratedItems.reduce((sum, item) => sum + checklistItemStars(item), 0) / ratedItems.length);
};

const normalizedPatternTitle = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replace(/\s+/g, " ");

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

const defaultOwnerNotifications: OwnerNotificationSettings = {
  telegramChatId: "",
  maxUserId: "",
  telegramEnabled: false,
  maxEnabled: false,
  configured: false
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

const defaultStaffRoles: StaffRoleDefinition[] = [
  { id: "owner", name: "Владелец", kind: "owner", system: true, active: true },
  { id: "admin", name: "Администратор", kind: "admin", system: true, active: true },
  { id: "waiter", name: "Официант", kind: "waiter", system: true, active: true },
  { id: "barista", name: "Бариста", kind: "staff", system: true, active: true },
  { id: "cleaning", name: "Клининг", kind: "staff", system: true, active: true }
];

const defaultChecklistItems: ChecklistItem[] = [
  {
    id: "check-clean-tables",
    roleId: "waiter",
    title: "Проверить чистоту и сервировку столов",
    description: "Столы, стулья и сервировка готовы к приему гостей.",
    requiredForCalls: true,
    countsForRating: true,
    active: true,
    sort: 10
  },
  {
    id: "check-qr-menu",
    roleId: "waiter",
    title: "Проверить QR-коды и меню",
    description: "QR-коды читаются, меню и информационные материалы на месте.",
    requiredForCalls: true,
    countsForRating: true,
    active: true,
    sort: 20
  },
  {
    id: "check-station",
    roleId: "waiter",
    title: "Подготовить рабочую станцию",
    description: "Салфетки, приборы и расходные материалы пополнены.",
    requiredForCalls: true,
    countsForRating: true,
    active: true,
    sort: 30
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
  ownerNotifications: defaultOwnerNotifications,
  offers: defaultOffers,
  actions: defaultActions,
  staffRoles: defaultStaffRoles,
  waiters: [
    {
      id: "waiter-demo",
      name: "Дежурный официант",
      roleId: "waiter",
      telegramChatId: "",
      maxUserId: "",
      tipUrl: "",
      active: true
    }
  ],
  tables: defaultTables,
  checklistItems: defaultChecklistItems,
  shiftTasks: [],
  shifts: [],
  calls: [],
  loyaltyLeads: [],
  feedbacks: [],
  popups: [],
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
  private dataDir: string;
  private dataFile: string;

  constructor(dataDir = config.APP_DATA_DIR) {
    this.dataDir = path.resolve(dataDir);
    this.dataFile = path.join(this.dataDir, "app.json");
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await readFile(this.dataFile, "utf-8");
      const stored = JSON.parse(raw) as Partial<AppData>;
      const ownerRoleIds = new Set(
        (stored.staffRoles ?? defaultStaffRoles)
          .filter((role) => role.kind === "owner")
          .map((role) => role.id)
      );
      const legacyOwner = (stored.waiters ?? []).find((waiter) => ownerRoleIds.has(waiter.roleId));
      const migratedOwnerNotifications: OwnerNotificationSettings = stored.ownerNotifications ?? {
        telegramChatId: String(legacyOwner?.telegramChatId || "").trim(),
        maxUserId: String(legacyOwner?.maxUserId || "").trim(),
        telegramEnabled: Boolean(String(legacyOwner?.telegramChatId || "").trim()),
        maxEnabled: Boolean(String(legacyOwner?.maxUserId || "").trim()),
        configured: Boolean(legacyOwner)
      };
      this.data = {
        ...createDefaultData(),
        ...stored,
        staffRoles: stored.staffRoles ?? defaultStaffRoles,
        checklistItems: stored.checklistItems ?? defaultChecklistItems,
        shiftTasks: stored.shiftTasks ?? [],
        shifts: stored.shifts ?? [],
        feedbacks: stored.feedbacks ?? [],
        popups: stored.popups ?? [],
        loyaltyLeads: stored.loyaltyLeads ?? [],
        ownerNotifications: migratedOwnerNotifications,
        settings: {
          ...defaultSettings,
          ...(stored.settings ?? {})
        }
      };
      this.normalizeData();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
      tables: data.tables,
      popups: data.popups.filter(p => p.active).sort((a, b) => a.sort - b.sort)
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

  findRole(id: string) {
    return this.data.staffRoles.find((role) => role.id === id) ?? null;
  }

  roleForWaiter(waiter: Waiter) {
    return this.findRole(waiter.roleId) ?? this.findRole("waiter");
  }

  hasMessengerConnection(waiter: Waiter) {
    return Boolean(waiter.telegramChatId.trim() || waiter.maxUserId.trim());
  }

  private ownerNotificationRecipient() {
    const settings = this.data.ownerNotifications;
    const telegramChatId = settings.telegramEnabled ? settings.telegramChatId.trim() : "";
    const maxUserId = settings.maxEnabled ? settings.maxUserId.trim() : "";
    if (!telegramChatId && !maxUserId) return null;
    return {
      id: OWNER_NOTIFICATION_RECIPIENT_ID,
      name: "Владелец",
      roleId: "owner",
      telegramChatId,
      maxUserId,
      tipUrl: "",
      active: true
    } satisfies Waiter;
  }

  findWaiterByChatId(chatId: string | number) {
    const normalized = String(chatId);
    const owner = this.ownerNotificationRecipient();
    if (owner?.telegramChatId === normalized) return owner;
    return this.data.waiters.find((waiter) => waiter.telegramChatId.trim() === normalized) ?? null;
  }

  findWaiterByMaxUserId(userId: string | number) {
    const normalized = String(userId);
    const owner = this.ownerNotificationRecipient();
    if (owner?.maxUserId === normalized) return owner;
    return this.data.waiters.find((waiter) => waiter.maxUserId.trim() === normalized) ?? null;
  }

  findCallById(id: string) {
    const call = this.data.calls.find((item) => item.id === id);
    return call ? structuredClone(call) : null;
  }

  findShiftById(id: string) {
    const shift = this.data.shifts.find((item) => item.id === id);
    return shift ? structuredClone(shift) : null;
  }

  currentShiftForWaiter(waiterId: string) {
    const shift = this.data.shifts.find((item) => item.waiterId === waiterId && item.status !== "ended");
    return shift ? structuredClone(shift) : null;
  }

  listZones() {
    return Array.from(new Set(this.data.tables.map((table) => table.zone.trim()).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b, "ru")
    );
  }

  waiterRatings(roleId?: string): WaiterRating[] {
    const rows = this.data.waiters.filter((waiter) => !roleId || waiter.roleId === roleId).map((waiter) => {
      const role = this.roleForWaiter(waiter);
      const completedShifts = this.data.shifts.filter(
        (shift) => shift.waiterId === waiter.id && shift.roleId === role?.id && shift.status === "ended"
      ).filter((shift) => ratedChecklistItems(shift).length > 0)
        .sort((left, right) => new Date(right.endedAt || right.startedAt).getTime() - new Date(left.endedAt || left.startedAt).getTime());
      const scores = completedShifts.map((shift) => calculateShiftScore(shift));
      const totalStars = roundStars(scores.reduce((sum, value) => sum + value, 0));
      const score = scores.length ? roundStars(totalStars / scores.length) : 0;
      const ratedTaskCount = completedShifts.reduce((sum, shift) => sum + ratedChecklistItems(shift).length, 0);
      const completedRatedTaskCount = completedShifts.reduce(
        (sum, shift) => sum + ratedChecklistItems(shift).filter((item) => item.completedAt).length,
        0
      );
      const recent = scores.slice(0, 3);
      const previous = scores.slice(3, 6);
      const recentAverage = recent.length ? recent.reduce((sum, value) => sum + value, 0) / recent.length : 0;
      const previousAverage = previous.length ? previous.reduce((sum, value) => sum + value, 0) / previous.length : recentAverage;
      return {
        waiterId: waiter.id,
        waiterName: waiter.name,
        roleId: role?.id ?? "waiter",
        roleName: role?.name ?? "Официант",
        roleKind: role?.kind ?? "waiter",
        score,
        totalStars,
        ratedTaskCount,
        completedRatedTaskCount,
        completionRate: ratedTaskCount ? Math.round((completedRatedTaskCount / ratedTaskCount) * 100) : 0,
        trend: roundStars(recentAverage - previousAverage),
        shiftCount: completedShifts.length,
        rank: 0
      };
    });

    const ranked: WaiterRating[] = [];
    for (const currentRoleId of Array.from(new Set(rows.map((row) => row.roleId)))) {
      const group = rows
        .filter((row) => row.roleId === currentRoleId)
        .sort((left, right) => right.score - left.score || right.shiftCount - left.shiftCount || left.waiterName.localeCompare(right.waiterName, "ru"));
      ranked.push(...group.map((row, index) => ({ ...row, rank: index + 1 })));
    }
    return ranked.sort((left, right) => left.roleName.localeCompare(right.roleName, "ru") || left.rank - right.rank);
  }

  performanceAnalytics(roleIds?: string[], waiterIds?: string[]): PerformanceAnalytics {
    const allowedRoleIds = roleIds ? new Set(roleIds) : null;
    const allowedWaiterIds = waiterIds ? new Set(waiterIds) : null;
    const shifts = this.data.shifts.filter(
      (shift) =>
        shift.status === "ended" &&
        (!allowedRoleIds || allowedRoleIds.has(shift.roleId)) &&
        (!allowedWaiterIds || allowedWaiterIds.has(shift.waiterId))
    );
    type PatternAccumulator = {
      key: string;
      roleId: string;
      roleName: string;
      taskTitle: string;
      countsForRating: boolean;
      assignments: number;
      completed: number;
      missed: number;
      lowRatings: number;
      stars: number;
      affectedEmployees: Set<string>;
    };
    type EmployeeAccumulator = PatternAccumulator & { waiterId: string; waiterName: string };
    const taskMap = new Map<string, PatternAccumulator>();
    const employeeMap = new Map<string, EmployeeAccumulator>();

    for (const shift of shifts) {
      for (const item of shift.checklist) {
        const countsForRating = item.countsForRating !== false;
        const titleKey = normalizedPatternTitle(item.title);
        const taskKey = `${shift.roleId}:${countsForRating ? "rated" : "excluded"}:${titleKey}`;
        const employeeKey = `${shift.waiterId}:${shift.roleId}:${countsForRating ? "rated" : "excluded"}:${titleKey}`;
        const completed = Boolean(item.completedAt);
        const stars = countsForRating ? checklistItemStars(item) : 0;
        const lowRating = countsForRating && completed && stars < 4;
        const task = taskMap.get(taskKey) ?? {
          key: taskKey,
          roleId: shift.roleId,
          roleName: shift.roleName,
          taskTitle: item.title,
          countsForRating,
          assignments: 0,
          completed: 0,
          missed: 0,
          lowRatings: 0,
          stars: 0,
          affectedEmployees: new Set<string>()
        };
        task.assignments += 1;
        task.completed += completed ? 1 : 0;
        task.missed += completed ? 0 : 1;
        task.lowRatings += lowRating ? 1 : 0;
        task.stars += stars;
        if (!completed || lowRating) task.affectedEmployees.add(shift.waiterId);
        taskMap.set(taskKey, task);

        const employee = employeeMap.get(employeeKey) ?? {
          ...task,
          key: employeeKey,
          waiterId: shift.waiterId,
          waiterName: shift.waiterName,
          assignments: 0,
          completed: 0,
          missed: 0,
          lowRatings: 0,
          stars: 0,
          affectedEmployees: new Set<string>()
        };
        employee.assignments += 1;
        employee.completed += completed ? 1 : 0;
        employee.missed += completed ? 0 : 1;
        employee.lowRatings += lowRating ? 1 : 0;
        employee.stars += stars;
        employeeMap.set(employeeKey, employee);
      }
    }

    const taskPatterns = Array.from(taskMap.values())
      .map((item) => ({
        key: item.key,
        roleId: item.roleId,
        roleName: item.roleName,
        taskTitle: item.taskTitle,
        countsForRating: item.countsForRating,
        assignments: item.assignments,
        completed: item.completed,
        missed: item.missed,
        lowRatings: item.lowRatings,
        averageStars: item.countsForRating ? roundStars(item.stars / item.assignments) : null,
        issueRate: Math.round(((item.missed + item.lowRatings) / item.assignments) * 100),
        affectedEmployees: item.affectedEmployees.size
      }))
      .sort((left, right) => right.issueRate - left.issueRate || right.assignments - left.assignments);

    const employeePatterns = Array.from(employeeMap.values())
      .map((item) => {
        const issueRate = Math.round(((item.missed + item.lowRatings) / item.assignments) * 100);
        const recommendation = item.missed >= item.lowRatings
          ? `Стабилизировать выполнение «${item.taskTitle}»: использовать контрольную точку и подтверждать результат до завершения смены.`
          : `Сверить стандарт «${item.taskTitle}» с руководителем и отработать критерии качества на следующей смене.`;
        return {
          key: item.key,
          waiterId: item.waiterId,
          waiterName: item.waiterName,
          roleId: item.roleId,
          roleName: item.roleName,
          taskTitle: item.taskTitle,
          countsForRating: item.countsForRating,
          assignments: item.assignments,
          missed: item.missed,
          lowRatings: item.lowRatings,
          averageStars: item.countsForRating ? roundStars(item.stars / item.assignments) : null,
          issueRate,
          recommendation
        };
      })
      .filter((item) => item.assignments >= 2 && (item.missed > 0 || item.lowRatings > 0))
      .sort((left, right) => right.issueRate - left.issueRate || right.assignments - left.assignments);

    const ratings = this.waiterRatings().filter(
      (rating) =>
        (!allowedRoleIds || allowedRoleIds.has(rating.roleId)) &&
        (!allowedWaiterIds || allowedWaiterIds.has(rating.waiterId))
    );
    const roleSummaries = Array.from(new Set([
      ...ratings.map((rating) => rating.roleId),
      ...shifts.map((shift) => shift.roleId)
    ])).map((currentRoleId) => {
      const role = this.findRole(currentRoleId);
      const roleRatings = ratings.filter((rating) => rating.roleId === currentRoleId && rating.shiftCount > 0);
      const roleShifts = shifts.filter((shift) => shift.roleId === currentRoleId);
      const allItems = roleShifts.flatMap((shift) => shift.checklist);
      return {
        roleId: currentRoleId,
        roleName: role?.name || roleShifts[0]?.roleName || "Должность",
        employeeCount: this.data.waiters.filter(
          (waiter) =>
            waiter.roleId === currentRoleId &&
            waiter.active &&
            (!allowedWaiterIds || allowedWaiterIds.has(waiter.id))
        ).length,
        ratedShiftCount: roleRatings.reduce((sum, rating) => sum + rating.shiftCount, 0),
        averageStars: roleRatings.length
          ? roundStars(roleRatings.reduce((sum, rating) => sum + rating.score, 0) / roleRatings.length)
          : 0,
        completionRate: allItems.length
          ? Math.round((allItems.filter((item) => item.completedAt).length / allItems.length) * 100)
          : 0
      };
    }).sort((left, right) => left.roleName.localeCompare(right.roleName, "ru"));

    const recommendations = taskPatterns
      .filter((item) => item.assignments >= 2 && item.issueRate >= 25)
      .slice(0, 5)
      .map((item) =>
        `${item.roleName}: задача «${item.taskTitle}» дает сбой в ${item.issueRate}% случаев. Проверьте понятность стандарта, ресурсы и контроль выполнения.`
      );
    if (!recommendations.length) {
      recommendations.push("Недостаточно повторяющихся сбоев для устойчивого вывода. Продолжайте накапливать оценки по сменам.");
    }

    return {
      generatedAt: now(),
      analyzedShiftCount: shifts.length,
      roleSummaries,
      taskPatterns,
      employeePatterns,
      recommendations
    };
  }

  employeePerformanceRecommendation(waiterId: string) {
    return this.performanceAnalytics().employeePatterns.find((item) => item.waiterId === waiterId)?.recommendation || "";
  }

  waitersForTable(table: DiningTable) {
    const assignedIds = tableWaiterIds(table);
    if (!assignedIds.length) return [];

    return this.data.waiters.filter((waiter) => {
      if (!waiter.active || !this.hasMessengerConnection(waiter) || !assignedIds.includes(waiter.id)) return false;
      if (this.roleForWaiter(waiter)?.kind !== "waiter") return false;
      const shift = this.data.shifts.find(
        (item) => item.waiterId === waiter.id && item.status === "active" && item.zones.includes(table.zone)
      );
      return Boolean(shift);
    });
  }

  activeAdminsForTable(table: DiningTable) {
    return this.data.waiters.filter((member) => {
      if (!member.active || !this.hasMessengerConnection(member) || this.roleForWaiter(member)?.kind !== "admin") return false;
      return this.data.shifts.some(
        (shift) => shift.waiterId === member.id && shift.status !== "ended" && shift.zones.includes(table.zone)
      );
    });
  }

  ownersForEscalation() {
    if (this.data.ownerNotifications.configured) {
      const owner = this.ownerNotificationRecipient();
      return owner ? [owner] : [];
    }
    return this.data.waiters.filter(
      (member) => member.active && this.hasMessengerConnection(member) && this.roleForWaiter(member)?.kind === "owner"
    );
  }

  callFallbackReason(table: DiningTable) {
    const assigned = this.data.waiters.filter(
      (member) => tableWaiterIds(table).includes(member.id) && member.active && this.roleForWaiter(member)?.kind === "waiter"
    );
    if (!assigned.length) return "К столу не назначен официант.";

    const details = assigned.map((member) => {
      if (!this.hasMessengerConnection(member)) return `${member.name}: Telegram и MAX не подключены`;
      const shift = this.data.shifts.find((item) => item.waiterId === member.id && item.status !== "ended");
      if (!shift) return `${member.name}: смена не начата`;
      if (!shift.zones.includes(table.zone)) return `${member.name}: выбран другой этаж`;
      if (shift.status !== "active") return `${member.name}: обязательный чек-лист не завершен`;
      return `${member.name}: недоступен`;
    });
    return details.join("; ");
  }

  tipTargetForTable(table: DiningTable) {
    const candidates = this.waitersForTable(table).filter((waiter) => waiter.tipUrl.trim());

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

  async updateOwnerNotifications(settings: Omit<OwnerNotificationSettings, "configured">) {
    const telegramChatId = settings.telegramChatId.trim();
    const maxUserId = settings.maxUserId.trim();
    this.data.ownerNotifications = {
      telegramChatId,
      maxUserId,
      telegramEnabled: Boolean(settings.telegramEnabled && telegramChatId),
      maxEnabled: Boolean(settings.maxEnabled && maxUserId),
      configured: true
    };
    await this.persist();
    return structuredClone(this.data.ownerNotifications);
  }

  private normalizeData() {
    const storedRoles = (this.data.staffRoles ?? []).map((role) => ({
      ...role,
      id: normalizeSlug(role.id || role.name) || randomUUID(),
      name: role.name?.trim() || "Должность",
      kind: (["owner", "admin", "waiter", "staff"] as StaffRoleKind[]).includes(role.kind) ? role.kind : "staff",
      system: Boolean(role.system),
      active: role.active ?? true
    }));
    const roleMap = new Map(storedRoles.map((role) => [role.id, role]));
    for (const role of defaultStaffRoles) {
      roleMap.set(role.id, { ...role, ...(roleMap.get(role.id) ?? {}), kind: role.kind, system: true });
    }
    this.data.staffRoles = Array.from(roleMap.values());
    this.data.checklistItems = (this.data.checklistItems ?? defaultChecklistItems)
      .map((item, index) => ({
        ...item,
        id: item.id || randomUUID(),
        roleId: this.findRole(item.roleId)?.id ?? "waiter",
        title: item.title?.trim() || `Пункт ${index + 1}`,
        description: item.description ?? "",
        requiredForCalls: item.requiredForCalls ?? true,
        countsForRating: item.countsForRating ?? true,
        active: item.active ?? true,
        sort: Number.isFinite(item.sort) ? item.sort : (index + 1) * 10
      }))
      .sort((left, right) => left.sort - right.sort);
    this.data.shiftTasks = (this.data.shiftTasks ?? []).map((task) => ({
      ...task,
      id: task.id || randomUUID(),
      roleId: this.findRole(task.roleId)?.id ?? "waiter",
      waiterId: task.waiterId ?? null,
      date: task.date ?? venueDateKey(),
      title: task.title?.trim() || "Задание",
      description: task.description ?? "",
      requiredForCalls: task.requiredForCalls ?? false,
      countsForRating: task.countsForRating ?? true,
      notified: task.notified ?? false,
      completedAt: task.completedAt ?? null,
      createdAt: task.createdAt ?? now(),
      carriedFromTaskId: task.carriedFromTaskId ?? null,
      rolloverProcessedAt: task.rolloverProcessedAt ?? null,
      rolloverTargetDate: task.rolloverTargetDate ?? null
    }));
    this.data.waiters = this.data.waiters.map((waiter) => ({
      ...waiter,
      roleId: this.findRole(waiter.roleId)?.id ?? "waiter",
      telegramChatId: waiter.telegramChatId ?? "",
      maxUserId: waiter.maxUserId ?? "",
      tipUrl: waiter.tipUrl ?? ""
    }));
    const ownerNotifications = this.data.ownerNotifications ?? defaultOwnerNotifications;
    const ownerTelegramChatId = String(ownerNotifications.telegramChatId || "").trim();
    const ownerMaxUserId = String(ownerNotifications.maxUserId || "").trim();
    this.data.ownerNotifications = {
      telegramChatId: ownerTelegramChatId,
      maxUserId: ownerMaxUserId,
      telegramEnabled: Boolean(ownerNotifications.telegramEnabled && ownerTelegramChatId),
      maxEnabled: Boolean(ownerNotifications.maxEnabled && ownerMaxUserId),
      configured: Boolean(ownerNotifications.configured)
    };
    this.data.tables = this.data.tables.map((table) => {
      const waiterIds = tableWaiterIds(table);
      return {
        ...table,
        waiterId: waiterIds[0] ?? null,
        waiterIds
      };
    });
    this.data.shifts = (this.data.shifts ?? []).map((shift) => {
      const member = this.data.waiters.find((waiter) => waiter.id === shift.waiterId);
      const role = member ? this.roleForWaiter(member) : this.findRole(shift.roleId) ?? this.findRole("waiter");
      const normalized: WaiterShift = {
        ...shift,
        waiterName:
          shift.waiterName || member?.name || "Сотрудник",
        roleId: role?.id ?? "waiter",
        roleName: shift.roleName || role?.name || "Официант",
        roleKind: shift.roleKind || role?.kind || "waiter",
        zones: uniqueIds(shift.zones ?? []),
        status: shift.status ?? "ended",
        checklist: (shift.checklist ?? []).map((item, index) => ({
          ...item,
          itemId: item.itemId || randomUUID(),
          title: item.title || `Пункт ${index + 1}`,
          description: item.description ?? "",
          requiredForCalls: item.requiredForCalls ?? true,
          countsForRating: item.countsForRating ?? true,
          sort: Number.isFinite(item.sort) ? item.sort : (index + 1) * 10,
          completedAt: item.completedAt ?? null,
          adminScore: normalizeStoredStars(item.adminScore, Boolean(item.completedAt)),
          adminComment: item.adminComment ?? "",
          adminPhotoUrl: item.adminPhotoUrl ?? "",
          reviewedAt: item.reviewedAt ?? null,
          reviewedByRole: item.reviewedByRole ?? null,
          reviewedByUsername: item.reviewedByUsername ?? ""
        })),
        readyAt: shift.readyAt ?? null,
        endedAt: shift.endedAt ?? null,
        morningGreetingDate: shift.morningGreetingDate || venueDateKey(new Date(shift.startedAt)),
        checklistOverdueNotifiedAt: shift.checklistOverdueNotifiedAt ?? null,
        score: 0
      };
      normalized.score = calculateShiftScore(normalized);
      return normalized;
    });
    this.data.calls = this.data.calls.map((call) => ({
      ...call,
      threadVersion: call.threadVersion ?? 1,
      acceptedByWaiterId: call.acceptedByWaiterId ?? null,
      lastAcceptedByWaiterId: call.lastAcceptedByWaiterId ?? call.acceptedByWaiterId ?? null,
      acceptedByStaffId: call.acceptedByStaffId ?? call.acceptedByWaiterId ?? null,
      lastAcceptedByStaffId: call.lastAcceptedByStaffId ?? call.lastAcceptedByWaiterId ?? null,
      routingStage: call.routingStage ?? "waiter",
      routingReason: call.routingReason ?? "",
      adminEscalationStartedAt: call.adminEscalationStartedAt ?? null,
      adminAcknowledgedAt: call.adminAcknowledgedAt ?? null,
      adminWarningSentAt: call.adminWarningSentAt ?? null,
      ownerEscalatedAt: call.ownerEscalatedAt ?? null,
      ownerAcknowledgedAt: call.ownerAcknowledgedAt ?? null,
      pressCount: Number.isFinite(call.pressCount) && call.pressCount > 0 ? call.pressCount : 1,
      reasonCounts:
        Array.isArray(call.reasonCounts) && call.reasonCounts.length
          ? call.reasonCounts
          : [{ actionId: call.actionId, label: call.actionLabel, count: 1 }],
      cycleStartedAt: call.cycleStartedAt ?? call.createdAt,
      lastRequestedAt: call.lastRequestedAt ?? call.createdAt,
      telegramMessages: (call.telegramMessages ?? []).map((message) => ({
        ...message,
        recipientRole: message.recipientRole ?? "unknown",
        kind: message.kind ?? "call"
      })),
      maxMessages: (call.maxMessages ?? []).map((message) => ({
        ...message,
        recipientRole: message.recipientRole ?? "unknown",
        kind: message.kind ?? "call"
      }))
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
    this.data.popups = (this.data.popups ?? [])
      .map((popup, index) => ({
        ...popup,
        id: popup.id || randomUUID(),
        title: popup.title ?? "",
        body: popup.body ?? "",
        imageUrl: popup.imageUrl ?? "",
        buttonText: popup.buttonText ?? "",
        buttonUrl: popup.buttonUrl ?? "",
        active: popup.active ?? false,
        sort: Number.isFinite(popup.sort) ? popup.sort : (index + 1) * 10,
        createdAt: popup.createdAt ?? now()
      }))
      .sort((left, right) => left.sort - right.sort);
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

  async replaceStaffRoles(roles: StaffRoleDefinition[]) {
    const existingSystem = new Map(defaultStaffRoles.map((role) => [role.id, role]));
    const custom = roles
      .filter((role) => !existingSystem.has(role.id))
      .map((role) => ({
        id: normalizeSlug(role.id || role.name) || randomUUID(),
        name: role.name.trim() || "Должность",
        kind: "staff" as const,
        system: false,
        active: Boolean(role.active)
      }));
    const system = defaultStaffRoles.map((role) => {
      const submitted = roles.find((item) => item.id === role.id);
      const required = role.kind === "owner" || role.kind === "admin" || role.kind === "waiter";
      return { ...role, name: submitted?.name.trim() || role.name, active: required ? true : submitted?.active ?? true };
    });
    this.data.staffRoles = [...system, ...custom];
    const validRoleIds = new Set(this.data.staffRoles.map((role) => role.id));
    this.data.waiters = this.data.waiters.map((member) => ({
      ...member,
      roleId: validRoleIds.has(member.roleId) ? member.roleId : "waiter"
    }));
    this.data.checklistItems = this.data.checklistItems.map((item) => ({
      ...item,
      roleId: validRoleIds.has(item.roleId) ? item.roleId : "waiter"
    }));
    await this.persist();
    return this.snapshot().staffRoles;
  }

  async replaceChecklistItems(items: ChecklistItem[]) {
    this.data.checklistItems = items
      .map((item, index) => ({
        ...item,
        id: item.id || randomUUID(),
        roleId: this.findRole(item.roleId)?.id ?? "waiter",
        title: item.title.trim() || `Пункт ${index + 1}`,
        description: item.description.trim(),
        requiredForCalls: Boolean(item.requiredForCalls),
        countsForRating: item.countsForRating ?? true,
        active: Boolean(item.active),
        sort: Number.isFinite(item.sort) ? item.sort : (index + 1) * 10
      }))
      .sort((left, right) => left.sort - right.sort);
    await this.persist();
    return this.snapshot().checklistItems;
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
      roleId: this.findRole(waiter.roleId)?.id ?? "waiter",
      telegramChatId: waiter.telegramChatId.trim(),
      maxUserId: String(waiter.maxUserId || "").trim(),
      tipUrl: waiter.tipUrl.trim()
    }));
    await this.persist();
    return this.snapshot().waiters;
  }

  async startWaiterShift(waiterId: string, requestedZones: string[]) {
    const waiter = this.data.waiters.find((item) => item.id === waiterId && item.active);
    if (!waiter) return null;
    const role = this.roleForWaiter(waiter);
    if (!role?.active) return null;

    const existing = this.data.shifts.find((shift) => shift.waiterId === waiterId && shift.status !== "ended");
    if (existing) return { shift: structuredClone(existing), created: false, firstShiftToday: false };

    const availableZones = this.listZones();
    const zones = uniqueIds(requestedZones).filter((zone) => availableZones.includes(zone));
    if (!zones.length) return null;

    const dateKey = venueDateKey();
    const firstShiftToday = !this.data.shifts.some(
      (shift) => shift.waiterId === waiterId && shift.morningGreetingDate === dateKey
    );
    const templateItems = this.data.checklistItems
      .filter((item) => item.active && item.roleId === role.id)
      .sort((left, right) => left.sort - right.sort)
      .map((item) => ({
        itemId: item.id,
        title: item.title,
        description: item.description,
        requiredForCalls: item.requiredForCalls,
        countsForRating: item.countsForRating,
        sort: item.sort,
        completedAt: null as string | null,
        adminScore: null as number | null,
        adminComment: "",
        adminPhotoUrl: "",
        reviewedAt: null as string | null,
        reviewedByRole: null as AdminAccessRole | null,
        reviewedByUsername: ""
      }));
    // Добавляем задания на смену для текущей даты
    const todayTasks = this.data.shiftTasks
      .filter((task) => {
        if (task.completedAt) return false;
        if (task.date !== dateKey) return false;
        if (task.waiterId !== null) return task.waiterId === waiter.id;
        return task.roleId === role.id;
      })
      .map((task, idx) => ({
        itemId: `task-${task.id}`,
        title: task.title,
        description: task.description,
        requiredForCalls: task.requiredForCalls,
        countsForRating: task.countsForRating,
        sort: 10000 + idx * 10,
        completedAt: null as string | null,
        adminScore: null as number | null,
        adminComment: "",
        adminPhotoUrl: "",
        reviewedAt: null as string | null,
        reviewedByRole: null as AdminAccessRole | null,
        reviewedByUsername: ""
      }));
    const checklist = [...templateItems, ...todayTasks];
    const requiredComplete = checklist.every((item) => !item.requiredForCalls);
    const timestamp = now();
    const shift: WaiterShift = {
      id: randomUUID(),
      waiterId: waiter.id,
      waiterName: waiter.name,
      roleId: role.id,
      roleName: role.name,
      roleKind: role.kind,
      zones,
      status: requiredComplete ? "active" : "checklist",
      checklist,
      score: 0,
      startedAt: timestamp,
      readyAt: requiredComplete ? timestamp : null,
      endedAt: null,
      morningGreetingDate: dateKey,
      checklistOverdueNotifiedAt: null
    };

    this.data.shifts.unshift(shift);
    this.data.shifts = this.data.shifts.slice(0, 2000);
    if (role.kind === "waiter") {
      this.data.tables = this.data.tables.map((table) => {
        if (!zones.includes(table.zone)) return table;
        const waiterIds = uniqueIds([...tableWaiterIds(table), waiter.id]);
        return { ...table, waiterIds, waiterId: waiterIds[0] ?? null };
      });
    }
    await this.persist();
    return { shift: structuredClone(shift), created: true, firstShiftToday };
  }

  async completeShiftChecklistItem(
    shiftId: string,
    waiterId: string,
    itemIndex: number,
    completedAt = new Date()
  ): Promise<ChecklistCompletionResult> {
    const shift = this.data.shifts.find(
      (item) => item.id === shiftId && item.waiterId === waiterId && item.status !== "ended"
    );
    const item = shift?.checklist[itemIndex];
    if (!shift || !item) return { status: "not_found", shift: null };

    if (item.completedAt) {
      return { status: "already_completed", shift: structuredClone(shift) };
    }

    const completionTimestamp = completedAt.getTime();
    const latestCompletionTimestamp = shift.checklist.reduce((latest, entry) => {
      if (!entry.completedAt) return latest;
      const timestamp = new Date(entry.completedAt).getTime();
      return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
    }, 0);
    const cooldownRemainingMs = latestCompletionTimestamp + CHECKLIST_ITEM_COOLDOWN_MS - completionTimestamp;
    if (latestCompletionTimestamp > 0 && cooldownRemainingMs > 0) {
      return {
        status: "cooldown",
        shift: structuredClone(shift),
        retryAfterSeconds: Math.ceil(cooldownRemainingMs / 1000)
      };
    }

    const timestamp = completedAt.toISOString();
    item.completedAt = timestamp;
    if (item.itemId.startsWith("task-")) {
      const taskId = item.itemId.slice("task-".length);
      const task = this.data.shiftTasks.find(
        (entry) => entry.id === taskId && entry.waiterId === waiterId
      );
      if (task && !task.completedAt) task.completedAt = timestamp;
    }
    const requiredComplete = shift.checklist.every((entry) => !entry.requiredForCalls || entry.completedAt);
    if (requiredComplete && shift.status === "checklist") {
      shift.status = "active";
      shift.readyAt = timestamp;
    }
    shift.score = calculateShiftScore(shift);
    await this.persist();
    return { status: "completed", shift: structuredClone(shift) };
  }

  async reviewShiftChecklist(
    shiftId: string,
    reviews: Array<{ itemId: string; score: number | null; comment: string; photoUrl?: string }>,
    reviewedByRole: AdminAccessRole | null = null,
    reviewedByUsername = ""
  ) {
    const shift = this.data.shifts.find((item) => item.id === shiftId);
    if (!shift) return null;

    for (const review of reviews) {
      const item = shift.checklist.find((entry) => entry.itemId === review.itemId);
      if (!item) continue;
      item.adminScore = !item.completedAt || review.score === null || !Number.isFinite(review.score)
        ? null
        : clampStars(review.score);
      item.adminComment = review.comment.trim().slice(0, 500);
      if (review.photoUrl !== undefined) item.adminPhotoUrl = review.photoUrl.trim().slice(0, 240);
      item.reviewedAt = now();
      item.reviewedByRole = reviewedByRole;
      item.reviewedByUsername = reviewedByUsername.trim().slice(0, 64);
    }
    shift.score = calculateShiftScore(shift);
    await this.persist();
    return structuredClone(shift);
  }

  async endWaiterShift(waiterId: string) {
    const shift = this.data.shifts.find((item) => item.waiterId === waiterId && item.status !== "ended");
    if (!shift) return null;

    shift.status = "ended";
    shift.endedAt = now();
    shift.score = calculateShiftScore(shift);
    this.data.tables = this.data.tables.map((table) => {
      const waiterIds = tableWaiterIds(table).filter((id) => id !== waiterId);
      return { ...table, waiterIds, waiterId: waiterIds[0] ?? null };
    });
    await this.persist();
    return structuredClone(shift);
  }

  async endWaiterShiftById(shiftId: string) {
    const shift = this.data.shifts.find((item) => item.id === shiftId && item.status !== "ended");
    return shift ? this.endWaiterShift(shift.waiterId) : null;
  }

  shiftsDueForChecklistAlert(at: number, timeoutMs = CHECKLIST_OVERDUE_TIMEOUT_MS) {
    return this.data.shifts
      .filter((shift) => {
        if (
          shift.status !== "checklist" ||
          shift.roleKind === "owner" ||
          shift.checklistOverdueNotifiedAt
        ) {
          return false;
        }
        const startedAt = new Date(shift.startedAt).getTime();
        if (!Number.isFinite(startedAt) || at - startedAt < timeoutMs) return false;
        return shift.checklist.some((item) => item.requiredForCalls && !item.completedAt);
      })
      .map((shift) => structuredClone(shift));
  }

  async markChecklistOverdueNotified(shiftId: string, at = new Date()) {
    const shift = this.data.shifts.find(
      (item) => item.id === shiftId && item.status === "checklist" && !item.checklistOverdueNotifiedAt
    );
    if (!shift) return null;
    shift.checklistOverdueNotifiedAt = at.toISOString();
    await this.persist();
    return structuredClone(shift);
  }

  async endWaiterShiftBySupervisor(shiftId: string): Promise<SupervisorShiftEndResult> {
    const shift = this.data.shifts.find((item) => item.id === shiftId);
    if (!shift) return { status: "not_found" };
    if (shift.status === "ended") return { status: "already_ended" };
    if (shift.roleKind !== "waiter") return { status: "not_waiter" };

    const tableCount = this.data.tables.filter((table) => tableWaiterIds(table).includes(shift.waiterId)).length;
    if (tableCount > 0) return { status: "tables_assigned", tableCount };

    const ended = await this.endWaiterShift(shift.waiterId);
    return ended ? { status: "ended", shift: ended } : { status: "not_found" };
  }

  async upsertCall(input: {
    table: DiningTable;
    action: CallAction;
    comment: string;
    guestName: string;
    assignedWaiterId: string | null;
    routingStage: CallRoutingStage;
    routingReason: string;
  }) {
    const timestamp = now();
    const existing = this.data.calls.find(
      (item) =>
        item.threadVersion >= 2 &&
        item.tableId === input.table.id &&
        item.status !== "done" &&
        item.status !== "cancelled"
    );

    if (existing) {
      const startsNewCycle = existing.status === "accepted";
      existing.status = "new";
      existing.actionId = input.action.id;
      existing.actionLabel = input.action.label;
      existing.assignedWaiterId = input.assignedWaiterId;
      existing.lastRequestedAt = timestamp;
      existing.doneAt = null;
      if (input.comment.trim()) existing.comment = input.comment.trim();
      if (input.guestName.trim()) existing.guestName = input.guestName.trim();

      if (startsNewCycle) {
        existing.pressCount = 1;
        existing.reasonCounts = [{ actionId: input.action.id, label: input.action.label, count: 1 }];
        existing.cycleStartedAt = timestamp;
        existing.acceptedAt = null;
        existing.lastAcceptedByWaiterId = null;
        existing.lastAcceptedByStaffId = null;
        existing.routingStage = input.routingStage;
        existing.routingReason = input.routingReason;
        existing.adminEscalationStartedAt = input.routingStage === "admin" ? timestamp : null;
        existing.adminAcknowledgedAt = null;
        existing.adminWarningSentAt = null;
        existing.ownerEscalatedAt = input.routingStage === "owner" ? timestamp : null;
        existing.ownerAcknowledgedAt = null;
      } else {
        existing.pressCount += 1;
        const reason = existing.reasonCounts.find((item) => item.actionId === input.action.id);
        if (reason) reason.count += 1;
        else existing.reasonCounts.push({ actionId: input.action.id, label: input.action.label, count: 1 });
      }

      await this.persist();
      return structuredClone(existing);
    }

    const call: ServiceCall = {
      id: randomUUID(),
      threadVersion: 2,
      tableId: input.table.id,
      actionId: input.action.id,
      actionLabel: input.action.label,
      comment: input.comment.trim(),
      guestName: input.guestName.trim(),
      status: "new",
      assignedWaiterId: input.assignedWaiterId,
      acceptedByWaiterId: null,
      lastAcceptedByWaiterId: null,
      acceptedByStaffId: null,
      lastAcceptedByStaffId: null,
      routingStage: input.routingStage,
      routingReason: input.routingReason,
      adminEscalationStartedAt: input.routingStage === "admin" ? timestamp : null,
      adminAcknowledgedAt: null,
      adminWarningSentAt: null,
      ownerEscalatedAt: input.routingStage === "owner" ? timestamp : null,
      ownerAcknowledgedAt: null,
      pressCount: 1,
      reasonCounts: [{ actionId: input.action.id, label: input.action.label, count: 1 }],
      cycleStartedAt: timestamp,
      lastRequestedAt: timestamp,
      telegramMessages: [],
      maxMessages: [],
      createdAt: timestamp,
      acceptedAt: null,
      doneAt: null
    };

    this.data.calls.unshift(call);
    this.data.calls = this.data.calls.slice(0, 500);
    await this.persist();
    return structuredClone(call);
  }

  async replaceTelegramMessages(callId: string, messages: TelegramMessageRef[]) {
    const call = this.data.calls.find((item) => item.id === callId);
    if (!call) return null;
    const unique = new Map(
      messages.map((message) => [`${message.chatId}:${message.kind}:${message.recipientRole}`, message])
    );
    call.telegramMessages = Array.from(unique.values());
    await this.persist();
    return structuredClone(call);
  }

  async replaceMaxMessages(callId: string, messages: MaxMessageRef[]) {
    const call = this.data.calls.find((item) => item.id === callId);
    if (!call) return null;
    const unique = new Map(
      messages.map((message) => [`${message.userId}:${message.kind}:${message.recipientRole}`, message])
    );
    call.maxMessages = Array.from(unique.values());
    await this.persist();
    return structuredClone(call);
  }

  async appendMaxMessages(callId: string, messages: MaxMessageRef[]) {
    const call = this.data.calls.find((item) => item.id === callId);
    if (!call) return null;
    return this.replaceMaxMessages(callId, [...call.maxMessages, ...messages]);
  }

  async attachTelegramMessages(callId: string, messages: TelegramMessageRef[]) {
    return this.replaceTelegramMessages(callId, messages);
  }

  async appendTelegramMessages(callId: string, messages: TelegramMessageRef[]) {
    const call = this.data.calls.find((item) => item.id === callId);
    if (!call) return null;
    return this.replaceTelegramMessages(callId, [...call.telegramMessages, ...messages]);
  }

  callsDueForAdminEscalation(at: number) {
    return this.data.calls
      .filter((call) => {
        if (
          (call.status !== "new" && call.status !== "accepted") ||
          call.routingStage !== "waiter" ||
          call.adminEscalationStartedAt ||
          call.ownerEscalatedAt
        ) {
          return false;
        }
        const startedAt = call.status === "accepted" ? call.acceptedAt : call.lastRequestedAt;
        if (!startedAt) return false;
        const timeout = call.status === "accepted" ? WAITER_COMPLETE_TIMEOUT_MS : WAITER_ACCEPT_TIMEOUT_MS;
        return at - new Date(startedAt).getTime() >= timeout;
      })
      .map((call) => structuredClone(call));
  }

  callsDueForOwnerEscalation(at: number) {
    return this.data.calls
      .filter((call) => {
        if (
          (call.status !== "new" && call.status !== "accepted") ||
          call.routingStage !== "admin" ||
          !call.adminEscalationStartedAt ||
          call.adminAcknowledgedAt ||
          call.ownerEscalatedAt
        ) {
          return false;
        }
        return at - new Date(call.adminEscalationStartedAt).getTime() >= ADMIN_ACK_TIMEOUT_MS;
      })
      .map((call) => structuredClone(call));
  }

  async startAdminEscalation(callId: string, reason: string, at = new Date()) {
    const call = this.data.calls.find(
      (item) =>
        item.id === callId &&
        (item.status === "new" || item.status === "accepted") &&
        item.routingStage === "waiter"
    );
    if (!call || call.adminEscalationStartedAt || call.ownerEscalatedAt) return null;
    call.routingStage = "admin";
    call.routingReason = reason;
    call.adminEscalationStartedAt = at.toISOString();
    call.adminAcknowledgedAt = null;
    call.adminWarningSentAt = null;
    await this.persist();
    return structuredClone(call);
  }

  async markOwnerEscalated(callId: string, reason?: string, at = new Date()) {
    const call = this.data.calls.find(
      (item) => item.id === callId && (item.status === "new" || item.status === "accepted")
    );
    if (!call || call.ownerEscalatedAt) return null;
    call.ownerEscalatedAt = at.toISOString();
    call.ownerAcknowledgedAt = null;
    call.routingStage = "owner";
    if (reason) call.routingReason = reason;
    await this.persist();
    return structuredClone(call);
  }

  async acknowledgeEscalation(callId: string, role: "admin" | "owner") {
    const call = this.data.calls.find(
      (item) => item.id === callId && item.status !== "done" && item.status !== "cancelled"
    );
    if (!call) return null;
    if (role === "admin" && call.routingStage === "admin") {
      call.adminAcknowledgedAt = call.adminAcknowledgedAt || now();
    } else if (role === "owner" && call.routingStage === "owner") {
      call.ownerAcknowledgedAt = call.ownerAcknowledgedAt || now();
    } else {
      return null;
    }
    await this.persist();
    return structuredClone(call);
  }

  activeCallMessagesForChat(chatId: string | number) {
    const normalized = String(chatId);
    return this.data.calls
      .filter((call) => call.status !== "done" && call.status !== "cancelled")
      .flatMap((call) =>
        call.telegramMessages
          .filter((message) => message.chatId === normalized)
          .map((message) => ({ callId: call.id, ...message }))
      );
  }

  activeCallMessagesForMaxUser(userId: string | number) {
    const normalized = String(userId);
    return this.data.calls
      .filter((call) => call.status !== "done" && call.status !== "cancelled")
      .flatMap((call) =>
        call.maxMessages
          .filter((message) => message.userId === normalized)
          .map((message) => ({ callId: call.id, ...message }))
      );
  }

  pendingCallsForWaiter(waiterId: string) {
    const shift = this.data.shifts.find((item) => item.waiterId === waiterId && item.status === "active");
    if (!shift) return [];
    const tableIds = new Set(
      this.data.tables
        .filter((table) => shift.zones.includes(table.zone) && tableWaiterIds(table).includes(waiterId))
        .map((table) => table.id)
    );
    return this.data.calls
      .filter(
        (call) =>
          call.threadVersion >= 2 && call.status === "new" && call.routingStage === "waiter" && tableIds.has(call.tableId)
      )
      .map((call) => structuredClone(call));
  }

  async removeTelegramMessagesForChat(chatId: string | number) {
    const normalized = String(chatId);
    for (const call of this.data.calls) {
      call.telegramMessages = call.telegramMessages.filter((message) => message.chatId !== normalized);
    }
    await this.persist();
  }

  async removeMaxMessagesForUser(userId: string | number) {
    const normalized = String(userId);
    for (const call of this.data.calls) {
      call.maxMessages = call.maxMessages.filter((message) => message.userId !== normalized);
    }
    await this.persist();
  }

  async acceptCall(callId: string, waiterId: string) {
    const call = this.data.calls.find((item) => item.id === callId);
    const table = call ? this.data.tables.find((item) => item.id === call.tableId) : null;
    const waiter = this.findWaiterById(waiterId);
    if (!call || !table || !waiter?.active) return null;
    if (call.status !== "new") return { call: structuredClone(call), accepted: false, allowed: true };

    const roleKind = this.roleForWaiter(waiter)?.kind;
    const allowed =
      (call.routingStage === "waiter" && this.waitersForTable(table).some((item) => item.id === waiter.id)) ||
      (call.routingStage === "admin" &&
        roleKind === "admin" &&
        this.activeAdminsForTable(table).some((item) => item.id === waiter.id)) ||
      (call.routingStage === "owner" &&
        ((roleKind === "owner" && this.ownersForEscalation().some((item) => item.id === waiter.id)) ||
          (roleKind === "admin" && this.activeAdminsForTable(table).some((item) => item.id === waiter.id))));
    if (!allowed) return { call: structuredClone(call), accepted: false, allowed: false };

    call.status = "accepted";
    call.acceptedAt = now();
    call.acceptedByStaffId = call.acceptedByStaffId || waiter.id;
    call.lastAcceptedByStaffId = waiter.id;
    if (roleKind === "waiter") {
      call.acceptedByWaiterId = call.acceptedByWaiterId || waiter.id;
      call.lastAcceptedByWaiterId = waiter.id;
    }
    if (roleKind === "admin" && call.routingStage === "admin") {
      call.adminAcknowledgedAt = call.adminAcknowledgedAt || call.acceptedAt;
    }
    if (roleKind === "owner" && call.routingStage === "owner") {
      call.ownerAcknowledgedAt = call.ownerAcknowledgedAt || call.acceptedAt;
    }
    await this.persist();
    return { call: structuredClone(call), accepted: true, allowed: true };
  }

  async completeCall(callId: string) {
    const call = this.data.calls.find((item) => item.id === callId);
    if (!call) return null;
    call.status = "done";
    call.doneAt = now();
    await this.persist();
    return structuredClone(call);
  }

  async updateCallStatus(
    callId: string,
    status: CallStatus,
    waiterId?: string | null,
    accessRole?: "admin" | "owner"
  ) {
    const call = this.data.calls.find((item) => item.id === callId);
    if (!call) return null;

    call.status = status;
    if (status === "accepted") {
      call.acceptedAt = now();
      call.acceptedByStaffId = call.acceptedByStaffId || waiterId || null;
      call.lastAcceptedByStaffId = waiterId || call.lastAcceptedByStaffId;
      call.acceptedByWaiterId = call.acceptedByWaiterId || waiterId || null;
      call.lastAcceptedByWaiterId = waiterId || call.lastAcceptedByWaiterId;
      if (accessRole === "admin" && call.routingStage === "admin") {
        call.adminAcknowledgedAt = call.adminAcknowledgedAt || call.acceptedAt;
      }
      if (accessRole === "owner" && call.routingStage === "owner") {
        call.ownerAcknowledgedAt = call.ownerAcknowledgedAt || call.acceptedAt;
      }
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

  // ─── Popup methods ───────────────────────────────────────────────────

  listPopups() {
    return structuredClone(this.data.popups);
  }

  activePopups() {
    return structuredClone(this.data.popups.filter((p) => p.active));
  }

  async addPopup(popup: Omit<import("./types").PopupNotification, "id" | "createdAt">) {
    const newPopup: import("./types").PopupNotification = {
      ...popup,
      id: randomUUID(),
      createdAt: now()
    };
    this.data.popups.push(newPopup);
    this.data.popups.sort((a, b) => a.sort - b.sort);
    await this.persist();
    return structuredClone(newPopup);
  }

  async updatePopup(id: string, patch: Partial<Omit<import("./types").PopupNotification, "id" | "createdAt">>) {
    const popup = this.data.popups.find((p) => p.id === id);
    if (!popup) return null;
    Object.assign(popup, patch);
    this.data.popups.sort((a, b) => a.sort - b.sort);
    await this.persist();
    return structuredClone(popup);
  }

  async deletePopup(id: string) {
    const before = this.data.popups.length;
    this.data.popups = this.data.popups.filter((p) => p.id !== id);
    if (this.data.popups.length === before) return false;
    await this.persist();
    return true;
  }

  async replacePopups(popups: import("./types").PopupNotification[]) {
    this.data.popups = popups.map((p, index) => ({
      ...p,
      id: p.id || randomUUID(),
      sort: Number.isFinite(p.sort) ? p.sort : (index + 1) * 10
    })).sort((a, b) => a.sort - b.sort);
    await this.persist();
    return structuredClone(this.data.popups);
  }

  // ─── ShiftTask methods ───────────────────────────────────────────────

  private appendShiftTaskToActiveShifts(task: ShiftTask) {
    if (task.completedAt) return;
    for (const shift of this.data.shifts) {
      if (shift.status === "ended" || shift.morningGreetingDate !== task.date) continue;
      if (task.waiterId ? shift.waiterId !== task.waiterId : shift.roleId !== task.roleId) continue;

      const itemId = `task-${task.id}`;
      if (shift.checklist.some((item) => item.itemId === itemId)) continue;
      shift.checklist.push({
        itemId,
        title: task.title,
        description: task.description,
        requiredForCalls: task.requiredForCalls,
        countsForRating: task.countsForRating,
        sort: 10_000 + shift.checklist.filter((item) => item.itemId.startsWith("task-")).length * 10,
        completedAt: null,
        adminScore: null,
        adminComment: "",
        adminPhotoUrl: "",
        reviewedAt: null,
        reviewedByRole: null,
        reviewedByUsername: ""
      });
      if (task.requiredForCalls) {
        shift.status = "checklist";
        shift.readyAt = null;
      }
      shift.score = calculateShiftScore(shift);
    }
  }

  listShiftTasks(): ShiftTask[] {
    return structuredClone(this.data.shiftTasks);
  }

  findShiftTask(id: string): ShiftTask | null {
    const task = this.data.shiftTasks.find((item) => item.id === id);
    return task ? structuredClone(task) : null;
  }

  async addShiftTask(task: Omit<ShiftTask, "id" | "notified" | "completedAt" | "createdAt">): Promise<ShiftTask> {
    const newTask: ShiftTask = {
      ...task,
      id: randomUUID(),
      notified: false,
      completedAt: null,
      createdAt: now(),
      carriedFromTaskId: task.carriedFromTaskId ?? null,
      rolloverProcessedAt: task.rolloverProcessedAt ?? null,
      rolloverTargetDate: task.rolloverTargetDate ?? null
    };
    this.data.shiftTasks.unshift(newTask);
    this.appendShiftTaskToActiveShifts(newTask);

    await this.persist();
    return structuredClone(newTask);
  }

  async completeShiftTask(
    taskId: string,
    waiterId: string,
    completedAt = new Date()
  ): Promise<ShiftTaskCompletionResult> {
    const task = this.data.shiftTasks.find(
      (entry) => entry.id === taskId && entry.waiterId === waiterId
    );
    if (!task) return { status: "not_found", task: null };
    if (task.completedAt) return { status: "already_completed", task: structuredClone(task) };

    const timestamp = completedAt.toISOString();
    task.completedAt = timestamp;
    const itemId = `task-${task.id}`;
    for (const shift of this.data.shifts) {
      if (shift.waiterId !== waiterId || shift.morningGreetingDate !== task.date) continue;
      const item = shift.checklist.find((entry) => entry.itemId === itemId);
      if (!item || item.completedAt) continue;
      item.completedAt = timestamp;
      if (shift.status !== "ended") {
        const requiredComplete = shift.checklist.every(
          (entry) => !entry.requiredForCalls || entry.completedAt
        );
        if (requiredComplete && shift.status === "checklist") {
          shift.status = "active";
          shift.readyAt = timestamp;
        }
      }
      shift.score = calculateShiftScore(shift);
    }

    await this.persist();
    return { status: "completed", task: structuredClone(task) };
  }

  async rolloverIncompleteShiftTasks(targetDate: string, processedAt = new Date()): Promise<ShiftTask[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      throw new Error("Invalid shift task rollover date");
    }

    const timestamp = processedAt.toISOString();
    const candidates = this.data.shiftTasks
      .filter((task) => task.date < targetDate && !task.rolloverProcessedAt)
      .sort((left, right) => left.date.localeCompare(right.date) || left.createdAt.localeCompare(right.createdAt));
    if (!candidates.length) return [];

    const created: ShiftTask[] = [];
    for (const source of candidates) {
      const itemId = `task-${source.id}`;
      let waiterIds: string[] = [];

      if (source.waiterId) {
        const member = this.data.waiters.find(
          (waiter) => waiter.id === source.waiterId && waiter.active && waiter.roleId === source.roleId
        );
        const completed = Boolean(source.completedAt) || this.data.shifts.some(
          (shift) => shift.waiterId === source.waiterId
            && shift.morningGreetingDate === source.date
            && shift.checklist.some((item) => item.itemId === itemId && item.completedAt)
        );
        if (member && !completed) waiterIds = [member.id];
      } else {
        const assignedWaiterIds = new Set(
          this.data.shifts
            .filter(
              (shift) => shift.roleId === source.roleId
                && shift.morningGreetingDate === source.date
                && shift.checklist.some((item) => item.itemId === itemId)
            )
            .map((shift) => shift.waiterId)
        );
        waiterIds = Array.from(assignedWaiterIds).filter((waiterId) => {
          const member = this.data.waiters.find(
            (waiter) => waiter.id === waiterId && waiter.active && waiter.roleId === source.roleId
          );
          if (!member) return false;
          return !this.data.shifts.some(
            (shift) => shift.waiterId === waiterId
              && shift.morningGreetingDate === source.date
              && shift.checklist.some((item) => item.itemId === itemId && item.completedAt)
          );
        });
      }

      for (const waiterId of waiterIds) {
        const alreadyCreated = this.data.shiftTasks.some(
          (task) => task.date === targetDate
            && task.waiterId === waiterId
            && task.carriedFromTaskId === source.id
        );
        if (alreadyCreated) continue;

        const carriedTask: ShiftTask = {
          id: randomUUID(),
          roleId: source.roleId,
          waiterId,
          date: targetDate,
          title: source.title,
          description: source.description,
          requiredForCalls: source.requiredForCalls,
          countsForRating: source.countsForRating,
          notified: false,
          completedAt: null,
          createdAt: timestamp,
          carriedFromTaskId: source.id,
          rolloverProcessedAt: null,
          rolloverTargetDate: null
        };
        this.data.shiftTasks.unshift(carriedTask);
        this.appendShiftTaskToActiveShifts(carriedTask);
        created.push(carriedTask);
      }

      source.rolloverProcessedAt = timestamp;
      source.rolloverTargetDate = targetDate;
    }

    await this.persist();
    return structuredClone(created);
  }

  async deleteShiftTask(id: string): Promise<boolean> {
    const before = this.data.shiftTasks.length;
    this.data.shiftTasks = this.data.shiftTasks.filter((task) => task.id !== id);
    if (this.data.shiftTasks.length === before) return false;
    await this.persist();
    return true;
  }

  async markShiftTaskNotified(id: string): Promise<void> {
    const task = this.data.shiftTasks.find((t) => t.id === id);
    if (task) {
      task.notified = true;
      await this.persist();
    }
  }

  /** Возвращает задания с конкретным сотрудником (waiterId != null) на сегодня,
   *  которым ещё не было отправлено уведомление */
  getShiftTasksForNotification(dateKey: string): ShiftTask[] {
    return structuredClone(
      this.data.shiftTasks.filter(
        (task) => task.date === dateKey && task.waiterId !== null && !task.notified && !task.completedAt
      )
    );
  }

  /** Находит сотрудника по id */
  findWaiterById(id: string) {
    if (id === OWNER_NOTIFICATION_RECIPIENT_ID) return this.ownerNotificationRecipient();
    return this.data.waiters.find((w) => w.id === id) ?? null;
  }

  private async persist() {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      this.data.updatedAt = now();
      const tmp = `${this.dataFile}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf-8");
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          await rename(tmp, this.dataFile);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if ((code !== "EPERM" && code !== "EACCES") || attempt === 3) break;
          await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
        }
      }
      await copyFile(tmp, this.dataFile);
      await unlink(tmp).catch(() => undefined);
    });
    await this.writeQueue;
  }
}
