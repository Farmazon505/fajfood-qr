import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { TableTentDesigner } from "./TableTentDesigner";
import {
  BellRing,
  ArrowDown,
  ArrowUp,
  Briefcase,
  CalendarDays,
  ChevronLeft,
  Check,
  CheckCircle2,
  CircleHelp,
  ClipboardCheck,
  Clock,
  CreditCard,
  Gift,
  HeartHandshake,
  ImageIcon,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MapPin,
  MessageSquare,
  Palette,
  Phone,
  Plus,
  Printer,
  QrCode,
  ReceiptText,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Sparkles,
  Utensils,
  Star,
  AlertTriangle,
  Table2,
  Tags,
  Trash2,
  Trophy,
  Upload,
  UserRound,
  Users,
  Wifi,
  Megaphone,
  ChevronRight,
  X
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type {
  AppData,
  AdminAccountSummary,
  AdminAccessRole,
  CallAction,
  CallStatus,
  ChecklistItem,
  DiningTable,
  GuestFeedback,
  LoyaltyLead,
  Offer,
  PerformanceAnalytics,
  PerformanceInsightReport,
  ServiceCall,
  ShiftTask,
  StaffRoleDefinition,
  VenueSettings,
  Waiter,
  WaiterRating,
  WaiterShift,
  PopupNotification
} from "../server/types";

type Bootstrap = {
  settings: VenueSettings;
  offers: Offer[];
  actions: CallAction[];
  table: DiningTable | null;
  popups: PopupNotification[];
  publicBaseUrl: string;
  legal: {
    personalDataConsentVersion: string;
    personalDataConsentUrl: string;
    marketingConsentUrl: string;
    privacyPolicyUrl: string;
  };
};

type LoyaltyProfile = {
  userId: string;
  name: string;
  phoneMasked: string;
  iikoCustomerId: string | null;
  cardNumber: string | null;
  bonusBalance: number;
  balanceUpdatedAt: string | null;
  welcomeBonus: {
    amount: number;
    status: string;
    granted: boolean;
  };
};

type LoyaltyVerification = {
  id: string;
  accessToken: string;
  expiresAt: string;
  channels: {
    telegram: { url: string } | null;
    max: { url: string } | null;
  };
};

const LOYALTY_TOKEN_KEY = "qrnastol.loyaltyToken";

type TipTarget = {
  enabled: boolean;
  waiterName?: string;
  url?: string;
  message?: string;
};

type AdminData = AppData & {
  publicBaseUrl: string;
  telegramEnabled: boolean;
  telegramBotUrl: string;
  ratings: WaiterRating[];
  performance: PerformanceAnalytics;
  performanceAiEnabled: boolean;
  accessRole: AdminAccessRole;
  username: string;
  adminAccount: AdminAccountSummary | null;
  popups: PopupNotification[];
};

const api = async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || "Ошибка запроса");
  return json as T;
};

const statusLabel: Record<CallStatus, string> = {
  new: "Новый",
  accepted: "Принят",
  done: "Готово",
  cancelled: "Отменен"
};

const formatDate = (value: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));

type BrandStyle = CSSProperties & Record<`--${string}`, string>;

const brandStyle = (settings: VenueSettings): BrandStyle => ({
  "--brand-primary": settings.primaryColor || "#7a1f43",
  "--brand-accent": settings.accentColor || "#c89a58",
  "--brand-secondary": settings.secondaryColor || "#f2c2c4",
  "--brand-bg": settings.backgroundColor || "#202030"
});

const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

type GuestView = "call" | "offers" | "loyalty" | "info" | "feedback";
type SentAction = { id: string; label: string } | null;

const guestViewFromPath = (path: string): GuestView => {
  const view = path.split("/").filter(Boolean)[2];
  return view === "offers" || view === "loyalty" || view === "info" || view === "feedback" ? view : "call";
};

export default function App() {
  const path = window.location.pathname;
  if (path.startsWith("/admin")) return <AdminPage />;
  return <GuestPage />;
}

