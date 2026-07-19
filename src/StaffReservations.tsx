import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Move,
  RefreshCw,
  Save,
  Users,
  X,
} from "lucide-react";
import "./staff-reservations.css";

type ReservationStatus =
  | "PENDING"
  | "CONFIRMED"
  | "SEATED"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW"
  | "WAITLIST";

type StaffReservation = {
  id: string;
  isIikoExternal: boolean;
  guestName: string;
  guestPhone: string | null;
  guestsCount: number;
  date: string;
  duration: number;
  deposit: number;
  depositPaid: boolean;
  notes: string | null;
  guestNotes: string | null;
  tags: string[];
  status: ReservationStatus;
  source: string;
  responsible: string | null;
  tableId: string | null;
};

type StaffTable = {
  id: string;
  number: number;
  capacity: number;
  hall: string;
  posX: number;
  posY: number;
  shape: string;
  width: number;
  height: number;
  label: string | null;
  iikoState: {
    online: boolean;
    occupied: boolean;
    activeOrder: { number: string; status: string; sum: number | null } | null;
  };
  reservations: StaffReservation[];
};

type StaffData = {
  profile: {
    name: string;
    role: string;
    zones: string[];
    shiftStatus: "checklist" | "active";
    canEdit: boolean;
  };
  date: string;
  halls: Array<{ key: string; name: string; emoji: string; color: string }>;
  tables: StaffTable[];
  iikoSync: { online: boolean; occupiedTables: number; errors: string[] };
};

