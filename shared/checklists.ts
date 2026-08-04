import type {
  ChecklistPhase,
  ChecklistTimeWindow,
  ChecklistWindows,
  ShiftChecklistEntry
} from "../server/types";

export const CHECKLIST_PHASES: ChecklistPhase[] = ["opening", "evening", "closing"];

export const DEFAULT_CHECKLIST_WINDOWS: ChecklistWindows = {
  opening: { start: "10:00", end: "12:30" },
  evening: { start: "18:00", end: "19:00" },
  closing: { start: "22:00", end: "02:00" }
};

export const CHECKLIST_PHASE_META: Record<ChecklistPhase, {
  icon: string;
  title: string;
  shortTitle: string;
}> = {
  opening: { icon: "🌅", title: "Чек-лист открытия", shortTitle: "Открытие" },
  evening: { icon: "🌇", title: "Открытие вечерней смены", shortTitle: "Вечерняя смена" },
  closing: { icon: "🌙", title: "Чек-лист закрытия", shortTitle: "Закрытие" }
};

export type ChecklistWindowStatus = "available" | "not_started" | "closed";

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export const normalizeChecklistPhase = (value: unknown): ChecklistPhase =>
  value === "closing" ? "closing" : value === "evening" ? "evening" : "opening";

export const normalizeChecklistWindows = (value: unknown): ChecklistWindows => {
  const source = value && typeof value === "object"
    ? value as Partial<Record<ChecklistPhase, Partial<ChecklistTimeWindow>>>
    : {};
  return Object.fromEntries(CHECKLIST_PHASES.map((phase) => {
    const fallback = DEFAULT_CHECKLIST_WINDOWS[phase];
    const proposed = source[phase];
    const start = typeof proposed?.start === "string" && TIME_PATTERN.test(proposed.start)
      ? proposed.start
      : fallback.start;
    const end = typeof proposed?.end === "string" && TIME_PATTERN.test(proposed.end)
      ? proposed.end
      : fallback.end;
    return [phase, start === end ? fallback : { start, end }];
  })) as ChecklistWindows;
};

export const validateChecklistWindows = (value: unknown): ChecklistWindows => {
  const source = value && typeof value === "object"
    ? value as Partial<Record<ChecklistPhase, Partial<ChecklistTimeWindow>>>
    : {};
  for (const phase of CHECKLIST_PHASES) {
    const window = source[phase];
    if (!window || !TIME_PATTERN.test(String(window.start || "")) || !TIME_PATTERN.test(String(window.end || ""))) {
      throw new Error(`Укажите корректное время для этапа «${CHECKLIST_PHASE_META[phase].title}»`);
    }
    if (window.start === window.end) {
      throw new Error(`Начало и окончание этапа «${CHECKLIST_PHASE_META[phase].title}» не могут совпадать`);
    }
  }
  return normalizeChecklistWindows(source);
};

const minutesFromTime = (value: string) => {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
};

const nextDateKey = (dateKey: string) => {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

const venueClock = (at: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value || "";
  return {
    dateKey: `${part("year")}-${part("month")}-${part("day")}`,
    minutes: Number(part("hour")) * 60 + Number(part("minute"))
  };
};

export const checklistWindowStatus = (
  phase: ChecklistPhase,
  windows: ChecklistWindows,
  operationalDate: string,
  at: Date,
  timeZone: string
): ChecklistWindowStatus => {
  const window = windows[phase];
  const start = minutesFromTime(window.start);
  const end = minutesFromTime(window.end);
  const clock = venueClock(at, timeZone);
  const nextDate = nextDateKey(operationalDate);

  if (start < end) {
    if (clock.dateKey < operationalDate) return "not_started";
    if (clock.dateKey > operationalDate) return "closed";
    if (clock.minutes < start) return "not_started";
    return clock.minutes <= end ? "available" : "closed";
  }

  if (clock.dateKey < operationalDate) return "not_started";
  if (clock.dateKey === operationalDate) return clock.minutes >= start ? "available" : "not_started";
  if (clock.dateKey === nextDate) return clock.minutes <= end ? "available" : "closed";
  return "closed";
};

export const openingPhaseForShiftStart = (
  windows: ChecklistWindows,
  operationalDate: string,
  at: Date,
  timeZone: string
): "opening" | "evening" => {
  if (checklistWindowStatus("opening", windows, operationalDate, at, timeZone) === "available") return "opening";
  if (checklistWindowStatus("evening", windows, operationalDate, at, timeZone) === "available") return "evening";

  const clock = venueClock(at, timeZone);
  const openingEnd = minutesFromTime(windows.opening.end);
  return clock.dateKey === operationalDate && clock.minutes <= openingEnd ? "opening" : "evening";
};

export const formatChecklistWindow = (window: ChecklistTimeWindow) => `${window.start}–${window.end}`;

export type ChecklistPhaseGroup = {
  phase: ChecklistPhase;
  entries: Array<{ item: ShiftChecklistEntry; index: number }>;
  completed: number;
  reviewed: number;
  averageScore: number | null;
};

export const groupChecklistByPhase = (items: ShiftChecklistEntry[]): ChecklistPhaseGroup[] =>
  CHECKLIST_PHASES.map((phase) => {
    const entries = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => normalizeChecklistPhase(item.phase) === phase);
    const scored = entries
      .map(({ item }) => item.adminScore)
      .filter((score): score is number => typeof score === "number");
    return {
      phase,
      entries,
      completed: entries.filter(({ item }) => Boolean(item.completedAt)).length,
      reviewed: scored.length,
      averageScore: scored.length
        ? Math.round((scored.reduce((sum, score) => sum + score, 0) / scored.length) * 100) / 100
        : null
    };
  }).filter((group) => group.entries.length > 0);
