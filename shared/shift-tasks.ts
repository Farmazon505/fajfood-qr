import type { ShiftTask, ShiftTaskRolloverRecord } from "../server/types";

export type ShiftTaskDisplayStatus = "in_progress" | "completed" | "carried";

export const dateKeyDistance = (fromDate: string, toDate: string) => {
  const from = Date.parse(`${fromDate}T12:00:00.000Z`);
  const to = Date.parse(`${toDate}T12:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
};

export const nextDateKey = (dateKey: string) => {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

export const shiftTaskStatus = (task: Pick<ShiftTask, "completedAt" | "rolloverProcessedAt" | "rolloverTargetDate">): ShiftTaskDisplayStatus => {
  if (task.completedAt) return "completed";
  if (task.rolloverProcessedAt || task.rolloverTargetDate) return "carried";
  return "in_progress";
};

export const shiftTaskDurationDays = (task: Pick<ShiftTask, "originalDate" | "date" | "completedDate" | "completionDays">) => {
  if (typeof task.completionDays === "number" && Number.isFinite(task.completionDays)) {
    return Math.max(0, Math.round(task.completionDays));
  }
  return dateKeyDistance(task.originalDate || task.date, task.completedDate || task.date);
};

export const latestShiftTaskRollover = (
  history: ShiftTaskRolloverRecord[] | undefined,
  waiterId?: string | null
) => [...(history || [])]
  .filter((record) => !waiterId || record.waiterId === waiterId)
  .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  .at(-1) ?? null;

export const formatTaskDays = (days: number) => {
  if (days === 0) return "в день назначения";
  const mod10 = days % 10;
  const mod100 = days % 100;
  const noun = mod10 === 1 && mod100 !== 11
    ? "день"
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
      ? "дня"
      : "дней";
  return `${days} ${noun}`;
};

export const formatRolloverCount = (count: number) => {
  const normalized = Math.max(0, Math.round(count));
  const mod10 = normalized % 10;
  const mod100 = normalized % 100;
  const noun = mod10 === 1 && mod100 !== 11
    ? "раз"
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
      ? "раза"
      : "раз";
  return `${normalized} ${noun}`;
};