type TelegramWebApp = {
  initData: string;
  ready: () => void;
  expand: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  HapticFeedback?: {
    notificationOccurred: (type: "success" | "error" | "warning") => void;
  };
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

const statusLabels: Record<ReservationStatus, string> = {
  PENDING: "Новая",
  CONFIRMED: "Подтверждена",
  SEATED: "Гости за столом",
  COMPLETED: "Завершена",
  CANCELLED: "Отменена",
  NO_SHOW: "Не пришли",
  WAITLIST: "Лист ожидания",
};

const terminalStatuses = new Set<ReservationStatus>(["COMPLETED", "CANCELLED", "NO_SHOW"]);
const activeStatuses = new Set<ReservationStatus>(["PENDING", "CONFIRMED", "SEATED", "WAITLIST"]);

const astrakhanDateKey = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Astrakhan",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

const formatTime = (value: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Astrakhan",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

const formatDate = (value: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Astrakhan",
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(new Date(`${value}T08:00:00+04:00`));

const reservationForTable = (table: StaffTable) => {
  const active = table.reservations
    .filter((reservation) => activeStatuses.has(reservation.status))
    .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime());
  return active.find((reservation) => reservation.status === "SEATED") || active[0] || null;
};

const tableState = (table: StaffTable, reservation: StaffReservation | null) => {
  if (table.iikoState.occupied) return "occupied";
  if (!reservation) return "free";
  if (reservation.status === "SEATED") return "seated";
  if (reservation.status === "PENDING") return "pending";
  if (reservation.status === "WAITLIST") return "waitlist";
  const startsIn = (new Date(reservation.date).getTime() - Date.now()) / 60_000;
  return startsIn <= 30 ? "soon" : "confirmed";
};

const nextStatuses = (status: ReservationStatus) => {
  if (status === "PENDING") return ["CONFIRMED", "CANCELLED"] as ReservationStatus[];
  if (status === "CONFIRMED") return ["SEATED", "NO_SHOW", "CANCELLED"] as ReservationStatus[];
  if (status === "SEATED") return ["COMPLETED"] as ReservationStatus[];
  if (status === "WAITLIST") return ["CONFIRMED", "CANCELLED"] as ReservationStatus[];
  return [];
};

const actionLabel: Partial<Record<ReservationStatus, string>> = {
  CONFIRMED: "Подтвердить",
  SEATED: "Гости пришли",
  COMPLETED: "Завершить",
  CANCELLED: "Отменить",
  NO_SHOW: "Не пришли",
};

const readTelegramInitData = () => {
  const sdkInitData = window.Telegram?.WebApp?.initData?.trim();
  if (sdkInitData) return sdkInitData;

  for (const source of [window.location.hash, window.location.search]) {
    const params = new URLSearchParams(source.replace(/^[#?]/, ""));
    const initData = params.get("tgWebAppData")?.trim();
    if (initData) return initData;
  }

  return "";
};

export default function StaffReservations() {
  const [date, setDate] = useState(astrakhanDateKey);
  const [data, setData] = useState<StaffData | null>(null);
  const [selectedHall, setSelectedHall] = useState("");
  const [selected, setSelected] = useState<StaffReservation | null>(null);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mapViewportRef = useRef<HTMLDivElement>(null);

  const telegram = window.Telegram?.WebApp;
  const initData = readTelegramInitData();

  useEffect(() => {
    telegram?.ready();
    telegram?.expand();
    telegram?.setHeaderColor?.("#111a16");
    telegram?.setBackgroundColor?.("#0d1411");
  }, [telegram]);

  const load = useCallback(async (quiet = false) => {
    if (!initData) {
      setError("Откройте брони кнопкой из Telegram-бота Qrnastol.");
      setLoading(false);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(`/api/staff/reservations?date=${encodeURIComponent(date)}`, {
        headers: { "x-telegram-init-data": initData },
        cache: "no-store",
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Не удалось загрузить брони");
      setData(json);
      setError("");
      setSelectedHall((current) => json.halls.some((hall: { key: string }) => hall.key === current)
        ? current
        : json.halls[0]?.key || "");
      setSelected((current) => {
        if (!current) return null;
        return json.tables
          .flatMap((table: StaffTable) => table.reservations)
          .find((reservation: StaffReservation) => reservation.id === current.id) || null;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "CRM временно недоступна");
    } finally {
      setLoading(false);
    }
  }, [date, initData]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load(true), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => setNotes(selected?.notes || ""), [selected]);

  const hallTables = useMemo(
    () => (data?.tables || []).filter((table) => table.hall === selectedHall),
    [data, selectedHall]
  );
  const canvasWidth = Math.max(960, ...hallTables.map((table) => table.posX + table.width + 40));
  const canvasHeight = Math.max(400, ...hallTables.map((table) => table.posY + table.height + 40));
  const hallOrigin = useMemo(() => ({
    left: hallTables.length ? Math.max(0, Math.min(...hallTables.map((table) => table.posX)) - 20) : 0,
    top: hallTables.length ? Math.max(0, Math.min(...hallTables.map((table) => table.posY)) - 20) : 0,
  }), [hallTables]);
  const selectedTable = data?.tables.find((table) => table.id === selected?.tableId) || null;
  const reservations = useMemo(
    () => (data?.tables || [])
      .flatMap((table) => table.reservations.map((reservation) => ({ reservation, table })))
      .filter(({ reservation }) => !terminalStatuses.has(reservation.status))
      .sort((left, right) => new Date(left.reservation.date).getTime() - new Date(right.reservation.date).getTime()),
    [data]
  );

  useEffect(() => {
    mapViewportRef.current?.scrollTo({ left: hallOrigin.left, top: hallOrigin.top });
  }, [hallOrigin.left, hallOrigin.top, selectedHall]);

  const patchReservation = async (payload: Record<string, unknown>, successText: string) => {
    if (!selected || !data?.profile.canEdit) return;
    setSaving(true);
    setNotice("");
    try {
      const response = await fetch(`/api/staff/reservations/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-telegram-init-data": initData,
        },
        body: JSON.stringify({ date, ...payload }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Не удалось изменить бронь");
      telegram?.HapticFeedback?.notificationOccurred("success");
      setNotice(successText);
      await load(true);
    } catch (saveError) {
      telegram?.HapticFeedback?.notificationOccurred("error");
      setNotice(saveError instanceof Error ? saveError.message : "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (status: ReservationStatus) => {
    let reason = "";
    if (status === "CANCELLED" || status === "NO_SHOW") {
      reason = window.prompt(status === "CANCELLED" ? "Укажите причину отмены" : "Комментарий к неявке")?.trim() || "";
      if (!reason) return;
    }
    await patchReservation({ status, ...(reason ? { reason } : {}) }, `Статус: ${statusLabels[status]}`);
  };

  const moveDate = (days: number) => {
    const next = new Date(`${date}T08:00:00+04:00`);
    next.setDate(next.getDate() + days);
    setDate(astrakhanDateKey(next));
    setSelected(null);
  };

  if (loading && !data) {
    return <div className="staff-reservations-state"><RefreshCw className="spin" />Загружаем шахматку…</div>;
  }

  if (!data) {
    return (
      <div className="staff-reservations-state staff-reservations-state--error">
        <CalendarDays size={34} />
        <strong>Брони недоступны</strong>
        <span>{error}</span>
        <button onClick={() => void load()}>Повторить</button>
      </div>
    );
  }

  return (
    <main className="staff-reservations-shell">
      <header className="staff-reservations-header">
        <div>
          <span className="staff-reservations-kicker">QRNASTOL · STAFF</span>
          <h1>Брони столов</h1>
          <p>{data.profile.name} · {data.profile.role}</p>
        </div>
        <button className="staff-icon-button" onClick={() => void load()} aria-label="Обновить">
          <RefreshCw size={19} className={loading ? "spin" : ""} />
        </button>
      </header>

      {!data.profile.canEdit && (
        <div className="staff-warning">Завершите обязательный чек-лист смены. До этого шахматка доступна только для просмотра.</div>
      )}
      {error && <div className="staff-error">{error}</div>}

      <section className="staff-date-card">
        <button onClick={() => moveDate(-1)} aria-label="Предыдущий день"><ChevronLeft /></button>
        <div><CalendarDays size={17} /><strong>{formatDate(date)}</strong></div>
        <button onClick={() => moveDate(1)} aria-label="Следующий день"><ChevronRight /></button>
      </section>

      <div className="staff-sync-row">
        <span className={data.iikoSync.online ? "online" : "offline"} />
        {data.iikoSync.online
          ? `iiko онлайн · занято ${data.iikoSync.occupiedTables}`
          : "iiko временно недоступна"}
        <span>· обновление 10 сек.</span>
      </div>

      <nav className="staff-hall-tabs">
        {data.halls.map((hall) => (
          <button
            key={hall.key}
            className={hall.key === selectedHall ? "active" : ""}
            onClick={() => setSelectedHall(hall.key)}
          >
            <span>{hall.emoji}</span>{hall.name}
          </button>
        ))}
      </nav>

      <section className="staff-map-card">
        {hallTables.length ? (
          <>
            <div className="staff-map-toolbar">
              <span><Move size={14} />Двигайте схему пальцем</span>
              <span>{hallTables.length} столов</span>
            </div>
            <div className="staff-map-viewport" ref={mapViewportRef}>
              <div className="staff-map" style={{ width: canvasWidth, height: canvasHeight }}>
                {hallTables.map((table) => {
                  const reservation = reservationForTable(table);
                  const state = tableState(table, reservation);
                  return (
                    <button
                      key={table.id}
                      className={`staff-table staff-table--${state} ${table.shape === "round" ? "round" : ""}`}
                      style={{
                        left: table.posX,
                        top: table.posY,
                        width: table.width,
                        height: table.height,
                      }}
                      onClick={() => reservation ? setSelected(reservation) : undefined}
                    >
                      <strong>№{table.number}</strong>
                      <span>{table.iikoState.occupied
                        ? `Заказ ${table.iikoState.activeOrder?.number || "iiko"}`
                        : reservation ? formatTime(reservation.date) : `${table.capacity} мест`}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        ) : <div className="staff-empty">Для выбранной зоны столы не найдены</div>}
      </section>

      <div className="staff-legend">
        <span><i className="free" />Свободен</span>
        <span><i className="pending" />Новая бронь</span>
        <span><i className="confirmed" />Подтверждена</span>
        <span><i className="soon" />Скоро</span>
        <span><i className="occupied" />Занят</span>
      </div>

      <section className="staff-upcoming">
        <div className="staff-section-title">
          <div><Clock3 size={18} /><h2>Ближайшие брони</h2></div>
          <span>{reservations.length}</span>
        </div>
        {reservations.length ? reservations.map(({ reservation, table }) => (
          <button key={reservation.id} className="staff-reservation-row" onClick={() => setSelected(reservation)}>
            <time>{formatTime(reservation.date)}</time>
            <div>
              <strong>{reservation.guestName}</strong>
              <span>Стол №{table.number} · {reservation.guestsCount} чел.</span>
            </div>
            <em className={`status-${reservation.status.toLowerCase()}`}>{statusLabels[reservation.status]}</em>
          </button>
        )) : <div className="staff-empty">Активных броней на этот день нет</div>}
      </section>

      {selected && (
        <div className="staff-sheet-backdrop" onClick={() => setSelected(null)}>
          <section className="staff-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="staff-sheet-handle" />
            <button className="staff-sheet-close" onClick={() => setSelected(null)}><X /></button>
            <span className={`staff-status-pill status-${selected.status.toLowerCase()}`}>{statusLabels[selected.status]}</span>
            <h2>{selected.guestName}</h2>
            <div className="staff-sheet-facts">
              <span><Clock3 />{formatTime(selected.date)}</span>
              <span><Users />{selected.guestsCount} гостей</span>
              <span>Стол №{selectedTable?.number || "—"}</span>
            </div>
            {selected.guestPhone && <a className="staff-phone" href={`tel:${selected.guestPhone}`}>{selected.guestPhone}</a>}
            {selected.guestNotes && <div className="staff-guest-note"><strong>Важно для гостя</strong>{selected.guestNotes}</div>}
            {selected.deposit > 0 && (
              <div className="staff-deposit">Депозит {selected.deposit.toLocaleString("ru-RU")} ₽ · {selected.depositPaid ? "оплачен" : "не оплачен"}</div>
            )}

            {!selected.isIikoExternal && !terminalStatuses.has(selected.status) && (
              <label className="staff-field">
                <span>Перенести за другой стол</span>
                <select
                  value={selected.tableId || ""}
                  disabled={!data.profile.canEdit || saving}
                  onChange={(event) => void patchReservation({ tableId: event.target.value }, "Стол изменён")}
                >
                  {data.tables.map((table) => {
                    const busy = table.id !== selected.tableId && (
                      table.iikoState.occupied
                      || table.reservations.some((reservation) => (
                        reservation.id !== selected.id
                        && ["PENDING", "CONFIRMED", "SEATED"].includes(reservation.status)
                      ))
                    );
                    return (
                      <option key={table.id} value={table.id} disabled={busy}>
                        Стол №{table.number} · {data.halls.find((hall) => hall.key === table.hall)?.name}{busy ? " · занят" : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
            )}

            {!selected.isIikoExternal && (
              <label className="staff-field">
                <span>Комментарий к брони</span>
                <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} disabled={!data.profile.canEdit || saving} />
                <button className="staff-save-note" disabled={!data.profile.canEdit || saving || notes === (selected.notes || "")} onClick={() => void patchReservation({ notes }, "Комментарий сохранён")}>
                  <Save size={16} />Сохранить комментарий
                </button>
              </label>
            )}

            {notice && <div className={notice.includes("Не удалось") || notice.includes("ошиб") ? "staff-action-error" : "staff-action-notice"}>{notice}</div>}

            {!selected.isIikoExternal && (
              <div className="staff-actions">
                {nextStatuses(selected.status).map((status) => (
                  <button
                    key={status}
                    className={`action-${status.toLowerCase()}`}
                    disabled={!data.profile.canEdit || saving}
                    onClick={() => void changeStatus(status)}
                  >
                    {status === "CONFIRMED" || status === "SEATED" || status === "COMPLETED" ? <Check size={17} /> : <X size={17} />}
                    {actionLabel[status]}
                  </button>
                ))}
              </div>
            )}
            {selected.isIikoExternal && <div className="staff-warning">Эта бронь создана в iiko и изменяется на кассе.</div>}
          </section>
        </div>
      )}
    </main>
  );
}