function GuestPage() {
  const tableSlug = decodeURIComponent(window.location.pathname.replace(/^\/t\/?/, "").split("/")[0] || "");
  const [data, setData] = useState<Bootstrap | null>(null);
  const [showPopups, setShowPopups] = useState(false);
  const [error, setError] = useState("");
  const [comment, setComment] = useState("");
  const [guestName, setGuestName] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [orderModalAction, setOrderModalAction] = useState<CallAction | null>(null);
  const [tipBusy, setTipBusy] = useState(false);
  const [tipNotice, setTipNotice] = useState("");
  const [sentAction, setSentAction] = useState<SentAction>(null);
  const [view, setView] = useState<GuestView>(() => guestViewFromPath(window.location.pathname));
  const [loyalty, setLoyalty] = useState({
    name: "",
    phone: "",
    birthday: "",
    personalDataConsent: false,
    marketingConsent: false
  });
  const [loyaltyProfile, setLoyaltyProfile] = useState<LoyaltyProfile | null>(null);
  const [loyaltyVerification, setLoyaltyVerification] = useState<LoyaltyVerification | null>(null);
  const [loyaltyBusy, setLoyaltyBusy] = useState(false);
  const [loyaltyError, setLoyaltyError] = useState("");
  const [loyaltyStale, setLoyaltyStale] = useState(false);

  const [feedbackRating, setFeedbackRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [feedbackReasons, setFeedbackReasons] = useState<string[]>([]);
  const [feedbackLiked, setFeedbackLiked] = useState("");
  const [feedbackDisliked, setFeedbackDisliked] = useState("");
  const [feedbackName, setFeedbackName] = useState("");
  const [feedbackPhone, setFeedbackPhone] = useState("");
  const [feedbackDone, setFeedbackDone] = useState(false);
  const [feedbackId, setFeedbackId] = useState("");

  useEffect(() => {
    api<Bootstrap>(`/api/public/bootstrap?table=${encodeURIComponent(tableSlug)}`)
      .then(setData)
      .catch((requestError) => setError(requestError.message));
  }, [tableSlug]);

  useEffect(() => {
    const handlePopState = () => setView(guestViewFromPath(window.location.pathname));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!data || !data.popups || data.popups.length === 0) return;
    const popupKey = `qrnastol.popupsSeen:${data.popups.map((popup) => popup.id).join(",")}`;
    const seen = sessionStorage.getItem(popupKey) === "true";
    if (!seen) {
      const timer = setTimeout(() => setShowPopups(true), 600);
      return () => clearTimeout(timer);
    }
  }, [data]);

  const closePopups = () => {
    if (data?.popups.length) {
      sessionStorage.setItem(`qrnastol.popupsSeen:${data.popups.map((popup) => popup.id).join(",")}`, "true");
    }
    setShowPopups(false);
  };

  const handlePopupAction = (url: string) => {
    closePopups();
    if (url.startsWith("http://") || url.startsWith("https://")) {
      window.open(url, "_blank", "noopener,noreferrer");
    } else {
      const targetView = guestViewFromPath(url);
      if (targetView) navigateGuest(targetView);
    }
  };

  useEffect(() => {
    if (!sentAction) return undefined;
    const timeout = window.setTimeout(() => setSentAction(null), 10000);
    return () => window.clearTimeout(timeout);
  }, [sentAction]);

  useEffect(() => {
    if (!tipNotice) return undefined;
    const timeout = window.setTimeout(() => setTipNotice(""), 6000);
    return () => window.clearTimeout(timeout);
  }, [tipNotice]);

  const loadLoyaltyProfile = useCallback(async () => {
    const token = localStorage.getItem(LOYALTY_TOKEN_KEY);
    if (!token) return;
    setLoyaltyBusy(true);
    setLoyaltyError("");
    try {
      const result = await api<{ profile: LoyaltyProfile; stale?: boolean }>("/api/public/loyalty/profile", {
        headers: { authorization: `Bearer ${token}` }
      });
      setLoyaltyProfile(result.profile);
      setLoyaltyStale(Boolean(result.stale));
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Не удалось загрузить карту гостя";
      setLoyaltyError(message);
      if (/не найдена на этом устройстве/i.test(message)) localStorage.removeItem(LOYALTY_TOKEN_KEY);
    } finally {
      setLoyaltyBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadLoyaltyProfile();
  }, [loadLoyaltyProfile]);

  useEffect(() => {
    if (!loyaltyVerification) return undefined;

    let stopped = false;
    let timeoutId = 0;
    const schedule = () => {
      if (!stopped) timeoutId = window.setTimeout(poll, 2500);
    };
    const poll = async () => {
      if (Date.now() >= new Date(loyaltyVerification.expiresAt).getTime()) {
        setLoyaltyError("Время подтверждения истекло. Заполните анкету еще раз.");
        setLoyaltyVerification(null);
        return;
      }

      try {
        const response = await fetch(
          `/api/public/loyalty/verification/${encodeURIComponent(loyaltyVerification.id)}`,
          { headers: { authorization: `Bearer ${loyaltyVerification.accessToken}` } },
        );
        const result = await response.json().catch(() => ({}));
        if (response.status === 202) {
          schedule();
          return;
        }
        if (!response.ok) throw new Error(result.error || "Не удалось проверить номер");

        localStorage.setItem(LOYALTY_TOKEN_KEY, loyaltyVerification.accessToken);
        setLoyaltyProfile(result.profile as LoyaltyProfile);
        setLoyaltyStale(false);
        setLoyaltyVerification(null);
        setLoyaltyError("");
        setLoyalty({
          name: "",
          phone: "",
          birthday: "",
          personalDataConsent: false,
          marketingConsent: false,
        });
      } catch (requestError) {
        setLoyaltyError(requestError instanceof Error ? requestError.message : "Не удалось проверить номер");
        schedule();
      }
    };

    timeoutId = window.setTimeout(poll, 1200);
    return () => {
      stopped = true;
      window.clearTimeout(timeoutId);
    };
  }, [loyaltyVerification]);

  const navigateGuest = (nextView: GuestView) => {
    const suffix = nextView === "call" ? "" : `/${nextView}`;
    window.history.pushState(null, "", `/t/${tableSlug}${suffix}`);
    setView(nextView);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const sendCall = async (action: CallAction) => {
    if (!data?.table) return;
    setBusyAction(action.id);
    setSentAction(null);
    setTipNotice("");
    setError("");

    try {
      await api("/api/public/calls", {
        method: "POST",
        body: JSON.stringify({
          tableSlug: data.table.slug,
          actionId: action.id,
          comment,
          guestName
        })
      });
      setSentAction({ id: action.id, label: action.label });
      setComment("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось отправить вызов");
    } finally {
      setBusyAction("");
    }
  };

  const openTips = async () => {
    if (!data?.table) return;
    setTipBusy(true);
    setTipNotice("");
    setError("");

    try {
      const target = await api<TipTarget>(`/api/public/tips?table=${encodeURIComponent(data.table.slug)}`);
      if (!target.enabled || !target.url) {
        setTipNotice(target.message || "Чаевые пока недоступны.");
        return;
      }
      window.location.href = target.url;
    } catch (requestError) {
      setTipNotice(requestError instanceof Error ? requestError.message : "Не удалось открыть чаевые");
    } finally {
      setTipBusy(false);
    }
  };

  const submitLoyalty = async (event: FormEvent) => {
    event.preventDefault();
    if (!data?.table) return;

    setLoyaltyBusy(true);
    setLoyaltyError("");
    try {
      const result = await api<{ verification: LoyaltyVerification }>("/api/public/loyalty", {
        method: "POST",
        body: JSON.stringify({ ...loyalty, tableSlug: data.table.slug })
      });
      setLoyaltyVerification(result.verification);
    } catch (requestError) {
      setLoyaltyError(requestError instanceof Error ? requestError.message : "Не удалось зарегистрировать карту");
    } finally {
      setLoyaltyBusy(false);
    }
  };

  const submitFeedback = async (rating: number, e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!data?.table) return;

    try {
      const response = await api<{ feedbackId: string }>("/api/public/feedback", {
        method: "POST",
        body: JSON.stringify({
          tableSlug: data.table.slug,
          rating,
          reasons: feedbackReasons,
          liked: feedbackLiked,
          disliked: feedbackDisliked,
          guestName: feedbackName,
          phone: feedbackPhone
        })
      });
      setFeedbackId(response.feedbackId);
      setFeedbackDone(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось отправить отзыв");
    }
  };

  const handleReviewClick = async () => {
    if (feedbackId) {
      await api(`/api/public/feedback/${feedbackId}/review-click`, { method: "POST" }).catch(() => {});
    }
    if (data?.settings.reviewUrl) {
      const match = data.settings.reviewUrl.match(/https?:\/\/[^\s]+/);
      const url = match ? match[0] : data.settings.reviewUrl.trim();
      window.location.href = url.startsWith("http") ? url : `https://${url}`;
    } else {
      alert("Ссылка на отзывы еще не настроена заведением.");
    }
  };

  if (!data && !error) {
    return (
      <main className="guest-shell loading-screen">
        <BellRing size={30} />
        <span>Загружаем столик</span>
      </main>
    );
  }

  if (!data?.table) {
    return (
      <main className="guest-shell empty-state">
        <QrCode size={34} />
        <h1>QR-код не найден</h1>
        <p>Проверьте адрес на карточке стола или обратитесь к администратору.</p>
      </main>
    );
  }

  const { settings, offers, actions, table } = data;
  const heroBackground = settings.logoUrl || settings.heroImage;

  return (
    <main className="guest-shell" style={brandStyle(settings)}>
      <section
        className={`guest-hero ${settings.logoUrl ? "guest-hero--brand-bg" : ""}`}
        style={{
          backgroundImage: `linear-gradient(180deg, rgba(32, 32, 48, .42), rgba(32, 32, 48, .9)), url(${heroBackground})`
        }}
      >
        <div className="guest-hero__top">
          <span className="table-badge">{table.name}</span>
          <span className="service-pill">{table.zone}</span>
        </div>
        <div className="guest-hero__content">
          <p>{settings.tagline}</p>
          <h1>{settings.name}</h1>
          <span>{settings.description}</span>
        </div>
      </section>

      {view !== "call" && (
        <button className="back-link" onClick={() => navigateGuest("call")}>
          <ChevronLeft size={18} />
          На главную
        </button>
      )}

      {view === "call" && (
        <section className="guest-panel quick-call" id="call" aria-labelledby="call-title">
          <div className="section-heading">
            <div>
              <p>Быстрое действие</p>
              <h2 id="call-title">Что нужно?</h2>
            </div>
            <BellRing size={24} />
          </div>

          <details className="call-details">
            <summary>
              <MessageSquare size={18} />
              Комментарий к вызову
            </summary>
            <div className="guest-fields">
              <input
                value={guestName}
                onChange={(event) => setGuestName(event.target.value)}
                placeholder="Имя, если удобно"
              />
              <textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Аллергия, номер блюда, просьба к счету"
                rows={3}
              />
            </div>
          </details>

          <div className="action-grid action-grid--home">
            {sentAction && (
              <div className="call-feedback" role="status" aria-live="polite">
                <CheckCircle2 size={18} />
                <span>Вызов "{sentAction.label}" отправлен. Официант уже видит стол и причину.</span>
              </div>
            )}
            {actions.map((action) => {
              const isSent = sentAction?.id === action.id;

              return (
                <div className={`action-slot ${isSent ? "action-slot--active" : ""}`} key={action.id}>
                  <button
                    className="call-action"
                    disabled={Boolean(busyAction)}
                    onClick={() => {
                      if (action.id === "action-order" && data?.table?.menuUrl) {
                        setOrderModalAction(action);
                      } else {
                        void sendCall(action);
                      }
                    }}
                  >
                    <span className="call-action__emoji">{action.emoji}</span>
                    <span>
                      <strong>{busyAction === action.id ? "Отправляем" : action.label}</strong>
                      <small>{action.description}</small>
                    </span>
                  </button>
                </div>
              );
            })}
            
            <button className="call-action tip-action" disabled={tipBusy} onClick={() => void openTips()}>
              <span className="call-action__emoji">
                <HeartHandshake size={24} />
              </span>
              <span>
                <strong>{tipBusy ? "Открываем" : "Оставить чаевые"}</strong>
                <small>Ссылка официанта по этому столу</small>
              </span>
            </button>
            <button className="call-action feedback-action" onClick={() => navigateGuest("feedback")}>
              <span className="call-action__emoji">
                <Star size={24} />
              </span>
              <span>
                <strong>Оценить визит</strong>
                <small>Оставить отзыв о заведении</small>
              </span>
            </button>
            {tipNotice && (
              <div className="error-line tip-notice" role="status">
                {tipNotice}
              </div>
            )}
          </div>

          {error && <div className="error-line">{error}</div>}

          {orderModalAction && data?.table?.menuUrl && (
            <div className="modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={() => setOrderModalAction(null)}>
              <div className="modal-content" style={{ background: 'var(--bg-panel)', width: '100%', maxWidth: '520px', borderTopLeftRadius: '24px', borderTopRightRadius: '24px', padding: '24px', paddingBottom: 'calc(24px + env(safe-area-inset-bottom))', boxShadow: '0 -10px 40px rgba(0,0,0,0.2)', animation: 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)' }} onClick={e => e.stopPropagation()}>
                <div style={{ width: '40px', height: '4px', background: 'var(--border)', borderRadius: '2px', margin: '0 auto 24px' }} />
                <h2 style={{ margin: '0 0 24px', fontSize: '22px', textAlign: 'center', fontWeight: 'bold' }}>Сделать заказ</h2>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <a 
                    href={data.table.menuUrl} 
                    className="call-action menu-action" 
                    style={{ textDecoration: 'none', borderColor: 'var(--brand-accent)', boxShadow: '0 8px 24px rgba(200, 154, 88, 0.15)' }}
                  >
                    <span className="call-action__emoji" style={{ background: 'var(--brand-primary)' }}>
                      🚀
                    </span>
                    <span>
                      <strong style={{ fontSize: '18px', color: 'var(--brand-accent)' }}>Заказать онлайн (быстрее)</strong>
                      <small style={{ fontSize: '14px' }}>Оформить через электронное меню</small>
                    </span>
                  </a>

                  <button 
                    className="call-action" 
                    onClick={() => {
                      void sendCall(orderModalAction);
                      setOrderModalAction(null);
                    }}
                    style={{ padding: '16px' }}
                  >
                    <span className="call-action__emoji">🙋‍♂️</span>
                    <span>
                      <strong style={{ fontSize: '17px' }}>Позвать официанта</strong>
                      <small style={{ fontSize: '14px' }}>Официант подойдет принять заказ</small>
                    </span>
                  </button>
                </div>
                
                <button className="secondary-button" style={{ width: '100%', marginTop: '24px', padding: '14px', fontSize: '16px' }} onClick={() => setOrderModalAction(null)}>
                  Отмена
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {view === "offers" && (
        <section className="guest-panel page-panel" id="offers">
          <div className="section-heading">
            <div>
              <p>Сегодня</p>
              <h2>Акции и предложения</h2>
            </div>
            <Gift size={24} />
          </div>
          <div className="offer-list">
            {offers.map((offer) => (
              <article className="offer-card" key={offer.id}>
                <span>{offer.badge}</span>
                <h3>{offer.title}</h3>
                <p>{offer.description}</p>
              </article>
            ))}
          </div>
        </section>
      )}

      {view === "loyalty" && (
        <section className="guest-panel page-panel loyalty-panel" id="loyalty">
          <div className="section-heading">
            <div>
              <p>Лояльность</p>
              <h2>{settings.loyaltyTitle}</h2>
            </div>
            <CreditCard size={24} />
          </div>
          {loyaltyProfile ? (
            <div className="digital-loyalty-card">
              <div className="loyalty-card__topline">
                <div>
                  <span>Карта гостя</span>
                  <strong>{loyaltyProfile.name}</strong>
                </div>
                <ShieldCheck size={24} />
              </div>
              <div className="loyalty-balance">
                <span>Бонусный баланс</span>
                <strong>{Math.round(loyaltyProfile.bonusBalance)} ₽</strong>
              </div>
              {loyaltyProfile.cardNumber ? (
                <div className="loyalty-qr">
                  <QRCodeSVG
                    value={loyaltyProfile.cardNumber}
                    size={196}
                    level="M"
                    bgColor="#ffffff"
                    fgColor="#17131b"
                  />
                  <span>Покажите QR-код кассиру</span>
                  <code>{loyaltyProfile.cardNumber}</code>
                </div>
              ) : (
                <div className="error-line">Карта выпускается. Обновите баланс через несколько секунд.</div>
              )}
              <div className={`bonus-status status-${loyaltyProfile.welcomeBonus.status.toLowerCase()}`}>
                {loyaltyProfile.welcomeBonus.status === "GRANTED" && (
                  <><CheckCircle2 size={17} /> Приветственные {Math.round(loyaltyProfile.welcomeBonus.amount)} ₽ начислены</>
                )}
                {loyaltyProfile.welcomeBonus.status === "SKIPPED_EXISTING_MEMBER" && (
                  <>Карта подключена к существующему участнику программы</>
                )}
                {!["GRANTED", "SKIPPED_EXISTING_MEMBER"].includes(loyaltyProfile.welcomeBonus.status) && (
                  <>Начисление бонусов обрабатывается</>
                )}
              </div>
              <button className="ghost-button loyalty-refresh" disabled={loyaltyBusy} onClick={() => void loadLoyaltyProfile()}>
                <RefreshCw size={17} className={loyaltyBusy ? "spin" : ""} />
                {loyaltyBusy ? "Обновляем" : "Обновить баланс"}
              </button>
              {loyaltyStale && <p className="loyalty-stale">Показан последний сохраненный баланс.</p>}
            </div>
          ) : (
            <>
              <p>{settings.loyaltyText}</p>
              <div className="welcome-bonus-note">
                <Gift size={20} />
                <span><strong>500 ₽</strong> после первой регистрации в программе</span>
              </div>
              {loyaltyVerification ? (
                <div className="phone-verification">
                  <div className="phone-verification__heading">
                    <ShieldCheck size={22} />
                    <div>
                      <strong>Подтвердите свой номер</strong>
                      <span>Выберите удобный бесплатный способ. Карта появится здесь автоматически.</span>
                    </div>
                  </div>
                  <div className="verification-channel-grid">
                    {loyaltyVerification.channels.telegram && (
                      <a className="verification-channel-button" href={loyaltyVerification.channels.telegram.url}>
                        <MessageSquare size={19} />
                        Telegram
                      </a>
                    )}
                    {loyaltyVerification.channels.max && (
                      <a className="verification-channel-button" href={loyaltyVerification.channels.max.url}>
                        <MessageSquare size={19} />
                        MAX
                      </a>
                    )}
                  </div>
                  <div className="verification-waiting">
                    <RefreshCw size={16} className="spin" />
                    Ожидаем подтверждение до {new Date(loyaltyVerification.expiresAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                  </div>
                  <button type="button" className="ghost-button" onClick={() => setLoyaltyVerification(null)}>
                    <ChevronLeft size={17} />
                    Изменить номер
                  </button>
                </div>
              ) : (
              <form className="loyalty-form" onSubmit={submitLoyalty}>
                <input
                  required
                  autoComplete="name"
                  value={loyalty.name}
                  onChange={(event) => setLoyalty({ ...loyalty, name: event.target.value })}
                  placeholder="Имя"
                />
                <input
                  required
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={loyalty.phone}
                  onChange={(event) => setLoyalty({ ...loyalty, phone: event.target.value })}
                  placeholder="Телефон: +7 999 000-00-00"
                />
                <label className="date-field">
                  <span>День рождения, необязательно</span>
                  <input
                    type="date"
                    value={loyalty.birthday}
                    onChange={(event) => setLoyalty({ ...loyalty, birthday: event.target.value })}
                  />
                </label>
                <label className="check-row consent-row">
                  <input
                    required
                    type="checkbox"
                    checked={loyalty.personalDataConsent}
                    onChange={(event) => setLoyalty({ ...loyalty, personalDataConsent: event.target.checked })}
                  />
                  <span>
                    Я даю <a href={data.legal.personalDataConsentUrl} target="_blank" rel="noreferrer">согласие на обработку персональных данных</a>
                    {" "}и ознакомлен с <a href={data.legal.privacyPolicyUrl} target="_blank" rel="noreferrer">политикой конфиденциальности</a>
                  </span>
                </label>
                <label className="check-row consent-row consent-row--optional">
                  <input
                    type="checkbox"
                    checked={loyalty.marketingConsent}
                    onChange={(event) => setLoyalty({ ...loyalty, marketingConsent: event.target.checked })}
                  />
                  <span>
                    Хочу получать сообщения об акциях. <a href={data.legal.marketingConsentUrl} target="_blank" rel="noreferrer">Условия</a>
                  </span>
                </label>
                <button type="submit" className="primary-button" disabled={loyaltyBusy || !loyalty.personalDataConsent}>
                  {loyaltyBusy ? "Создаем карту" : "Получить карту и 500 ₽"}
                </button>
              </form>
              )}
            </>
          )}
          {loyaltyError && <div className="error-line">{loyaltyError}</div>}
        </section>
      )}

      {view === "info" && (
        <section className="guest-panel page-panel info-panel" id="info">
          <div className="section-heading">
            <div>
              <p>Заведение</p>
              <h2>Информация</h2>
            </div>
            <ReceiptText size={24} />
          </div>
          <div className="guest-info">
            <InfoItem icon={<MapPin size={18} />} label={settings.address} />
            <InfoItem icon={<Phone size={18} />} label={settings.phone} />
            <InfoItem icon={<Clock size={18} />} label={settings.hours} />
            <InfoItem icon={<Wifi size={18} />} label={settings.wifi} />
          </div>
        </section>
      )}

      {view === "feedback" && (
        <section className="guest-panel page-panel feedback-panel" id="feedback">
          <div className="section-heading">
            <div>
              <p>Оцените</p>
              <h2>Как всё прошло?</h2>
            </div>
            <Star size={24} />
          </div>
          {!feedbackRating ? (
            <div className="rating-stars" style={{ display: 'flex', gap: '8px', justifyContent: 'center', margin: '32px 0' }} onMouseLeave={() => setHoverRating(0)}>
              {[1, 2, 3, 4, 5].map((star) => {
                const isFilled = (hoverRating || feedbackRating) >= star;
                return (
                  <button
                    key={star}
                    onClick={() => {
                      setFeedbackRating(star);
                      if (star >= 4) void submitFeedback(star);
                    }}
                    onMouseEnter={() => setHoverRating(star)}
                    className={hoverRating >= star ? "shimmer-star" : ""}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--brand-accent)', transition: 'all 0.2s', outline: 'none' }}
                    aria-label={`Оценить на ${star} звезд`}
                  >
                    <Star size={48} fill={isFilled ? "currentColor" : "none"} strokeWidth={1.5} />
                  </button>
                );
              })}
            </div>
          ) : feedbackRating >= 4 ? (
            <div className="feedback-success" style={{ textAlign: 'center', padding: '32px 0' }}>
              <CheckCircle2 size={48} style={{ color: 'var(--brand-accent)', margin: '0 auto 16px' }} />
              <h3>Спасибо за высокую оценку!</h3>
              <p style={{ marginBottom: '24px' }}>Пожалуйста, оставьте отзыв на 2ГИС, это очень поможет нам стать еще лучше.</p>
              <button className="primary-button" onClick={handleReviewClick}>
                Оставить отзыв на 2ГИС
              </button>
            </div>
          ) : feedbackDone ? (
            <div className="feedback-success" style={{ textAlign: 'center', padding: '32px 0' }}>
              <CheckCircle2 size={48} style={{ color: 'var(--brand-accent)', margin: '0 auto 16px' }} />
              <h3>Спасибо за ваш отзыв!</h3>
              <p>Мы внимательно его изучим и постараемся всё исправить.</p>
            </div>
          ) : (
            <form className="feedback-form loyalty-form" onSubmit={(e) => void submitFeedback(feedbackRating, e)}>
              <p style={{ marginBottom: '16px', fontWeight: 'bold' }}>Что именно вам не понравилось?</p>
              <div className="feedback-reasons" style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
                {["Еда", "Сервис", "Чистота", "Время ожидания", "Атмосфера"].map((reason) => (
                  <label key={reason} className="check-row">
                    <input
                      type="checkbox"
                      checked={feedbackReasons.includes(reason)}
                      onChange={(e) => {
                        if (e.target.checked) setFeedbackReasons([...feedbackReasons, reason]);
                        else setFeedbackReasons(feedbackReasons.filter((r) => r !== reason));
                      }}
                    />
                    {reason}
                  </label>
                ))}
              </div>
              <textarea
                value={feedbackLiked}
                onChange={(e) => setFeedbackLiked(e.target.value)}
                placeholder="Что понравилось? (необязательно)"
                rows={2}
                style={{ width: '100%', marginBottom: '16px' }}
              />
              <textarea
                value={feedbackDisliked}
                onChange={(e) => setFeedbackDisliked(e.target.value)}
                placeholder="Что не понравилось? (подробнее)"
                rows={3}
                style={{ width: '100%', marginBottom: '16px' }}
              />
              <input
                value={feedbackName}
                onChange={(e) => setFeedbackName(e.target.value)}
                placeholder="Имя"
                style={{ width: '100%', marginBottom: '16px' }}
              />
              <input
                value={feedbackPhone}
                onChange={(e) => setFeedbackPhone(e.target.value)}
                placeholder="Телефон"
                style={{ width: '100%', marginBottom: '24px' }}
              />
              <button type="submit" className="primary-button">
                Отправить отзыв
              </button>
            </form>
          )}
          {error && <div className="error-line">{error}</div>}
        </section>
      )}

      <nav className="guest-dock" aria-label="Навигация гостя">
        <button className={view === "call" ? "active" : ""} onClick={() => navigateGuest("call")}>
          <BellRing size={18} />
          Вызов
        </button>
        <button className={view === "offers" ? "active" : ""} onClick={() => navigateGuest("offers")}>
          <Gift size={18} />
          Акции
        </button>
        <button className={view === "loyalty" ? "active" : ""} onClick={() => navigateGuest("loyalty")}>
          <CreditCard size={18} />
          Карта
        </button>
        <button className={view === "info" ? "active" : ""} onClick={() => navigateGuest("info")}>
          <MapPin size={18} />
          Инфо
        </button>
      </nav>

      {showPopups && data?.popups && data.popups.length > 0 && (
        <GuestPopupGallery
          popups={data.popups}
          onClose={closePopups}
          onAction={handlePopupAction}
        />
      )}
    </main>
  );
}

function InfoItem({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="info-item">
      {icon}
      <span>{label}</span>
    </div>
  );
}

function LogoMark({ settings, className = "" }: { settings: VenueSettings; className?: string }) {
  const initials =
    settings.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "QR";

  return (
    <div className={`logo-mark ${className}`} aria-label={`Логотип ${settings.name}`}>
      {settings.logoUrl ? <img src={settings.logoUrl} alt="" /> : <span>{initials}</span>}
    </div>
  );
}

function AdminPage() {
  const [token, setToken] = useState(() => localStorage.getItem("adminToken") || "");
  const [username, setUsername] = useState(() => localStorage.getItem("adminUsername") || "admin");
  const [password, setPassword] = useState("");
  const [data, setData] = useState<AdminData | null>(null);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const authHeaders = useMemo(() => ({ authorization: `Bearer ${token}` }), [token]);

  const loadAdmin = useCallback(async () => {
    if (!token) return;
    try {
      const overview = await api<AdminData>("/api/admin/overview", {
        headers: authHeaders
      });
      setData(overview);
      setError("");
    } catch (requestError) {
      localStorage.removeItem("adminToken");
      setToken("");
      setError(requestError instanceof Error ? requestError.message : "Сессия истекла");
    }
  }, [authHeaders, token]);

  useEffect(() => {
    void loadAdmin();
  }, [loadAdmin]);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ token: string; username: string }>("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      localStorage.setItem("adminToken", result.token);
      localStorage.setItem("adminUsername", result.username);
      setToken(result.token);
      setPassword("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось войти");
    }
  };

  const saveResource = async <T,>(resource: string, body: T, message: string) => {
    setSaved("");
    setError("");
    try {
      await api(`/api/admin/${resource}`, {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify(body)
      });
      setSaved(message);
      setTimeout(() => setSaved(""), 3000);
      await loadAdmin();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось сохранить");
    }
  };

  const uploadLogo = async (file: File) => {
    setSaved("");
    setError("");
    try {
      const response = await fetch("/api/admin/logo", {
        method: "POST",
        headers: {
          authorization: authHeaders.authorization,
          "content-type": file.type
        },
        body: file
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "Не удалось загрузить логотип");
      const settings = json as VenueSettings;
      setData((current) => (current ? { ...current, settings } : current));
      setSaved("Логотип сохранен");
      setTimeout(() => setSaved(""), 3000);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось загрузить логотип");
      throw requestError;
    }
  };

  const updateCall = async (callId: string, status: CallStatus) => {
    await api(`/api/admin/calls/${callId}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ status })
    });
    await loadAdmin();
  };

  if (!token) {
    return (
      <main className="admin-login">
        <form onSubmit={login}>
          <QrCode size={36} />
          <h1>QR на стол</h1>
          <p>Панель администратора</p>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Логин"
            autoComplete="username"
          />
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Пароль"
            autoComplete="current-password"
          />
          <button className="primary-button" type="submit">
            Войти
          </button>
          {error && <div className="error-line">{error}</div>}
        </form>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="admin-shell loading-screen">
        <Settings size={28} />
        <span>Загружаем админку</span>
      </main>
    );
  }

  const tabs = [
    { id: "dashboard", label: "Обзор", icon: <LayoutDashboard size={18} /> },
    { id: "settings", label: "Заведение", icon: <Settings size={18} /> },
    { id: "tables", label: "Столы и QR", icon: <Table2 size={18} /> },
    { id: "table-tents", label: "Тейбл-тенты", icon: <Printer size={18} /> },
    { id: "staff", label: "Сотрудники", icon: <Users size={18} /> },
    { id: "management", label: "Telegram", icon: <ShieldCheck size={18} /> },
    { id: "shifts", label: "Смены и рейтинг", icon: <Trophy size={18} /> },
    { id: "checklist", label: "Чек-листы", icon: <ClipboardCheck size={18} /> },
    ...(data.accessRole === "owner"
      ? [
          { id: "owner-profile", label: "Профиль владельца", icon: <KeyRound size={18} /> },
          { id: "owner-efficiency", label: "Эффективность админов", icon: <Briefcase size={18} /> }
        ]
      : []),
    { id: "actions", label: "Кнопки", icon: <BellRing size={18} /> },
    { id: "offers", label: "Акции", icon: <Tags size={18} /> },
    { id: "loyalty", label: "Лояльность", icon: <UserRound size={18} /> },
    { id: "popups", label: "Уведомления", icon: <Megaphone size={18} /> },
    { id: "feedbacks", label: "Отзывы", icon: <Star size={18} /> }
  ];

  const publicUrl = (table: DiningTable) => `${data.publicBaseUrl || window.location.origin}/t/${table.slug}`;

  return (
    <main className="admin-shell" style={brandStyle(data.settings)}>
      <aside className="admin-sidebar">
        <div className="brand-lockup">
          <LogoMark settings={data.settings} className="logo-mark--sidebar" />
          <div>
            <strong>{data.settings.name}</strong>
            <span>{data.telegramEnabled ? `Telegram подключен · ${data.username}` : `Telegram не настроен · ${data.username}`}</span>
          </div>
        </div>

        <nav>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={activeTab === tab.id ? "active" : ""}
              onClick={() => { setActiveTab(tab.id); setSaved(""); }}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>

        <button
          className="logout-button"
          onClick={() => {
            localStorage.removeItem("adminToken");
            localStorage.removeItem("adminUsername");
            setToken("");
          }}
        >
          <LogOut size={18} />
          Выйти
        </button>
      </aside>

      <section className="admin-content">
        <header className="admin-header">
          <div>
            <p>Панель управления</p>
            <h1>{tabs.find((tab) => tab.id === activeTab)?.label}</h1>
          </div>
          <button className="ghost-button" onClick={() => void loadAdmin()}>
            Обновить
          </button>
        </header>

        {saved && <div className="success-line admin-alert">{saved}</div>}
        {error && <div className="error-line admin-alert">{error}</div>}

        {activeTab === "dashboard" && (
          <Dashboard data={data} updateCall={(id, status) => void updateCall(id, status)} />
        )}

        {activeTab === "settings" && (
          <SettingsEditor
            settings={data.settings}
            onChange={(settings) => setData({ ...data, settings })}
            onUploadLogo={uploadLogo}
            onSave={() => void saveResource("settings", data.settings, "Настройки заведения сохранены")}
          />
        )}

        {activeTab === "tables" && (
          <TablesEditor
            data={data}
            publicUrl={publicUrl}
            onChange={(tables) => setData({ ...data, tables })}
            onSave={() => void saveResource("tables", data.tables, "Столы сохранены")}
          />
        )}

        {activeTab === "table-tents" && (
          <TableTentDesigner
            tables={data.tables}
            settings={data.settings}
            publicUrl={publicUrl}
          />
        )}

        {activeTab === "staff" && (
          <StaffEditor
            waiters={data.waiters}
            roles={data.staffRoles}
            accessRole={data.accessRole}
            onWaitersChange={(waiters) => setData({ ...data, waiters })}
            onRolesChange={(staffRoles) => setData({ ...data, staffRoles })}
            onSaveWaiters={() => void saveResource("waiters", data.waiters, "Сотрудники сохранены")}
            onSaveRoles={() => void saveResource("staff-roles", data.staffRoles, "Должности сохранены")}
          />
        )}

        {activeTab === "management" && (
          <ManagementTelegramEditor
            waiters={data.waiters}
            roles={data.staffRoles}
            telegramBotUrl={data.telegramBotUrl}
            onChange={(waiters) => setData({ ...data, waiters })}
            onSave={() => void saveResource("waiters", data.waiters, "Telegram-аккаунты руководителей сохранены")}
          />
        )}

        {activeTab === "shifts" && (
          <ShiftsAndRatings
            ratings={data.ratings.filter((rating) => rating.roleKind !== "admin" && rating.roleKind !== "owner")}
            shifts={data.shifts.filter((shift) => shift.roleKind !== "admin" && shift.roleKind !== "owner")}
            performance={filterPerformanceAnalytics(data.performance, data.staffRoles.filter((role) => role.kind !== "admin" && role.kind !== "owner").map((role) => role.id))}
            performanceAiEnabled={data.performanceAiEnabled}
            authHeaders={authHeaders}
            onRefresh={loadAdmin}
            title="Смены сотрудников"
          />
        )}

        {activeTab === "checklist" && (
          <ChecklistEditor
            items={data.checklistItems}
            shiftTasks={data.shiftTasks}
            roles={data.staffRoles}
            waiters={data.waiters}
            authHeaders={authHeaders}
            onChange={(checklistItems) => setData({ ...data, checklistItems })}
            onSave={() => void saveResource("checklist", data.checklistItems, "Шаблоны чек-листов сохранены")}
            onRefresh={loadAdmin}
          />
        )}

        {activeTab === "owner-profile" && data.accessRole === "owner" && data.adminAccount && (
          <OwnerProfile
            ownerUsername={data.username}
            adminAccount={data.adminAccount}
            authHeaders={authHeaders}
            onRefresh={loadAdmin}
          />
        )}

        {activeTab === "owner-efficiency" && data.accessRole === "owner" && (
          <ShiftsAndRatings
            ratings={data.ratings.filter((rating) => rating.roleKind === "admin")}
            shifts={data.shifts.filter((shift) => shift.roleKind === "admin")}
            performance={filterPerformanceAnalytics(data.performance, data.staffRoles.filter((role) => role.kind === "admin").map((role) => role.id))}
            performanceAiEnabled={data.performanceAiEnabled}
            authHeaders={authHeaders}
            onRefresh={loadAdmin}
            title="Эффективность администраторов"
          />
        )}

        {activeTab === "actions" && (
          <ActionsEditor
            actions={data.actions}
            onChange={(actions) => setData({ ...data, actions })}
            onSave={() => void saveResource("actions", data.actions, "Кнопки вызова сохранены")}
          />
        )}

        {activeTab === "offers" && (
          <OffersEditor
            offers={data.offers}
            onChange={(offers) => setData({ ...data, offers })}
            onSave={() => void saveResource("offers", data.offers, "Акции сохранены")}
          />
        )}

        {activeTab === "loyalty" && <LoyaltyList leads={data.loyaltyLeads} tables={data.tables} />}

        {activeTab === "popups" && (
          <PopupsEditor
            popups={data.popups || []}
            authHeaders={authHeaders}
            onChange={() => void loadAdmin()}
          />
        )}

        {activeTab === "feedbacks" && <FeedbacksList feedbacks={data.feedbacks} tables={data.tables} waiters={data.waiters} />}
      </section>
    </main>
  );
}

function OwnerProfile({
  ownerUsername,
  adminAccount,
  authHeaders,
  onRefresh
}: {
  ownerUsername: string;
  adminAccount: AdminAccountSummary;
  authHeaders: { authorization: string };
  onRefresh: () => Promise<void>;
}) {
  const [adminUsername, setAdminUsername] = useState(adminAccount.username);
  const [adminPassword, setAdminPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [formError, setFormError] = useState("");

  useEffect(() => {
    setAdminUsername(adminAccount.username);
  }, [adminAccount.username]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setMessage("");
    setFormError("");
    const normalizedUsername = adminUsername.trim();
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(normalizedUsername)) {
      setFormError("Проверьте логин администратора");
      return;
    }
    if (adminPassword.length < 8) {
      setFormError("Пароль должен содержать не менее 8 символов");
      return;
    }
    if (adminPassword !== passwordConfirmation) {
      setFormError("Пароли не совпадают");
      return;
    }

    setBusy(true);
    try {
      const updated = await api<AdminAccountSummary>("/api/admin/admin-account", {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({ username: normalizedUsername, password: adminPassword })
      });
      setAdminUsername(updated.username);
      setAdminPassword("");
      setPasswordConfirmation("");
      setMessage("Доступ администратора обновлён");
      await onRefresh();
    } catch (requestError) {
      setFormError(requestError instanceof Error ? requestError.message : "Не удалось обновить доступ администратора");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-panel owner-profile-panel">
      <div className="panel-heading">
        <h2>Профиль владельца</h2>
        <KeyRound size={20} />
      </div>

      <div className="owner-profile-grid">
        <div className="owner-access-meta">
          <dl>
            <div>
              <dt>Логин владельца</dt>
              <dd>{ownerUsername}</dd>
            </div>
            <div>
              <dt>Логин администратора</dt>
              <dd>{adminAccount.username}</dd>
            </div>
            <div>
              <dt>Доступ обновлён</dt>
              <dd>{formatDate(adminAccount.updatedAt)}</dd>
            </div>
          </dl>
        </div>

        <form className="owner-account-form" onSubmit={submit}>
          <h3>Доступ администратора</h3>
          <label className="field">
            <span>Новый логин</span>
            <input
              value={adminUsername}
              onChange={(event) => {
                setAdminUsername(event.target.value);
                setMessage("");
                setFormError("");
              }}
              autoComplete="username"
              minLength={3}
              maxLength={64}
              pattern="[A-Za-z0-9._-]+"
              required
            />
          </label>

          <label className="field">
            <span>Новый пароль</span>
            <div className="password-control">
              <input
                type={showPassword ? "text" : "password"}
                value={adminPassword}
                onChange={(event) => {
                  setAdminPassword(event.target.value);
                  setMessage("");
                  setFormError("");
                }}
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                required
              />
              <button
                className="icon-button"
                type="button"
                onClick={() => setShowPassword((current) => !current)}
                aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                title={showPassword ? "Скрыть пароль" : "Показать пароль"}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </label>

          <label className="field">
            <span>Повторите пароль</span>
            <input
              type={showPassword ? "text" : "password"}
              value={passwordConfirmation}
              onChange={(event) => {
                setPasswordConfirmation(event.target.value);
                setMessage("");
                setFormError("");
              }}
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
            />
          </label>

          {message && <div className="success-line owner-account-status">{message}</div>}
          {formError && <div className="error-line owner-account-status">{formError}</div>}

          <div className="button-row owner-account-actions">
            <button className="primary-button" type="submit" disabled={busy}>
              <Save size={18} />
              {busy ? "Сохраняем" : "Сохранить доступ"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

function Dashboard({
  data,
  updateCall
}: {
  data: AdminData;
  updateCall: (callId: string, status: CallStatus) => void;
}) {
  const newCalls = data.calls.filter((call) => call.status === "new").length;
  const tableName = (id: string) => data.tables.find((table) => table.id === id)?.name || "Стол";

  return (
    <div className="admin-grid">
      <Metric title="Новые вызовы" value={newCalls} icon={<BellRing size={22} />} />
      <Metric title="Столы" value={data.tables.length} icon={<Table2 size={22} />} />
      <Metric title="Официанты" value={data.waiters.filter((waiter) => waiter.active).length} icon={<Users size={22} />} />
      <Metric title="Анкеты" value={data.loyaltyLeads.length} icon={<Gift size={22} />} />

      <section className="admin-panel span-2">
        <div className="panel-heading">
          <h2>Последние вызовы</h2>
          <MessageSquare size={20} />
        </div>
        <div className="call-list">
          {data.calls.slice(0, 12).map((call) => (
            <article className={`call-row status-${call.status}`} key={call.id}>
              <div>
                <strong>{tableName(call.tableId)} - {call.actionLabel}</strong>
                <span>{formatDate(call.createdAt)}{call.comment ? ` - ${call.comment}` : ""}</span>
              </div>
              <StatusButtons call={call} updateCall={updateCall} />
            </article>
          ))}
          {!data.calls.length && <p className="muted">Пока нет вызовов.</p>}
        </div>
      </section>
    </div>
  );
}

function Metric({ title, value, icon }: { title: string; value: number | string; icon: ReactNode }) {
  return (
    <article className="metric">
      <span>{icon}</span>
      <div>
        <strong>{value}</strong>
        <p>{title}</p>
      </div>
    </article>
  );
}

function StatusButtons({
  call,
  updateCall
}: {
  call: ServiceCall;
  updateCall: (callId: string, status: CallStatus) => void;
}) {
  return (
    <div className="status-actions">
      <span className={`status-pill status-${call.status}`}>{statusLabel[call.status]}</span>
      {call.status === "new" && (
        <button onClick={() => updateCall(call.id, "accepted")}>
          <Check size={16} />
          Принять
        </button>
      )}
      {call.status !== "done" && (
        <button onClick={() => updateCall(call.id, "done")}>
          <CheckCircle2 size={16} />
          Готово
        </button>
      )}
    </div>
  );
}

function SettingsEditor({
  settings,
  onChange,
  onUploadLogo,
  onSave
}: {
  settings: VenueSettings;
  onChange: (settings: VenueSettings) => void;
  onUploadLogo: (file: File) => Promise<void>;
  onSave: () => void;
}) {
  const [logoBusy, setLogoBusy] = useState(false);
  const update = (key: keyof VenueSettings, value: string) => onChange({ ...settings, [key]: value });
  const uploadLogo = async (file: File | undefined) => {
    if (!file) return;
    setLogoBusy(true);
    try {
      await onUploadLogo(file);
    } catch {
      // Parent state shows the upload error.
    } finally {
      setLogoBusy(false);
    }
  };

  return (
    <section className="admin-panel form-panel">
      <div className="panel-heading">
        <h2>Данные заведения</h2>
        <button className="primary-button compact" onClick={onSave}>
          <Save size={18} />
          Сохранить
        </button>
      </div>
      <div className="logo-editor">
        <LogoMark settings={settings} className="logo-mark--settings" />
        <div>
          <strong className="logo-editor__title">
            <ImageIcon size={18} />
            Логотип заведения
          </strong>
          <p className="muted">PNG, JPG или WEBP до 5 МБ. После загрузки логотип сразу появится на гостевой странице.</p>
          <label className="upload-button">
            <Upload size={18} />
            {logoBusy ? "Загружаем" : "Загрузить логотип"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={logoBusy}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                void uploadLogo(file);
              }}
            />
          </label>
        </div>
      </div>
      <div className="form-grid">
        <Field label="Название" value={settings.name} onChange={(value) => update("name", value)} />
        <Field label="Короткий слоган" value={settings.tagline} onChange={(value) => update("tagline", value)} />
        <Field label="Ссылка на 2ГИС/Яндекс.Карты" value={settings.reviewUrl} onChange={(value) => update("reviewUrl", value)} full />
        <Field label="Адрес" value={settings.address} onChange={(value) => update("address", value)} />
        <Field label="Телефон" value={settings.phone} onChange={(value) => update("phone", value)} />
        <Field label="Часы работы" value={settings.hours} onChange={(value) => update("hours", value)} />
        <Field label="Wi-Fi" value={settings.wifi} onChange={(value) => update("wifi", value)} />
        <Field label="URL логотипа" value={settings.logoUrl} onChange={(value) => update("logoUrl", value)} full />
        <Field label="Фото для главного блока" value={settings.heroImage} onChange={(value) => update("heroImage", value)} full />
        <Field label="Описание" value={settings.description} onChange={(value) => update("description", value)} textarea full />
        <Field label="Заголовок лояльности" value={settings.loyaltyTitle} onChange={(value) => update("loyaltyTitle", value)} />
        <Field label="Текст лояльности" value={settings.loyaltyText} onChange={(value) => update("loyaltyText", value)} />
        <ColorField label="Основной цвет" value={settings.primaryColor} onChange={(value) => update("primaryColor", value)} />
        <ColorField label="Акцентный цвет" value={settings.accentColor} onChange={(value) => update("accentColor", value)} />
        <ColorField label="Вторичный цвет" value={settings.secondaryColor} onChange={(value) => update("secondaryColor", value)} />
        <ColorField label="Темный фон" value={settings.backgroundColor} onChange={(value) => update("backgroundColor", value)} />
      </div>
    </section>
  );
}

function TablesEditor({
  data,
  publicUrl,
  onChange,
  onSave
}: {
  data: AdminData;
  publicUrl: (table: DiningTable) => string;
  onChange: (tables: DiningTable[]) => void;
  onSave: () => void;
}) {
  const [bulkZone, setBulkZone] = useState("");
  const [bulkWaiters, setBulkWaiters] = useState<string[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const uniqueZones = Array.from(new Set(data.tables.map(t => t.zone).filter(Boolean)));

  const handleBulkAssign = () => {
    if (!bulkZone) return;
    const confirmed = window.confirm(`Назначить выбранных официантов на ВСЕ столы в зоне "${bulkZone}"?`);
    if (!confirmed) return;
    
    onChange(data.tables.map(table => 
      table.zone === bulkZone ? { ...table, waiterIds: bulkWaiters, waiterId: bulkWaiters[0] || null } : table
    ));
    setBulkWaiters([]);
    setBulkZone("");
  };

  const update = (index: number, patch: Partial<DiningTable>) => {
    const tables = data.tables.map((table, tableIndex) => (tableIndex === index ? { ...table, ...patch } : table));
    onChange(tables);
  };

  const addTable = () => {
    const number = data.tables.length + 1;
    onChange([
      ...data.tables,
      {
        id: "",
        name: `Стол ${number}`,
        slug: `table-${number}`,
        zone: "Основной зал",
        waiterId: null,
        waiterIds: [],
        menuUrl: ""
      }
    ]);
  };

  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <h2>Столы, зоны и QR</h2>
        <div className="button-row">
          <button className="ghost-button" onClick={addTable}>
            <Plus size={18} />
            Стол
          </button>

          <button className="primary-button compact" onClick={onSave}>
            <Save size={18} />
            Сохранить
          </button>
        </div>
      </div>

      <div style={{ background: 'rgba(0, 0, 0, 0.03)', padding: '24px', borderRadius: '16px', marginBottom: '24px' }}>
        <h3 style={{ margin: '0 0 16px 0', fontSize: '16px' }}>Быстрое назначение официантов на зону (смену)</h3>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 200px' }}>
            <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: 600 }}>1. Выберите этаж/зону</label>
            <select className="form-input" value={bulkZone} onChange={(e) => setBulkZone(e.target.value)}>
              <option value="">-- Выберите зону --</option>
              {uniqueZones.map(z => <option key={z} value={z}>{z}</option>)}
            </select>
          </div>
          <div style={{ flex: '2 1 300px', position: 'relative' }}>
            <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px', fontWeight: 600 }}>2. Кто сейчас обслуживает этот этаж?</label>
            <WaiterPicker 
              waiters={data.waiters.filter(w => w.active)} 
              value={bulkWaiters} 
              onChange={setBulkWaiters} 
            />
          </div>
          <button className="primary-button" disabled={!bulkZone} onClick={handleBulkAssign} style={{ height: '42px' }}>
            Применить ко всем столам
          </button>
        </div>
      </div>

      <div className="editor-list">
        {data.tables.map((table, index) => (
          <article className="editor-row table-editor-row" key={`${table.id}-${index}`}>
            <QRCodeSVG value={publicUrl(table)} size={82} />
            <Field label="Название" value={table.name} onChange={(value) => update(index, { name: value })} />
            <Field
              label="QR-slug"
              value={table.slug}
              onChange={(value) => update(index, { slug: slugify(value) })}
            />
            <Field label="Зона" value={table.zone} onChange={(value) => update(index, { zone: value })} />
            <Field label="Ссылка на эл. меню" value={table.menuUrl || ''} onChange={(value) => update(index, { menuUrl: value })} placeholder="https://..." />
            <WaiterPicker
              waiters={data.waiters}
              value={table.waiterIds || (table.waiterId ? [table.waiterId] : [])}
              onChange={(waiterIds) => update(index, { waiterIds, waiterId: waiterIds[0] || null })}
            />
            <button className="icon-button" onClick={() => onChange(data.tables.filter((_, tableIndex) => tableIndex !== index))}>
              <Trash2 size={18} />
            </button>
          </article>
        ))}
      </div>


    </section>
  );
}

function WaiterPicker({
  waiters,
  value,
  onChange
}: {
  waiters: Waiter[];
  value: string[];
  onChange: (waiterIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (waiterId: string, checked: boolean) => {
    onChange(checked ? Array.from(new Set([...value, waiterId])) : value.filter((id) => id !== waiterId));
  };

  return (
    <div className="field waiter-picker" style={{ position: 'relative' }}>
      <button 
        className="form-input" 
        style={{ width: '100%', textAlign: 'left', background: 'white', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '10px' }} 
        onClick={() => setOpen(!open)}
      >
        <span>{value.length > 0 ? `Официантов: ${value.length}` : 'Все активные'}</span>
        <span style={{ fontSize: '12px' }}>▼</span>
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 99, background: 'transparent', border: 'none' }} onClick={() => setOpen(false)} />
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'white', padding: '16px', borderRadius: '12px', boxShadow: '0 10px 40px rgba(0,0,0,0.2)', zIndex: 100, marginTop: '8px', border: '1px solid #eee', display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto', minWidth: '250px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontWeight: 'bold' }}>
              <input type="checkbox" checked={!value.length} onChange={() => onChange([])} />
              Все активные
            </label>
            <hr style={{ margin: '4px 0', border: 'none', borderTop: '1px solid #eee' }} />
            {waiters.map((waiter) => (
              <label key={waiter.id || waiter.name} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={value.includes(waiter.id)}
                  disabled={!waiter.id}
                  onChange={(event) => toggle(waiter.id, event.target.checked)}
                />
                {waiter.name}
              </label>
            ))}
            <small className="waiter-picker__hint" style={{ marginTop: '8px', display: 'block' }}>
              Один выбранный официант получает чаевые сразу. Если выбрано несколько, ссылка откроется после первого нажатия "Принял".
            </small>
            <button className="primary-button compact" style={{ marginTop: '12px' }} onClick={() => setOpen(false)}>
              Готово
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function WaitersEditor({
  waiters,
  onChange,
  onSave
}: {
  waiters: Waiter[];
  onChange: (waiters: Waiter[]) => void;
  onSave: () => void;
}) {
  const update = (index: number, patch: Partial<Waiter>) => {
    onChange(waiters.map((waiter, waiterIndex) => (waiterIndex === index ? { ...waiter, ...patch } : waiter)));
  };

  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <h2>Официанты и Telegram</h2>
        <div className="button-row">
          <button className="ghost-button" onClick={() => onChange([...waiters, { id: "", name: "Официант", roleId: "waiter", telegramChatId: "", tipUrl: "", active: true }])}>
            <Plus size={18} />
            Официант
          </button>
          <button className="primary-button compact" onClick={onSave}>
            <Save size={18} />
            Сохранить
          </button>
        </div>
      </div>

      <div style={{ background: 'rgba(0, 0, 0, 0.03)', padding: '24px', borderRadius: '16px', marginBottom: '24px', display: 'flex', gap: '24px', alignItems: 'center' }}>
        <div style={{ background: 'white', padding: '12px', borderRadius: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
          <QRCodeSVG value="https://t.me/QROFFICBOT" size={120} />
        </div>
        <div>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '18px' }}>Подключение официантов к Telegram</h3>
          <p style={{ margin: 0, color: '#666', lineHeight: 1.5 }}>
            Пусть официант отсканирует этот QR-код со своего телефона (или найдет бота <strong>@QROFFICBOT</strong>), нажмет "Старт" и перешлет вам свой уникальный <strong>Chat ID</strong>, который выдаст бот. Впишите этот ID в карточку официанта ниже, чтобы он начал получать уведомления о вызовах.
          </p>
        </div>
      </div>

      <div className="editor-list">
        {waiters.map((waiter, index) => (
          <article className="editor-row" key={`${waiter.id}-${index}`}>
            <Field label="Имя" value={waiter.name} onChange={(value) => update(index, { name: value })} />
            <Field label="Telegram chat_id" value={waiter.telegramChatId} onChange={(value) => update(index, { telegramChatId: value })} />
            <Field label="Ссылка для чаевых" value={waiter.tipUrl} onChange={(value) => update(index, { tipUrl: value })} />
            <label className="toggle-row">
              <input type="checkbox" checked={waiter.active} onChange={(event) => update(index, { active: event.target.checked })} />
              Активен
            </label>
            <button className="icon-button" onClick={() => onChange(waiters.filter((_, waiterIndex) => waiterIndex !== index))}>
              <Trash2 size={18} />
            </button>
          </article>
        ))}
      </div>
      <p className="muted">Официант пишет боту /start, бот возвращает chat_id. Для чаевых вставьте персональную ссылку официанта из Точки или другого сервиса.</p>
    </section>
  );
}

function StaffEditor({
  waiters,
  roles,
  accessRole,
  onWaitersChange,
  onRolesChange,
  onSaveWaiters,
  onSaveRoles
}: {
  waiters: Waiter[];
  roles: StaffRoleDefinition[];
  accessRole: AdminAccessRole;
  onWaitersChange: (waiters: Waiter[]) => void;
  onRolesChange: (roles: StaffRoleDefinition[]) => void;
  onSaveWaiters: () => void;
  onSaveRoles: () => void;
}) {
  const updateWaiter = (index: number, patch: Partial<Waiter>) => {
    onWaitersChange(waiters.map((waiter, waiterIndex) => (waiterIndex === index ? { ...waiter, ...patch } : waiter)));
  };
  const updateRole = (index: number, patch: Partial<StaffRoleDefinition>) => {
    onRolesChange(roles.map((role, roleIndex) => (roleIndex === index ? { ...role, ...patch } : role)));
  };
  const roleKindLabel = (role: StaffRoleDefinition) => {
    if (role.kind === "owner") return "Владелец";
    if (role.kind === "admin") return "Администратор";
    if (role.kind === "waiter") return "Официант";
    return "Сотрудник";
  };

  return (
    <div className="staff-admin-layout">
      {accessRole === "owner" && (
        <section className="admin-panel">
          <div className="panel-heading">
            <div>
              <h2>Должности</h2>
              <p className="muted checklist-intro">Должность определяет шаблон чек-листа и правила работы сотрудника в Telegram.</p>
            </div>
            <div className="button-row">
              <button
                className="ghost-button"
                onClick={() => onRolesChange([...roles, { id: "", name: "Новая должность", kind: "staff", system: false, active: true }])}
              >
                <Plus size={18} /> Должность
              </button>
              <button className="primary-button compact" onClick={onSaveRoles}>
                <Save size={18} /> Сохранить
              </button>
            </div>
          </div>
          <div className="editor-list">
            {roles.map((role, index) => {
              const roleInUse = waiters.some((waiter) => waiter.roleId === role.id);
              return (
                <article className="editor-row role-editor-row" key={`${role.id}-${index}`}>
                  <Field label="Название" value={role.name} onChange={(value) => updateRole(index, { name: value })} />
                  <span className="role-kind-label">{roleKindLabel(role)}</span>
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={role.active}
                      disabled={role.kind === "owner" || role.kind === "admin" || role.kind === "waiter"}
                      onChange={(event) => updateRole(index, { active: event.target.checked })}
                    />
                    Активна
                  </label>
                  <button
                    className="icon-button"
                    aria-label="Удалить должность"
                    title={role.system ? "Системную должность удалить нельзя" : roleInUse ? "Сначала смените должность у сотрудников" : "Удалить"}
                    disabled={role.system || roleInUse}
                    onClick={() => onRolesChange(roles.filter((_, roleIndex) => roleIndex !== index))}
                  >
                    <Trash2 size={18} />
                  </button>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <section className="admin-panel">
        <div className="panel-heading">
          <div>
            <h2>Сотрудники</h2>
            <p className="muted checklist-intro">Добавьте сотрудника, выберите должность и вставьте chat_id, который покажет Telegram-бот после команды /start.</p>
          </div>
          <div className="button-row">
            <button
              className="ghost-button"
              onClick={() => onWaitersChange([...waiters, { id: "", name: "Новый сотрудник", roleId: "waiter", telegramChatId: "", tipUrl: "", active: true }])}
            >
              <Plus size={18} /> Сотрудник
            </button>
            <button className="primary-button compact" onClick={onSaveWaiters}>
              <Save size={18} /> Сохранить
            </button>
          </div>
        </div>

        <div className="editor-list">
          {waiters.map((waiter, index) => {
            const role = roles.find((item) => item.id === waiter.roleId);
            return (
              <article className="editor-row employee-editor-row" key={`${waiter.id}-${index}`}>
                <Field label="Имя" value={waiter.name} onChange={(value) => updateWaiter(index, { name: value })} />
                <label className="field">
                  <span>Должность</span>
                  <select value={waiter.roleId} onChange={(event) => updateWaiter(index, { roleId: event.target.value })}>
                    {roles.map((item) => (
                      <option key={item.id} value={item.id} disabled={!item.active}>{item.name}</option>
                    ))}
                  </select>
                </label>
                <Field label="Telegram chat_id" value={waiter.telegramChatId} onChange={(value) => updateWaiter(index, { telegramChatId: value })} />
                <Field
                  label={role?.kind === "waiter" ? "Ссылка для чаевых" : "Рабочая ссылка"}
                  value={waiter.tipUrl}
                  onChange={(value) => updateWaiter(index, { tipUrl: value })}
                  placeholder={role?.kind === "waiter" ? "https://..." : "Необязательно"}
                />
                <label className="toggle-row">
                  <input type="checkbox" checked={waiter.active} onChange={(event) => updateWaiter(index, { active: event.target.checked })} />
                  Активен
                </label>
                <button
                  className="icon-button"
                  aria-label="Удалить сотрудника"
                  disabled={role?.kind === "owner"}
                  title={role?.kind === "owner" ? "Владельца нельзя удалить из этого списка" : "Удалить"}
                  onClick={() => onWaitersChange(waiters.filter((_, waiterIndex) => waiterIndex !== index))}
                >
                  <Trash2 size={18} />
                </button>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ManagementTelegramEditor({
  waiters,
  roles,
  telegramBotUrl,
  onChange,
  onSave
}: {
  waiters: Waiter[];
  roles: StaffRoleDefinition[];
  telegramBotUrl: string;
  onChange: (waiters: Waiter[]) => void;
  onSave: () => void;
}) {
  const managementRoleIds = new Set(roles.filter((role) => role.kind === "admin" || role.kind === "owner").map((role) => role.id));
  const management = waiters.map((waiter, index) => ({ waiter, index })).filter(({ waiter }) => managementRoleIds.has(waiter.roleId));
  const adminRole = roles.find((role) => role.kind === "admin");
  const telegramBotName = telegramBotUrl.split("/").filter(Boolean).at(-1) || "Telegram-бот";
  const update = (index: number, patch: Partial<Waiter>) => {
    onChange(waiters.map((waiter, waiterIndex) => (waiterIndex === index ? { ...waiter, ...patch } : waiter)));
  };

  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <div>
          <h2>Администраторы в Telegram</h2>
          <p className="muted checklist-intro">Сотрудник пишет боту /start, копирует свой chat_id, который необходимо вставить в соответствующее поле нового сотрудника. После этого он сможет начинать смену и получать резервные вызовы гостей.</p>
        </div>
        <div className="button-row">
          {adminRole && (
            <button
              className="ghost-button"
              onClick={() => onChange([...waiters, { id: "", name: "Новый сотрудник", roleId: adminRole.id, telegramChatId: "", tipUrl: "", active: true }])}
            >
              <Plus size={18} /> Добавить
            </button>
          )}
          <button className="primary-button compact" onClick={onSave}>
            <Save size={18} /> Сохранить
          </button>
        </div>
      </div>

      <div className="telegram-registration-band telegram-bot-band">
        <div className="telegram-qr">
          <QRCodeSVG value={telegramBotUrl} size={116} />
        </div>
        <div>
          <strong>Подключение сотрудников к Telegram</strong>
          <p>Добавьте сотрудника и зарегистрируйте его Telegram chat_id. Один chat_id может принадлежать только одному сотруднику.</p>
          <a className="ghost-button telegram-bot-link" href={telegramBotUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={17} /> Открыть @{telegramBotName}
          </a>
        </div>
      </div>

      <div className="editor-list">
        {management.map(({ waiter, index }) => (
          <article className="editor-row management-editor-row" key={`${waiter.id}-${index}`}>
            <Field label="Сотрудник" value={waiter.name} onChange={(value) => update(index, { name: value })} />
            <label className="field">
              <span>Должность</span>
              <select value={waiter.roleId} onChange={(event) => update(index, { roleId: event.target.value })}>
                {roles.filter((role) => role.kind === "admin" || role.kind === "owner").map((role) => (
                  <option key={role.id} value={role.id}>{role.name}</option>
                ))}
              </select>
            </label>
            <Field label="Telegram chat_id" value={waiter.telegramChatId} onChange={(value) => update(index, { telegramChatId: value })} />
            <label className="toggle-row">
              <input type="checkbox" checked={waiter.active} onChange={(event) => update(index, { active: event.target.checked })} />
              Активен
            </label>
          </article>
        ))}
        {!management.length && <p className="muted">Добавьте сотрудника и зарегистрируйте его Telegram chat_id.</p>}
      </div>
    </section>
  );
}

function ChecklistEditor({
  items,
  shiftTasks,
  roles,
  waiters,
  authHeaders,
  onChange,
  onSave,
  onRefresh
}: {
  items: ChecklistItem[];
  shiftTasks: ShiftTask[];
  roles: StaffRoleDefinition[];
  waiters: Waiter[];
  authHeaders: Record<string, string>;
  onChange: (items: ChecklistItem[]) => void;
  onSave: () => void;
  onRefresh: () => Promise<void>;
}) {
  const availableRoles = roles.filter((role) => role.active || items.some((item) => item.roleId === role.id));
  const preferredRoleId = availableRoles.find((role) => role.kind === "waiter")?.id || availableRoles[0]?.id || "";
  const [roleId, setRoleId] = useState(preferredRoleId);
  const [section, setSection] = useState<"template" | "tasks">("template");
  const [taskDate, setTaskDate] = useState(() => new Intl.DateTimeFormat("en-CA").format(new Date()));
  const [taskWaiterId, setTaskWaiterId] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskRequired, setTaskRequired] = useState(false);
  const [taskCountsForRating, setTaskCountsForRating] = useState(true);
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskNotice, setTaskNotice] = useState("");

  useEffect(() => {
    if (!availableRoles.some((role) => role.id === roleId)) setRoleId(preferredRoleId);
  }, [availableRoles, preferredRoleId, roleId]);

  useEffect(() => setTaskWaiterId(""), [roleId]);

  const roleEntries = items
    .map((item, globalIndex) => ({ item, globalIndex }))
    .filter(({ item }) => item.roleId === roleId)
    .sort((left, right) => left.item.sort - right.item.sort);
  const roleTasks = shiftTasks
    .filter((task) => task.roleId === roleId)
    .sort((left, right) => left.date.localeCompare(right.date) || right.createdAt.localeCompare(left.createdAt));
  const roleWaiters = waiters.filter((waiter) => waiter.roleId === roleId && waiter.active);

  const updateItem = (globalIndex: number, patch: Partial<ChecklistItem>) => {
    onChange(items.map((item, index) => (index === globalIndex ? { ...item, ...patch } : item)));
  };

  const moveItem = (roleIndex: number, direction: -1 | 1) => {
    const target = roleIndex + direction;
    if (target < 0 || target >= roleEntries.length) return;
    const reordered = [...roleEntries];
    [reordered[roleIndex], reordered[target]] = [reordered[target], reordered[roleIndex]];
    const sortByIndex = new Map(reordered.map((entry, index) => [entry.globalIndex, (index + 1) * 10]));
    onChange(items.map((item, index) => sortByIndex.has(index) ? { ...item, sort: sortByIndex.get(index)! } : item));
  };

  const createTask = async () => {
    if (!taskDate || !taskTitle.trim() || !roleId) {
      setTaskNotice("Укажите дату и название задания");
      return;
    }
    setTaskBusy(true);
    setTaskNotice("");
    try {
      await api<ShiftTask>("/api/admin/shift-tasks", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          roleId,
          waiterId: taskWaiterId || null,
          date: taskDate,
          title: taskTitle.trim(),
          description: taskDescription.trim(),
          requiredForCalls: taskRequired,
          countsForRating: taskCountsForRating
        })
      });
      setTaskTitle("");
      setTaskDescription("");
      setTaskRequired(false);
      setTaskCountsForRating(true);
      setTaskNotice(taskWaiterId ? "Задание назначено сотруднику" : "Задание назначено всей должности");
      await onRefresh();
    } catch (requestError) {
      setTaskNotice(requestError instanceof Error ? requestError.message : "Не удалось создать задание");
    } finally {
      setTaskBusy(false);
    }
  };

  const deleteTask = async (task: ShiftTask) => {
    if (!window.confirm(`Удалить задание «${task.title}»? Уже созданные смены сохранят его в своей истории.`)) return;
    setTaskBusy(true);
    setTaskNotice("");
    try {
      await api(`/api/admin/shift-tasks/${task.id}`, { method: "DELETE", headers: authHeaders });
      setTaskNotice("Задание удалено из расписания");
      await onRefresh();
    } catch (requestError) {
      setTaskNotice(requestError instanceof Error ? requestError.message : "Не удалось удалить задание");
    } finally {
      setTaskBusy(false);
    }
  };

  return (
    <section className="admin-panel checklist-workspace">
      <div className="panel-heading">
        <div>
          <h2>Чек-листы по должностям</h2>
          <p className="muted checklist-intro">Шаблон повторяется каждую смену. Задания по датам добавляются к шаблону только в назначенный день.</p>
        </div>
      </div>

      <div className="role-tabs" role="tablist" aria-label="Должность">
        {availableRoles.map((role) => (
          <button key={role.id} className={roleId === role.id ? "active" : ""} onClick={() => setRoleId(role.id)}>
            {role.name}
          </button>
        ))}
      </div>

      <div className="checklist-section-tabs" role="tablist" aria-label="Раздел чек-листа">
        <button className={section === "template" ? "active" : ""} onClick={() => setSection("template")}>
          <ClipboardCheck size={17} /> Шаблон смены
        </button>
        <button className={section === "tasks" ? "active" : ""} onClick={() => setSection("tasks")}>
          <CalendarDays size={17} /> Задания по датам
        </button>
      </div>

      {section === "template" ? (
        <div className="checklist-section-body">
          <div className="section-toolbar">
            <p className="muted">Обязательные пункты блокируют рабочие уведомления официанта до выполнения.</p>
            <div className="button-row">
              <button
                className="ghost-button"
                onClick={() => onChange([...items, {
                  id: crypto.randomUUID(),
                  roleId,
                  title: "Новый пункт",
                   description: "",
                   requiredForCalls: false,
                   countsForRating: true,
                   active: true,
                  sort: (roleEntries.length + 1) * 10
                }])}
              >
                <Plus size={18} /> Пункт
              </button>
              <button className="primary-button compact" onClick={onSave}>
                <Save size={18} /> Сохранить шаблоны
              </button>
            </div>
          </div>

          <div className="editor-list">
            {roleEntries.map(({ item, globalIndex }, roleIndex) => (
              <article className="checklist-template-row" key={item.id}>
                <div className="reorder-buttons" aria-label="Порядок пункта">
                  <button className="icon-button" disabled={roleIndex === 0} onClick={() => moveItem(roleIndex, -1)} aria-label="Поднять выше"><ArrowUp size={17} /></button>
                  <button className="icon-button" disabled={roleIndex === roleEntries.length - 1} onClick={() => moveItem(roleIndex, 1)} aria-label="Опустить ниже"><ArrowDown size={17} /></button>
                </div>
                <Field label="Задача" value={item.title} onChange={(value) => updateItem(globalIndex, { title: value })} />
                <Field label="Пояснение" value={item.description} onChange={(value) => updateItem(globalIndex, { description: value })} />
                <label className="toggle-row">
                  <input type="checkbox" checked={item.requiredForCalls} onChange={(event) => updateItem(globalIndex, { requiredForCalls: event.target.checked })} />
                  Обязателен для допуска
                </label>
                <label className="toggle-row">
                  <input type="checkbox" checked={item.countsForRating !== false} onChange={(event) => updateItem(globalIndex, { countsForRating: event.target.checked })} />
                  Учитывать в рейтинге
                </label>
                <label className="toggle-row">
                  <input type="checkbox" checked={item.active} onChange={(event) => updateItem(globalIndex, { active: event.target.checked })} />
                  Активен
                </label>
                <button className="icon-button" onClick={() => onChange(items.filter((_, index) => index !== globalIndex))} aria-label="Удалить пункт">
                  <Trash2 size={18} />
                </button>
              </article>
            ))}
            {!roleEntries.length && <p className="muted">Для этой должности шаблон пока пуст.</p>}
          </div>
        </div>
      ) : (
        <div className="checklist-section-body">
          <div className="shift-task-form">
            <label className="field">
              <span>Дата выполнения</span>
              <input type="date" value={taskDate} onChange={(event) => setTaskDate(event.target.value)} />
            </label>
            <label className="field">
              <span>Кому назначить</span>
              <select
                value={taskWaiterId}
                title={taskWaiterId ? roleWaiters.find((waiter) => waiter.id === taskWaiterId)?.name : "Всем сотрудникам должности"}
                onChange={(event) => setTaskWaiterId(event.target.value)}
              >
                <option value="">Всем сотрудникам должности</option>
                {roleWaiters.map((waiter) => <option key={waiter.id} value={waiter.id}>{waiter.name}</option>)}
              </select>
            </label>
            <Field label="Задание" value={taskTitle} onChange={setTaskTitle} placeholder="Например: проверить летнюю веранду" />
            <Field label="Пояснение" value={taskDescription} onChange={setTaskDescription} placeholder="Что именно нужно сделать" />
            <label className="toggle-row shift-task-required">
              <input type="checkbox" checked={taskRequired} onChange={(event) => setTaskRequired(event.target.checked)} />
              Обязательно для допуска
            </label>
            <label className="toggle-row shift-task-required">
              <input type="checkbox" checked={taskCountsForRating} onChange={(event) => setTaskCountsForRating(event.target.checked)} />
              Учитывать в рейтинге
            </label>
            <button className="primary-button compact shift-task-submit" disabled={taskBusy} onClick={() => void createTask()}>
              <Plus size={18} /> Назначить
            </button>
          </div>
          <p className="muted checklist-intro">Персональное задание отправляется в Telegram в назначенную дату даже без открытой смены. Задание всей должности появляется у каждого сотрудника при начале смены.</p>
          {taskNotice && <div className="task-notice">{taskNotice}</div>}

          <div className="shift-task-list">
            {roleTasks.map((task) => {
              const waiter = waiters.find((item) => item.id === task.waiterId);
              return (
                <article className="shift-task-row" key={task.id}>
                  <div className="shift-task-date">
                    <CalendarDays size={18} />
                    <strong>{new Intl.DateTimeFormat("ru-RU").format(new Date(`${task.date}T12:00:00`))}</strong>
                  </div>
                  <div>
                    <strong>{task.title}</strong>
                    <span>{task.description || "Без пояснения"}</span>
                  </div>
                  <div>
                    <strong>{waiter?.name || "Вся должность"}</strong>
                    <span>{task.waiterId ? (task.notified ? "Telegram отправлен" : "Ожидает даты отправки") : "При начале смены"}</span>
                  </div>
                  <div className="task-badges">
                    {task.requiredForCalls && <span className="required-badge">Обязательное</span>}
                    {task.countsForRating === false && <span className="rating-excluded-badge">Без рейтинга</span>}
                  </div>
                  <button className="icon-button" disabled={taskBusy} onClick={() => void deleteTask(task)} aria-label="Удалить задание">
                    <Trash2 size={18} />
                  </button>
                </article>
              );
            })}
            {!roleTasks.length && <p className="muted">На выбранные даты заданий пока нет.</p>}
          </div>
        </div>
      )}
    </section>
  );
}

function filterPerformanceAnalytics(performance: PerformanceAnalytics, roleIds: string[]): PerformanceAnalytics {
  const allowed = new Set(roleIds);
  const roleSummaries = performance.roleSummaries.filter((item) => allowed.has(item.roleId));
  const taskPatterns = performance.taskPatterns.filter((item) => allowed.has(item.roleId));
  const employeePatterns = performance.employeePatterns.filter((item) => allowed.has(item.roleId));
  const recommendations = taskPatterns
    .filter((item) => item.assignments >= 2 && item.issueRate >= 25)
    .slice(0, 5)
    .map((item) => `${item.roleName}: «${item.taskTitle}» дает сбой в ${item.issueRate}% случаев.`);
  return {
    generatedAt: performance.generatedAt,
    analyzedShiftCount: roleSummaries.reduce((sum, item) => sum + item.ratedShiftCount, 0),
    roleSummaries,
    taskPatterns,
    employeePatterns,
    recommendations: recommendations.length ? recommendations : ["Повторяющихся сбоев для устойчивого вывода пока недостаточно."]
  };
}

type ShiftReviewDraft = Record<string, Record<string, { score: number; comment: string }>>;

function StarScore({ value, disabled, onChange }: { value: number; disabled?: boolean; onChange: (value: number) => void }) {
  return (
    <div className={`star-score-control${disabled ? " disabled" : ""}`} role="radiogroup" aria-label="Оценка задания">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          type="button"
          key={star}
          disabled={disabled}
          className={star <= value ? "selected" : ""}
          onClick={() => onChange(star)}
          aria-label={`${star} ${star === 1 ? "звезда" : star < 5 ? "звезды" : "звезд"}`}
        >
          <Star size={20} fill={star <= value ? "currentColor" : "none"} />
        </button>
      ))}
      <strong>{value || 0}</strong>
    </div>
  );
}

function ShiftsAndRatings({
  ratings,
  shifts,
  performance,
  performanceAiEnabled,
  authHeaders,
  onRefresh,
  title
}: {
  ratings: WaiterRating[];
  shifts: WaiterShift[];
  performance: PerformanceAnalytics;
  performanceAiEnabled: boolean;
  authHeaders: Record<string, string>;
  onRefresh: () => Promise<void>;
  title: string;
}) {
  const [drafts, setDrafts] = useState<ShiftReviewDraft>({});
  const [savingShift, setSavingShift] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedRoleId, setSelectedRoleId] = useState("all");
  const [insight, setInsight] = useState<PerformanceInsightReport | null>(null);
  const [insightBusy, setInsightBusy] = useState(false);
  const [journalDate, setJournalDate] = useState("");
  const ratedEmployees = ratings.filter((item) => item.shiftCount > 0);
  const average = ratedEmployees.length
    ? Math.round((ratedEmployees.reduce((sum, item) => sum + item.score, 0) / ratedEmployees.length) * 100) / 100
    : 0;
  const visibleRatings = selectedRoleId === "all" ? ratings : ratings.filter((item) => item.roleId === selectedRoleId);
  const roleTabs = performance.roleSummaries;
  const journalShifts = shifts
    .filter((shift) => !journalDate || new Intl.DateTimeFormat("en-CA").format(new Date(shift.startedAt)) === journalDate)
    .slice(0, 80);

  const draftFor = (shift: WaiterShift, itemId: string) => {
    const item = shift.checklist.find((entry) => entry.itemId === itemId)!;
    return drafts[shift.id]?.[itemId] || {
      score: item.completedAt && item.countsForRating !== false ? (item.adminScore ?? 5) : 0,
      comment: item.adminComment
    };
  };

  const updateDraft = (shift: WaiterShift, itemId: string, patch: Partial<{ score: number; comment: string }>) => {
    const current = draftFor(shift, itemId);
    setDrafts((value) => ({
      ...value,
      [shift.id]: {
        ...(value[shift.id] || {}),
        [itemId]: { ...current, ...patch }
      }
    }));
  };

  const saveReview = async (shift: WaiterShift) => {
    setSavingShift(shift.id);
    setNotice("");
    try {
      await api(`/api/admin/shifts/${shift.id}/review`, {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({
          reviews: shift.checklist.map((item) => {
            const draft = draftFor(shift, item.itemId);
            return {
              itemId: item.itemId,
              score: item.completedAt && item.countsForRating !== false ? Math.max(1, Math.min(5, draft.score)) : null,
              comment: draft.comment
            };
          })
        })
      });
      setNotice("Оценка смены сохранена");
      await onRefresh();
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : "Не удалось сохранить оценку");
    } finally {
      setSavingShift("");
    }
  };

  const statusText = (shift: WaiterShift) => shift.status === "ended" ? "Завершена" : shift.status === "active" ? "На линии" : "Выполняет чек-лист";

  const generateInsight = async () => {
    setInsightBusy(true);
    setNotice("");
    try {
      const report = await api<PerformanceInsightReport>("/api/admin/performance-insights", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ roleIds: performance.roleSummaries.map((item) => item.roleId) })
      });
      setInsight(report);
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : "Не удалось сформировать анализ");
    } finally {
      setInsightBusy(false);
    }
  };

  return (
    <div className="shift-admin-layout">
      <div className="admin-grid shift-metrics">
        <Metric title="Сотрудников в рейтинге" value={ratings.length} icon={<Users size={22} />} />
        <Metric title="Средний рейтинг" value={`${average} ★`} icon={<Star size={22} />} />
        <Metric title="Активные смены" value={shifts.filter((shift) => shift.status !== "ended").length} icon={<Clock size={22} />} />
        <Metric title="Ожидают чек-лист" value={shifts.filter((shift) => shift.status === "checklist").length} icon={<ClipboardCheck size={22} />} />
      </div>

      <section className="admin-panel">
        <div className="panel-heading"><div><h2>{title}: рейтинг по подразделениям</h2><p className="muted">Место считается отдельно внутри каждой должности.</p></div><Trophy size={20} /></div>
        {roleTabs.length > 1 && (
          <div className="role-tabs performance-role-tabs" role="tablist" aria-label="Подразделение">
            <button className={selectedRoleId === "all" ? "active" : ""} onClick={() => setSelectedRoleId("all")}>Все</button>
            {roleTabs.map((role) => <button key={role.roleId} className={selectedRoleId === role.roleId ? "active" : ""} onClick={() => setSelectedRoleId(role.roleId)}>{role.roleName}</button>)}
          </div>
        )}
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead><tr><th>Место</th><th>Сотрудник</th><th>Должность</th><th>Рейтинг</th><th>Накоплено</th><th>Выполнение</th><th>Динамика</th><th>Смен</th></tr></thead>
            <tbody>
              {visibleRatings.map((rating) => (
                <tr key={rating.waiterId}>
                  <td className="ranking-place">#{rating.rank}</td>
                  <td><strong>{rating.waiterName}</strong></td>
                  <td>{rating.roleName}</td>
                  <td><span className="rating-value"><Star size={16} fill="currentColor" /><strong>{rating.shiftCount ? rating.score : "—"}</strong></span></td>
                  <td>{rating.totalStars} ★</td>
                  <td>{rating.completionRate}%</td>
                  <td><span className={rating.trend > 0 ? "trend-up" : rating.trend < 0 ? "trend-down" : "muted"}>{rating.trend > 0 ? "+" : ""}{rating.trend}</span></td>
                  <td>{rating.shiftCount}</td>
                </tr>
              ))}
              {!visibleRatings.length && <tr><td className="ops-table-empty" colSpan={8}>Завершенных смен для рейтинга пока нет.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-panel">
        <div className="panel-heading"><div><h2>Сравнение подразделений</h2><p className="muted">Средняя оценка и дисциплина выполнения задач по каждой должности.</p></div><Users size={20} /></div>
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead><tr><th>Подразделение</th><th>Сотрудников</th><th>Оцененных смен</th><th>Средний рейтинг</th><th>Выполнение задач</th></tr></thead>
            <tbody>
              {performance.roleSummaries.map((role) => <tr key={role.roleId}><td><strong>{role.roleName}</strong></td><td>{role.employeeCount}</td><td>{role.ratedShiftCount}</td><td>{role.ratedShiftCount ? `${role.averageStars} ★` : "—"}</td><td>{role.completionRate}%</td></tr>)}
              {!performance.roleSummaries.length && <tr><td className="ops-table-empty" colSpan={5}>Данных по подразделениям пока нет.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-panel performance-patterns-panel">
        <div className="panel-heading"><div><h2>Повторяющиеся сбои</h2><p className="muted">Высокая частота у разных сотрудников может указывать на проблему процесса, инструкции или ресурсов.</p></div><AlertTriangle size={20} /></div>
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead><tr><th>Подразделение</th><th>Задача</th><th>Назначено</th><th>Не выполнено</th><th>Низких оценок</th><th>Средняя оценка</th><th>Сбой</th></tr></thead>
            <tbody>
              {performance.taskPatterns.filter((item) => item.issueRate > 0).slice(0, 12).map((item) => (
                <tr key={item.key}><td>{item.roleName}</td><td><strong>{item.taskTitle}</strong>{!item.countsForRating && <small className="table-note">Без влияния на рейтинг</small>}</td><td>{item.assignments}</td><td>{item.missed}</td><td>{item.lowRatings}</td><td>{item.averageStars === null ? "—" : `${item.averageStars} ★`}</td><td><strong>{item.issueRate}%</strong></td></tr>
              ))}
              {!performance.taskPatterns.some((item) => item.issueRate > 0) && <tr><td className="ops-table-empty" colSpan={7}>Повторяющихся сбоев пока не обнаружено.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-panel employee-patterns-panel">
        <div className="panel-heading"><div><h2>Паттерны конкретных сотрудников</h2><p className="muted">Список строится по повторяющимся пропускам и оценкам ниже 4 звезд.</p></div><UserRound size={20} /></div>
        <div className="employee-pattern-grid">
          {performance.employeePatterns.slice(0, 12).map((item) => (
            <article key={item.key} className="employee-pattern-row">
              <div><strong>{item.waiterName}</strong><span>{item.roleName}</span></div>
              <div><strong>{item.taskTitle}</strong><span>{item.missed} пропусков · {item.lowRatings} низких оценок · сбой {item.issueRate}%</span></div>
              <p>{item.recommendation}</p>
            </article>
          ))}
          {!performance.employeePatterns.length && <p className="muted">Индивидуальных повторяющихся нарушений пока нет.</p>}
        </div>
      </section>

      <section className="admin-panel ai-insight-panel">
        <div className="panel-heading">
          <div><h2>ИИ-анализ эффективности</h2><p className="muted">{performanceAiEnabled ? "ИИ подключен. Анализ отделяет массовые сбои процесса от индивидуальных повторений." : "ИИ не настроен. Доступен резервный локальный анализ."}</p></div>
          <button className="primary-button compact" disabled={insightBusy} onClick={() => void generateInsight()}><Sparkles size={18} /> {insightBusy ? "Анализируем" : "Запустить анализ"}</button>
        </div>
        {insight && (
          <div className="ai-insight-result">
            <div className="ai-insight-meta"><span>{insight.source === "openrouter" ? "OpenRouter" : "Локальный анализ"}</span><span>{insight.model}</span><span>{formatDate(insight.generatedAt)}</span></div>
            <p className="ai-summary">{insight.summary}</p>
            {insight.warning && <div className="task-notice">{insight.warning}</div>}
            <div className="ai-recommendation-grid">
              {insight.recommendations.map((item, index) => <article key={`${index}-${item}`}><strong>{index + 1}</strong><p>{item}</p></article>)}
            </div>
            {insight.employeeAdvice.length > 0 && (
              <div className="ai-employee-advice">
                <h3>Персональные рекомендации сотрудникам</h3>
                {insight.employeeAdvice.map((item) => (
                  <article key={item.waiterId}>
                    <strong>{ratings.find((rating) => rating.waiterId === item.waiterId)?.waiterName || "Сотрудник"}</strong>
                    <p>{item.advice}</p>
                  </article>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="admin-panel">
        <div className="panel-heading shift-journal-heading">
          <div><h2>{title}: журнал</h2><p className="muted">Выберите дату, чтобы показать смены только за нужный день.</p></div>
          <div className="shift-journal-filter">
            <label className="field">
              <span><CalendarDays size={16} /> Дата смены</span>
              <input type="date" value={journalDate} onChange={(event) => setJournalDate(event.target.value)} />
            </label>
            {journalDate && <button className="icon-button" onClick={() => setJournalDate("")} aria-label="Показать все даты" title="Показать все даты"><X size={18} /></button>}
          </div>
        </div>
        {notice && <div className="task-notice">{notice}</div>}
        <div className="shift-review-list">
          {journalShifts.map((shift) => (
            <details className="shift-review" key={shift.id}>
              <summary>
                <span>
                  <strong>{shift.waiterName} · {shift.roleName}</strong>
                  <small>{statusText(shift)} · {formatDate(shift.startedAt)} · {shift.zones.join(", ")}</small>
                </span>
                <span className="shift-score">{shift.checklist.some((item) => item.countsForRating !== false) ? `${shift.score} / 5 ★` : "Без оценки"}</span>
              </summary>
              <div className="shift-review-items">
                {shift.checklist.map((item) => {
                  const draft = draftFor(shift, item.itemId);
                  return (
                    <div className="shift-review-row" key={item.itemId}>
                      <div className="shift-review-task">
                        {item.completedAt ? <CheckCircle2 size={20} /> : <AlertTriangle size={20} />}
                        <span><strong>{item.title}</strong><small>{item.completedAt ? `Выполнено ${formatDate(item.completedAt)}` : "Не выполнено · 0 звезд"}{item.countsForRating === false ? " · не влияет на рейтинг" : ""}</small></span>
                      </div>
                      <div className="field star-review-field"><span>Оценка</span>{item.countsForRating === false ? <span className="rating-excluded-badge">Не учитывается</span> : <StarScore value={draft.score} disabled={!item.completedAt} onChange={(score) => updateDraft(shift, item.itemId, { score })} />}</div>
                      <Field label="Комментарий" value={draft.comment} onChange={(value) => updateDraft(shift, item.itemId, { comment: value })} placeholder="Что улучшить или почему снижена оценка" />
                    </div>
                  );
                })}
                <div className="shift-review-actions">
                  <button className="primary-button compact" disabled={savingShift === shift.id} onClick={() => void saveReview(shift)}>
                    <Save size={18} /> {savingShift === shift.id ? "Сохраняем" : "Сохранить оценку"}
                  </button>
                </div>
              </div>
            </details>
          ))}
          {!journalShifts.length && <p className="muted">{journalDate ? "На выбранную дату смен нет." : "Смен по этой группе пока нет."}</p>}
        </div>
      </section>
    </div>
  );
}

function ActionsEditor({
  actions,
  onChange,
  onSave
}: {
  actions: CallAction[];
  onChange: (actions: CallAction[]) => void;
  onSave: () => void;
}) {
  const update = (index: number, patch: Partial<CallAction>) => {
    onChange(actions.map((action, actionIndex) => (actionIndex === index ? { ...action, ...patch } : action)));
  };

  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <h2>Кнопки вызова</h2>
        <div className="button-row">
          <button
            className="ghost-button"
            onClick={() =>
              onChange([
                ...actions,
                {
                  id: "",
                  label: "Новая кнопка",
                  description: "Описание для гостя",
                  emoji: "🔔",
                  active: true,
                  sort: (actions.length + 1) * 10
                }
              ])
            }
          >
            <Plus size={18} />
            Кнопка
          </button>
          <button className="primary-button compact" onClick={onSave}>
            <Save size={18} />
            Сохранить
          </button>
        </div>
      </div>

      <div className="editor-list">
        {actions.map((action, index) => (
          <article className="editor-row" key={`${action.id}-${index}`}>
            <Field label="Иконка" value={action.emoji} onChange={(value) => update(index, { emoji: value })} short />
            <Field label="Название" value={action.label} onChange={(value) => update(index, { label: value })} />
            <Field label="Описание" value={action.description} onChange={(value) => update(index, { description: value })} />
            <Field label="Сортировка" value={String(action.sort)} onChange={(value) => update(index, { sort: Number(value) || 0 })} short />
            <label className="toggle-row">
              <input type="checkbox" checked={action.active} onChange={(event) => update(index, { active: event.target.checked })} />
              Вкл
            </label>
            <button className="icon-button" onClick={() => onChange(actions.filter((_, actionIndex) => actionIndex !== index))}>
              <Trash2 size={18} />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function OffersEditor({
  offers,
  onChange,
  onSave
}: {
  offers: Offer[];
  onChange: (offers: Offer[]) => void;
  onSave: () => void;
}) {
  const update = (index: number, patch: Partial<Offer>) => {
    onChange(offers.map((offer, offerIndex) => (offerIndex === index ? { ...offer, ...patch } : offer)));
  };

  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <h2>Акции и спецпредложения</h2>
        <div className="button-row">
          <button
            className="ghost-button"
            onClick={() =>
              onChange([
                ...offers,
                {
                  id: "",
                  title: "Новая акция",
                  description: "Условия акции",
                  badge: "Акция",
                  active: true
                }
              ])
            }
          >
            <Plus size={18} />
            Акция
          </button>
          <button className="primary-button compact" onClick={onSave}>
            <Save size={18} />
            Сохранить
          </button>
        </div>
      </div>

      <div className="editor-list">
        {offers.map((offer, index) => (
          <article className="editor-row" key={`${offer.id}-${index}`}>
            <Field label="Метка" value={offer.badge} onChange={(value) => update(index, { badge: value })} short />
            <Field label="Название" value={offer.title} onChange={(value) => update(index, { title: value })} />
            <Field label="Описание" value={offer.description} onChange={(value) => update(index, { description: value })} />
            <label className="toggle-row">
              <input type="checkbox" checked={offer.active} onChange={(event) => update(index, { active: event.target.checked })} />
              Вкл
            </label>
            <button className="icon-button" onClick={() => onChange(offers.filter((_, offerIndex) => offerIndex !== index))}>
              <Trash2 size={18} />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function LoyaltyList({ leads, tables }: { leads: LoyaltyLead[]; tables: DiningTable[] }) {
  const tableName = (id: string | null) => tables.find((table) => table.id === id)?.name || "Без стола";

  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <h2>Заявки в программу лояльности</h2>
        <Gift size={20} />
      </div>
      <div className="lead-list">
        {leads.map((lead) => (
          <article className="lead-row" key={lead.id}>
            <strong>{lead.name}</strong>
            <span>{lead.phone}</span>
            <span>{lead.birthday || "День рождения не указан"}</span>
            <span>{tableName(lead.tableId)}</span>
            <span>{lead.cardNumber ? `Карта ${lead.cardNumber}` : "Карта не выпущена"}</span>
            <span>{Math.round(lead.bonusBalance)} ₽, {lead.welcomeBonusStatus}</span>
            <span>{lead.marketingConsent ? "Рассылка: да" : "Рассылка: нет"}</span>
            <span>{formatDate(lead.createdAt)}</span>
          </article>
        ))}
        {!leads.length && <p className="muted">Заявок пока нет.</p>}
      </div>
    </section>
  );
}

function FeedbacksList({ feedbacks, tables, waiters }: { feedbacks: GuestFeedback[]; tables: DiningTable[]; waiters: Waiter[] }) {
  const tableName = (id: string | null) => tables.find((table) => table.id === id)?.name || "Без стола";
  const waiterName = (id: string | null) => waiters.find((w) => w.id === id)?.name || "Без официанта";
  
  const total = feedbacks.length;
  const averageRating = total > 0 ? (feedbacks.reduce((acc, f) => acc + f.rating, 0) / total).toFixed(1) : "0.0";
  const negativeCount = feedbacks.filter((f) => f.rating <= 3).length;
  const clicksCount = feedbacks.reduce((acc, f) => acc + f.reviewClickCount, 0);

  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <h2>Отзывы гостей</h2>
        <Star size={20} />
      </div>
      <div className="admin-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: '24px' }}>
        <Metric title="Всего отзывов" value={total} icon={<MessageSquare size={22} />} />
        <Metric title="Средняя оценка" value={Number(averageRating)} icon={<Star size={22} />} />
        <Metric title="Проблемных (1-3)" value={negativeCount} icon={<AlertTriangle size={22} />} />
        <Metric title="Переходов 2ГИС" value={clicksCount} icon={<CheckCircle2 size={22} />} />
      </div>
      <div className="table-container" style={{ overflowX: 'auto', background: 'var(--surface-color)', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.2)' }}>
              <th style={{ padding: '16px' }}>Дата</th>
              <th style={{ padding: '16px' }}>Оценка</th>
              <th style={{ padding: '16px' }}>Стол / Официант</th>
              <th style={{ padding: '16px' }}>Комментарий</th>
              <th style={{ padding: '16px' }}>Гость</th>
            </tr>
          </thead>
          <tbody>
            {feedbacks.map((f) => (
              <tr key={f.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={{ padding: '16px', color: 'var(--muted-color)' }}>
                  {formatDate(f.createdAt)}
                </td>
                <td style={{ padding: '16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: f.rating >= 4 ? 'var(--brand-accent)' : '#ff4d4f' }}>
                    <Star size={16} fill="currentColor" />
                    <strong>{f.rating}</strong>
                  </div>
                </td>
                <td style={{ padding: '16px' }}>
                  <div style={{ fontWeight: 500 }}>{tableName(f.tableId)}</div>
                  <div className="muted" style={{ fontSize: '0.85em' }}>{waiterName(f.waiterId)}</div>
                </td>
                <td style={{ padding: '16px', maxWidth: '300px' }}>
                  {f.reasons.length > 0 && <div className="muted" style={{ fontSize: '0.85em', marginBottom: '4px' }}>Причины: {f.reasons.join(", ")}</div>}
                  {f.liked && <div style={{ color: '#52c41a', fontSize: '0.9em' }}>+ {f.liked}</div>}
                  {f.disliked && <div style={{ color: '#ff4d4f', fontSize: '0.9em' }}>- {f.disliked}</div>}
                  {!f.liked && !f.disliked && f.reasons.length === 0 && <span className="muted">-</span>}
                </td>
                <td style={{ padding: '16px' }}>
                  {f.guestName || f.phone ? (
                    <>
                      <div>{f.guestName || "Без имени"}</div>
                      <div className="muted" style={{ fontSize: '0.85em' }}>{f.phone}</div>
                    </>
                  ) : <span className="muted">Аноним</span>}
                </td>
              </tr>
            ))}
            {!feedbacks.length && (
              <tr>
                <td colSpan={5} style={{ padding: '32px', textAlign: 'center', color: 'var(--muted-color)' }}>
                  Отзывов пока нет
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const color = /^#[0-9a-f]{6}$/i.test(value) ? value : "#202030";

  return (
    <label className="field color-field">
      <span>
        <Palette size={15} />
        {label}
      </span>
      <div>
        <input type="color" value={color} onChange={(event) => onChange(event.target.value)} />
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="#202030" />
      </div>
    </label>
  );
}

function Field({
  label,
  value,
  onChange,
  textarea,
  full,
  short,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  textarea?: boolean;
  full?: boolean;
  short?: boolean;
  placeholder?: string;
}) {
  const helpText = placeholder && placeholder.length > 18 ? placeholder : "";
  return (
    <label className={`field ${full ? "field-full" : ""} ${short ? "field-short" : ""}`}>
      <span className="field-label">
        {label}
        {helpText && (
          <span className="field-help" tabIndex={0} aria-label={`Подсказка: ${helpText}`}>
            <CircleHelp size={15} />
            <span className="field-tooltip" role="tooltip">{helpText}</span>
          </span>
        )}
      </span>
      {textarea ? (
        <textarea rows={4} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} title={value || helpText || undefined} />
      ) : (
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} title={value || helpText || undefined} />
      )}
    </label>
  );
}

function GuestPopupGallery({
  popups,
  onClose,
  onAction
}: {
  popups: PopupNotification[];
  onClose: () => void;
  onAction: (url: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const popup = popups[index];
  if (!popup) return null;

  const finishSwipe = (clientX: number) => {
    if (touchStart === null) return;
    const delta = clientX - touchStart;
    if (delta < -45 && index < popups.length - 1) setIndex(index + 1);
    if (delta > 45 && index > 0) setIndex(index - 1);
    setTouchStart(null);
  };

  return (
    <div className="popup-overlay" onClick={onClose}>
      <div
        className="popup-card"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(event) => setTouchStart(event.touches[0]?.clientX ?? null)}
        onTouchEnd={(event) => finishSwipe(event.changedTouches[0]?.clientX ?? 0)}
      >
        {popup.imageUrl ? (
          <img className="popup-image" src={popup.imageUrl} alt="" />
        ) : (
          <div className="popup-no-image">
            <Gift size={48} color="rgba(255,253,250,0.8)" />
          </div>
        )}
        <button className="popup-close icon-button" onClick={onClose} aria-label="Закрыть">
          <X size={20} />
        </button>
        <div className="popup-body">
          <h2 className="popup-title">{popup.title}</h2>
          <p className="popup-text" style={{ whiteSpace: "pre-wrap" }}>{popup.body}</p>

          {popup.buttonText && (
            <button
              className="primary-button"
              style={{ width: "100%", marginTop: 16 }}
              onClick={() => onAction(popup.buttonUrl)}
            >
              {popup.buttonText}
            </button>
          )}

          {popups.length > 1 && (
            <div className="popup-gallery-controls" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', marginTop: '20px' }}>
              <button
                className="icon-button"
                style={{ background: 'rgba(255,253,250,0.1)', minHeight: '36px', padding: '0 8px' }}
                disabled={index === 0}
                onClick={() => setIndex(index - 1)}
              >
                <ChevronLeft size={20} />
              </button>
              <span style={{ fontSize: '14px', color: 'rgba(255,253,250,0.6)' }}>
                {index + 1} из {popups.length}
              </span>
              <button
                className="icon-button"
                style={{ background: 'rgba(255,253,250,0.1)', minHeight: '36px', padding: '0 8px' }}
                disabled={index === popups.length - 1}
                onClick={() => setIndex(index + 1)}
              >
                <ChevronRight size={20} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PopupsEditor({
  popups,
  authHeaders,
  onChange
}: {
  popups: PopupNotification[];
  authHeaders: Record<string, string>;
  onChange: () => void;
}) {
  const [editingPopup, setEditingPopup] = useState<Partial<PopupNotification> | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);

  const savePopup = async () => {
    if (!editingPopup?.title?.trim() || !editingPopup?.body?.trim()) {
      setError("Заголовок и текст обязательны");
      return;
    }

    setSaving(true);
    setError("");

    try {
      let imageUrl = editingPopup.imageUrl || "";

      if (imageFile) {
        const uploadResponse = await fetch("/api/admin/upload", {
          method: "POST",
          body: imageFile,
          headers: { ...authHeaders, "content-type": imageFile.type }
        });
        const uploadResult = await uploadResponse.json();
        if (!uploadResponse.ok) throw new Error(uploadResult.error || "Ошибка загрузки картинки");
        imageUrl = uploadResult.url;
      }

      const payload = {
        ...editingPopup,
        imageUrl,
        title: editingPopup.title.trim(),
        body: editingPopup.body.trim(),
        buttonText: editingPopup.buttonText?.trim() || "",
        buttonUrl: editingPopup.buttonUrl?.trim() || "",
        active: editingPopup.active ?? true,
        sort: editingPopup.sort ?? (popups.length + 1) * 10
      };

      if (editingPopup.id) {
        await api(`/api/admin/popups/${editingPopup.id}`, {
          method: "PUT",
          headers: authHeaders,
          body: JSON.stringify(payload)
        });
      } else {
        await api("/api/admin/popups", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(payload)
        });
      }

      setEditingPopup(null);
      setImageFile(null);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  };

  const deletePopup = async (id: string) => {
    if (!window.confirm("Удалить это уведомление?")) return;
    try {
      await api(`/api/admin/popups/${id}`, { method: "DELETE", headers: authHeaders });
      onChange();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Ошибка удаления");
    }
  };

  const toggleActive = async (popup: PopupNotification) => {
    try {
      await api(`/api/admin/popups/${popup.id}`, {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({ active: !popup.active })
      });
      onChange();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Ошибка");
    }
  };

  return (
    <div className="admin-panel" style={{ padding: "20px" }}>
      <div className="panel-heading">
        <h2>Всплывающие уведомления</h2>
        {!editingPopup && (
          <button className="primary-button" onClick={() => setEditingPopup({ active: true })}>
            <Plus size={16} /> Создать уведомление
          </button>
        )}
      </div>

      {editingPopup ? (
        <div style={{ marginTop: "24px", padding: "20px", border: "1px solid #ded6c8", borderRadius: "8px", background: "#f8f0ef" }}>
          <h3 style={{ marginTop: 0, marginBottom: "16px" }}>{editingPopup.id ? "Редактировать уведомление" : "Новое уведомление"}</h3>

          <div style={{ display: "grid", gap: "12px" }}>
            <label>
              <strong>Заголовок</strong>
              <input
                value={editingPopup.title || ""}
                onChange={(e) => setEditingPopup({ ...editingPopup, title: e.target.value })}
                placeholder="Например: 500 ₽ за регистрацию!"
              />
            </label>

            <label>
              <strong>Текст уведомления</strong>
              <textarea
                value={editingPopup.body || ""}
                onChange={(e) => setEditingPopup({ ...editingPopup, body: e.target.value })}
                placeholder="Опишите подробности..."
                rows={4}
              />
            </label>

            <label>
              <strong>Картинка (необязательно)</strong>
              <input
                type="file"
                accept="image/png, image/jpeg, image/webp"
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    setImageFile(e.target.files[0]);
                  }
                }}
                style={{ padding: '8px' }}
              />
              {(imageFile || editingPopup.imageUrl) && (
                <div style={{ marginTop: '8px', fontSize: '13px', color: '#8b163f' }}>Картинка выбрана</div>
              )}
            </label>

            <label>
              <strong>Текст кнопки (необязательно)</strong>
              <input
                value={editingPopup.buttonText || ""}
                onChange={(e) => setEditingPopup({ ...editingPopup, buttonText: e.target.value })}
                placeholder="Например: Получить карту"
              />
            </label>

            <label>
              <strong>Ссылка для кнопки (необязательно)</strong>
              <input
                value={editingPopup.buttonUrl || ""}
                onChange={(e) => setEditingPopup({ ...editingPopup, buttonUrl: e.target.value })}
                placeholder="Например: /loyalty или https://..."
              />
              <small style={{ display: 'block', marginTop: '4px', color: '#666' }}>Если пусто — кнопка только закроет уведомление.</small>
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "8px" }}>
              <input
                type="checkbox"
                checked={editingPopup.active ?? true}
                onChange={(e) => setEditingPopup({ ...editingPopup, active: e.target.checked })}
                style={{ width: "auto" }}
              />
              <strong>Показывать гостям (Активно)</strong>
            </label>

            <label>
              <strong>Порядок показа (чем меньше, тем раньше)</strong>
              <input
                type="number"
                value={editingPopup.sort ?? ""}
                onChange={(e) => setEditingPopup({ ...editingPopup, sort: parseInt(e.target.value, 10) || 0 })}
              />
            </label>
          </div>

          {error && <div className="error-line" style={{ marginTop: "16px" }}>{error}</div>}

          <div style={{ display: "flex", gap: "10px", marginTop: "24px" }}>
            <button className="primary-button" onClick={() => void savePopup()} disabled={saving}>
              {saving ? "Сохранение..." : "Сохранить"}
            </button>
            <button className="ghost-button" onClick={() => { setEditingPopup(null); setImageFile(null); }} disabled={saving}>
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: "24px", display: "grid", gap: "12px" }}>
          {popups.length === 0 ? (
            <div className="empty-state" style={{ minHeight: "120px" }}>Уведомлений пока нет</div>
          ) : (
            popups.map(popup => (
              <div key={popup.id} style={{ border: "1px solid #ded6c8", borderRadius: "8px", padding: "16px", display: "flex", gap: "16px", background: popup.active ? "#fff" : "#f9f9f9", opacity: popup.active ? 1 : 0.7 }}>
                {popup.imageUrl ? (
                  <img src={popup.imageUrl} alt="" style={{ width: "120px", height: "80px", objectFit: "cover", borderRadius: "4px" }} />
                ) : (
                  <div style={{ width: "120px", height: "80px", background: "#eee", borderRadius: "4px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Gift size={24} color="#ccc" />
                  </div>
                )}

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
                    <span style={{ fontSize: "12px", padding: "2px 6px", borderRadius: "4px", background: popup.active ? "#dff2df" : "#123c28", color: popup.active ? "#123c28" : "#fff", fontWeight: "bold" }}>
                      {popup.active ? "АКТИВНО" : "НЕАКТИВНО"}
                    </span>
                    <strong style={{ fontSize: "16px" }}>{popup.title}</strong>
                  </div>
                  <div style={{ fontSize: "14px", color: "#666", marginBottom: "8px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {popup.body}
                  </div>
                  <div style={{ fontSize: "12px", color: "#888", display: "flex", gap: "16px" }}>
                    <span>Кнопка: {popup.buttonText || "нет"}</span>
                    <span>Порядок: {popup.sort}</span>
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "8px", minWidth: "140px" }}>
                  <button className="ghost-button" style={{ minHeight: "32px", fontSize: "13px" }} onClick={() => toggleActive(popup)}>
                    {popup.active ? "Деактивировать" : "Активировать"}
                  </button>
                  <button className="ghost-button" style={{ minHeight: "32px", fontSize: "13px" }} onClick={() => setEditingPopup(popup)}>
                    Редактировать
                  </button>
                  <button className="ghost-button" style={{ minHeight: "32px", fontSize: "13px", color: "#7b1e17" }} onClick={() => void deletePopup(popup.id)}>
                    Удалить
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
