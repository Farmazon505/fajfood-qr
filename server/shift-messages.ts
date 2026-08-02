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
  const required = shift.checklist.filter((item) => item.requiredForCalls);
  const requiredDone = required.filter((item) => item.completedAt).length;
  const rows = shift.checklist.length
    ? shift.checklist.map((item, index) => {
        const marker = item.completedAt ? "✅" : "⬜";
        const requiredLabel = item.requiredForCalls ? " · обязательно" : "";
        const ratingLabel = item.countsForRating === false ? " · без рейтинга" : "";
        const description = item.description.trim();
        return [
          `${marker} ${index + 1}. ${item.title}${requiredLabel}${ratingLabel}`,
          description ? `   Выполнить: ${description}` : ""
        ].filter(Boolean).join("\n");
      })
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
    shift.checklist.length > 1 ? "Следующий пункт можно отметить через 1 минуту после предыдущего." : "",
    criticalNote
  ]
    .filter(Boolean)
    .join("\n");
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
