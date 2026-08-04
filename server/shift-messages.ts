import type { ChecklistWindows, ShiftTask, ShiftTaskRolloverRecord, WaiterShift } from "./types";
import {
  CHECKLIST_PHASE_META,
  DEFAULT_CHECKLIST_WINDOWS,
  checklistWindowStatus,
  formatChecklistWindow,
  groupChecklistByPhase
} from "../shared/checklists";
import {
  dateKeyDistance,
  formatRolloverCount,
  formatTaskDays,
  latestShiftTaskRollover,
  shiftTaskDurationDays,
  shiftTaskStatus
} from "../shared/shift-tasks";

export const shiftTaskText = (task: ShiftTask, roleLabel: string) => {
  const requiredLabel = task.requiredForCalls ? " (обязательное для допуска)" : "";
  const status = shiftTaskStatus(task);
  const rolloverCount = task.rolloverCount || 0;
  const latestRollover = latestShiftTaskRollover(task.rolloverHistory, task.waiterId);
  const duration = shiftTaskDurationDays(task);
  return [
    `🗓 Задание на смену ${task.date}`,
    "",
    `Должность: ${roleLabel}`,
    `Задание: ${task.title}${requiredLabel}`,
    task.description ? `Пояснение: ${task.description}` : "",
    status === "completed"
      ? "Статус: ✅ Задание выполнено"
      : `Статус: ${status === "carried" ? "🔁 Перенесено" : "🟠 В работе"}`,
    `Перенесено: ${formatRolloverCount(rolloverCount)}`,
    task.completedAt
      ? `Срок выполнения: ${formatTaskDays(duration)}`
      : `В работе с даты назначения: ${formatTaskDays(duration)}`,
    latestRollover?.reason ? `Комментарий переноса: ${latestRollover.reason}` : "",
    latestRollover && !latestRollover.reason ? "Комментарий переноса: ожидается причина сотрудника" : "",
    task.completedAt ? "" : "Нажмите кнопку ниже после выполнения."
  ].filter(Boolean).join("\n");
};

export const shiftTaskRolloverText = (task: ShiftTask, record: ShiftTaskRolloverRecord) => [
  "🔁 Задача перенесена на следующий день",
  "",
  `Задание: ${task.title}`,
  `Новая дата: ${record.toDate}`,
  `Перенесено: ${formatRolloverCount(task.rolloverCount || 0)}`,
  `В работе с даты назначения: ${formatTaskDays(shiftTaskDurationDays(task))}`,
  "",
  "Объясните причину невыполнения задания. Нажмите кнопку ниже и отправьте причину одним сообщением."
].join("\n");

export const shiftChecklistText = (
  shift: WaiterShift,
  windows: ChecklistWindows = DEFAULT_CHECKLIST_WINDOWS,
  timeZone = "Europe/Astrakhan",
  at = new Date()
) => {
  const required = shift.checklist.filter((item) => item.phase !== "closing" && item.requiredForCalls);
  const requiredDone = required.filter((item) => item.completedAt).length;
  const rows = groupChecklistByPhase(shift.checklist).flatMap((group, groupIndex) => {
    const meta = CHECKLIST_PHASE_META[group.phase];
    const status = checklistWindowStatus(group.phase, windows, shift.morningGreetingDate, at, timeZone);
    const pending = group.entries.some(({ item }) => !item.completedAt);
    const pendingDatedTask = group.entries.some(({ item }) => item.itemId.startsWith("task-") && !item.completedAt);
    const availability = !pending
      ? "✅ Этап выполнен"
      : status === "available" || pendingDatedTask
        ? "🟢 Можно выполнять сейчас"
        : status === "not_started"
          ? `⏳ Доступ откроется в ${windows[group.phase].start}`
          : `🔒 Время заполнения истекло в ${windows[group.phase].end}`;
    return [
      ...(groupIndex ? [""] : []),
      `${meta.icon} ${meta.title.toLocaleUpperCase("ru-RU")} · ${formatChecklistWindow(windows[group.phase])}`,
      availability,
      ...group.entries.map(({ item, index }) => {
        const marker = item.completedAt ? "✅" : "⬜";
        const requiredLabel = group.phase !== "closing" && item.requiredForCalls ? " · обязательно" : "";
        const ratingLabel = item.countsForRating === false ? " · без рейтинга" : "";
        const description = item.description.trim();
        const isDatedTask = item.itemId.startsWith("task-");
        const latestRollover = latestShiftTaskRollover(item.taskRolloverHistory, shift.waiterId);
        const taskDuration = item.taskCompletionDays
          ?? dateKeyDistance(item.taskOriginalDate || shift.morningGreetingDate, shift.morningGreetingDate);
        return [
          `${marker} ${index + 1}. ${item.title}${requiredLabel}${ratingLabel}`,
          description ? `   Выполнить: ${description}` : "",
          isDatedTask ? `   Статус: ${item.completedAt ? "выполнено" : "в работе"}` : "",
          isDatedTask ? `   Перенесено: ${formatRolloverCount(item.taskRolloverCount || 0)}` : "",
          isDatedTask && item.completedAt
            ? `   Срок выполнения: ${formatTaskDays(taskDuration)}`
            : isDatedTask
              ? `   В работе: ${formatTaskDays(taskDuration)}`
              : "",
          latestRollover?.reason ? `   Комментарий переноса: ${latestRollover.reason}` : "",
          latestRollover && !latestRollover.reason ? "   Комментарий переноса: ожидается" : ""
        ].filter(Boolean).join("\n");
      })
    ];
  });
  const checklistRows = shift.checklist.length
    ? rows
    : ["Чек-лист на сегодня пуст."];
  const admission = shift.status === "active"
    ? "Обязательные пункты выполнены"
    : `Готовность: ${requiredDone}/${required.length}`;
  const criticalNote = shift.roleKind === "admin"
    ? "Критические вызовы гостей включены с начала смены."
    : "";
  return [
    `Чек-лист: ${shift.roleName}`,
    `Этажи: ${shift.zones.join(", ")}`,
    "",
    ...checklistRows,
    "",
    admission,
    shift.checklist.length > 1 ? "Интервал между пунктами одного чек-листа — 1 минута." : "",
    closingItemsPendingText(shift),
    criticalNote
  ]
    .filter(Boolean)
    .join("\n");
};

const closingItemsPendingText = (shift: WaiterShift) => {
  const closing = shift.checklist.filter((item) => item.phase === "closing");
  const pending = closing.filter((item) => !item.completedAt).length;
  if (!closing.length) return "";
  return pending
    ? `До завершения смены осталось выполнить пунктов закрытия: ${pending}.`
    : "Чек-лист закрытия выполнен.";
};

export const shiftStartedText = (shift: WaiterShift) => {
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
};
