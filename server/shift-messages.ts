import type { ShiftTask, WaiterShift } from "./types";

export const shiftTaskText = (task: ShiftTask, roleLabel: string) => {
  const requiredLabel = task.requiredForCalls ? " (обязательное для допуска)" : "";
  return [
    `🗓 Задание на смену ${task.date}`,
    "",
    `Должность: ${roleLabel}`,
    `Задание: ${task.title}${requiredLabel}`,
    task.description ? `Пояснение: ${task.description}` : "",
    task.completedAt ? "" : "Нажмите кнопку ниже после выполнения.",
    task.completedAt ? "✅ Задание выполнено" : ""
  ].filter(Boolean).join("\n");
};

export const shiftChecklistText = (shift: WaiterShift) => {
  const required = shift.checklist.filter((item) => item.phase === "opening" && item.requiredForCalls);
  const requiredDone = required.filter((item) => item.completedAt).length;
  const rowsForPhase = (phase: "opening" | "closing") => {
    const entries = shift.checklist.map((item, index) => ({ item, index })).filter(({ item }) => item.phase === phase);
    if (!entries.length) return [];
    return [phase === "opening" ? "🌅 ЧЕК-ЛИСТ ОТКРЫТИЯ" : "🌙 ЧЕК-ЛИСТ ЗАКРЫТИЯ", ...entries.map(({ item, index }) => {
        const marker = item.completedAt ? "✅" : "⬜";
        const requiredLabel = phase === "opening" && item.requiredForCalls ? " · обязательно" : "";
        const ratingLabel = item.countsForRating === false ? " · без рейтинга" : "";
        const description = item.description.trim();
        return [
          `${marker} ${index + 1}. ${item.title}${requiredLabel}${ratingLabel}`,
          description ? `   Выполнить: ${description}` : ""
        ].filter(Boolean).join("\n");
      })];
  };
  const rows = shift.checklist.length
    ? [...rowsForPhase("opening"), "", ...rowsForPhase("closing")]
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
    ...rows,
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
