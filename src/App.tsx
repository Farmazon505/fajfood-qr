import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { TableTentDesigner } from "./TableTentDesigner";
import {
  adminSwipeAction,
  swipeAllowedTarget,
  swipeProgress,
  type AdminSwipeAction,
  type SwipeStart
} from "./admin-swipe";
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
  Menu,
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
import {
  isLatestAdminOverviewRequest,
  mergeAdminOverviewWithDrafts,
  type AdminEditableResource
} from "./admin-drafts";
import { fetchWithNetworkRecovery } from "./network-recovery";
import type {
  AppData,
  AdminAccountSummary,
  AdminAccessRole,
  CallAction,
  CallStatus,
  ChecklistItem,
  ChecklistPhase,
  ChecklistWindows,
  DiningTable,
  GuestFeedback,
  LoyaltyLead,
  Offer,
  OwnerNotificationSettings,
  OwnerWebPushStatus,
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
import {
  CHECKLIST_PHASE_META,
  CHECKLIST_PHASES,
  formatChecklistWindow,
  groupChecklistByPhase
} from "../shared/checklists";

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
  wallet?: {
    webUrl: string;
    appleUrl: string | null;
    googleUrl: string | null;
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
  maxEnabled: boolean;
  maxBotUrl: string;
  ratings: WaiterRating[];
  performance: PerformanceAnalytics;
  performanceAiEnabled: boolean;
  venueTimeZone: string;
  accessRole: AdminAccessRole;
  username: string;
  adminAccount: AdminAccountSummary | null;
  ownerWebPush: OwnerWebPushStatus;
  popups: PopupNotification[];
};

const webPushApplicationKey = (value: string) => {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
};

const isStandaloneWebApp = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);

class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const ADMIN_SESSION_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
const ADMIN_SESSION_REFRESH_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const adminTokenExpiresAt = (token: string) => {
  try {
    const payload = token.split(".")[0];
    if (!payload) return null;
    const padded = `${payload}${"=".repeat((4 - (payload.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
    const binary = window.atob(padded);
    const decoded = new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
    const parsed = JSON.parse(decoded) as { exp?: unknown };
    return typeof parsed.exp === "number" ? parsed.exp : null;
  } catch {
    return null;
  }
};

const adminSessionNeedsRefresh = (token: string, at = Date.now()) => {
  const expiresAt = adminTokenExpiresAt(token);
  return expiresAt !== null && expiresAt > at && expiresAt - at <= ADMIN_SESSION_REFRESH_WINDOW_MS;
};

const api = async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
  const response = await fetchWithNetworkRecovery(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiRequestError(json.error || "Ошибка запроса", response.status);
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

  const loadGuest = useCallback(async () => {
    try {
      const bootstrap = await api<Bootstrap>(
        `/api/public/bootstrap?table=${encodeURIComponent(tableSlug)}`,
      );
      setData(bootstrap);
      setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось загрузить столик");
    }
  }, [tableSlug]);

  useEffect(() => {
    void loadGuest();
  }, [loadGuest]);

  useEffect(() => {
    const recoverVisibleGuest = () => {
      if (document.visibilityState === "visible" && navigator.onLine) void loadGuest();
    };
    window.addEventListener("online", loadGuest);
    window.addEventListener("pageshow", loadGuest);
    document.addEventListener("visibilitychange", recoverVisibleGuest);
    return () => {
      window.removeEventListener("online", loadGuest);
      window.removeEventListener("pageshow", loadGuest);
      document.removeEventListener("visibilitychange", recoverVisibleGuest);
    };
  }, [loadGuest]);

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

  if (!data && error) {
    return (
      <main className="guest-shell empty-state">
        <Wifi size={34} />
        <h1>Восстанавливаем соединение</h1>
        <p>{error}</p>
        <button className="primary-button" type="button" onClick={() => void loadGuest()}>
          Повторить
        </button>
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
                <div className="loyalty-brand-mark" aria-hidden="true">F</div>
                <div className="loyalty-card__identity">
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
              {loyaltyProfile.wallet?.webUrl && (
                <a
                  className="loyalty-wallet-link"
                  href={loyaltyProfile.wallet.webUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={17} />
                  Установить карту на смартфон
                </a>
              )}
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

function AdminAppLogo({ className = "" }: { className?: string }) {
  return (
    <img
      className={`admin-app-logo ${className}`}
      src="/faj-qr-icon-512.png"
      alt="Логотип Faj QR"
    />
  );
}

function AdminPage() {
  const [token, setToken] = useState(() => localStorage.getItem("adminToken") || "");
  const [username, setUsername] = useState(() => localStorage.getItem("adminUsername") || "admin");
  const [password, setPassword] = useState("");
  const [data, setData] = useState<AdminData | null>(null);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const dirtyAdminResourcesRef = useRef(new Set<AdminEditableResource>());
  const latestAdminOverviewRequestRef = useRef(0);
  const contentRef = useRef<HTMLElement | null>(null);
  const tabHistoryRef = useRef<string[]>(["dashboard"]);
  const swipeStartRef = useRef<SwipeStart | null>(null);
  const swipeActiveRef = useRef(false);
  const swipeActionRef = useRef<AdminSwipeAction>("none");
  const lastSessionRefreshAtRef = useRef(0);

  const selectAdminTab = useCallback((tabId: string, remember = true) => {
    setActiveTab((current) => {
      if (current === tabId) return current;
      if (remember) tabHistoryRef.current.push(tabId);
      return tabId;
    });
    setSaved("");
    setSidebarOpen(false);
  }, []);

  const returnToPreviousTab = useCallback(() => {
    if (tabHistoryRef.current.length <= 1) return;
    tabHistoryRef.current.pop();
    const previous = tabHistoryRef.current.at(-1) || "dashboard";
    selectAdminTab(previous, false);
  }, [selectAdminTab]);

  const authHeaders = useMemo(() => ({ authorization: `Bearer ${token}` }), [token]);

  const clearAdminSession = useCallback(() => {
    latestAdminOverviewRequestRef.current += 1;
    dirtyAdminResourcesRef.current.clear();
    localStorage.removeItem("adminToken");
    setData(null);
    setToken("");
  }, []);

  const loadAdmin = useCallback(async () => {
    if (!token) return;
    const requestId = ++latestAdminOverviewRequestRef.current;
    try {
      const overview = await api<AdminData>("/api/admin/overview", {
        headers: authHeaders
      });
      if (!isLatestAdminOverviewRequest(requestId, latestAdminOverviewRequestRef.current)) return;
      setData((current) => mergeAdminOverviewWithDrafts(overview, current, dirtyAdminResourcesRef.current));
      setError("");
    } catch (requestError) {
      if (!isLatestAdminOverviewRequest(requestId, latestAdminOverviewRequestRef.current)) return;
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        clearAdminSession();
        setError("Сессия истекла. Войдите ещё раз.");
        return;
      }
      setError("Не удалось обновить данные. Сессия сохранена — проверьте подключение к интернету.");
    }
  }, [authHeaders, clearAdminSession, token]);

  const updateAdminDraftResource = useCallback(<K extends AdminEditableResource,>(
    resource: K,
    value: AdminData[K]
  ) => {
    dirtyAdminResourcesRef.current.add(resource);
    setData((current) => current ? { ...current, [resource]: value } : current);
  }, []);

  useEffect(() => {
    void loadAdmin();
  }, [loadAdmin]);

  useEffect(() => {
    if (!token) return;
    const recoverAdmin = () => {
      if (navigator.onLine) void loadAdmin();
    };
    const recoverVisibleAdmin = () => {
      if (document.visibilityState === "visible") recoverAdmin();
    };
    window.addEventListener("online", recoverAdmin);
    window.addEventListener("pageshow", recoverAdmin);
    document.addEventListener("visibilitychange", recoverVisibleAdmin);
    return () => {
      window.removeEventListener("online", recoverAdmin);
      window.removeEventListener("pageshow", recoverAdmin);
      document.removeEventListener("visibilitychange", recoverVisibleAdmin);
    };
  }, [loadAdmin, token]);

  useEffect(() => {
    const warnAboutUnsavedChanges = (event: BeforeUnloadEvent) => {
      if (dirtyAdminResourcesRef.current.size === 0) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnAboutUnsavedChanges);
    return () => window.removeEventListener("beforeunload", warnAboutUnsavedChanges);
  }, []);

  useEffect(() => {
    if (!token) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadAdmin();
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [loadAdmin, token]);

  useEffect(() => {
    if (!token) return;
    const refreshSession = async () => {
      if (!adminSessionNeedsRefresh(token)) return;
      if (Date.now() - lastSessionRefreshAtRef.current < ADMIN_SESSION_REFRESH_COOLDOWN_MS) return;
      try {
        const result = await api<{ token: string; username: string }>("/api/admin/session/refresh", {
          method: "POST",
          headers: authHeaders
        });
        localStorage.setItem("adminToken", result.token);
        localStorage.setItem("adminUsername", result.username);
        lastSessionRefreshAtRef.current = Date.now();
        setToken(result.token);
      } catch (requestError) {
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          clearAdminSession();
          setError("Сессия истекла. Войдите ещё раз.");
        }
      }
    };
    void refreshSession();
    const interval = window.setInterval(() => void refreshSession(), 60 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [authHeaders, clearAdminSession, token]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [sidebarOpen]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1041px)");
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setSidebarOpen(false);
    };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  useEffect(() => {
    const panel = contentRef.current;
    if (!panel) return;
    const onPointerDown = (event: PointerEvent) => {
      const action = adminSwipeAction(activeTab, tabHistoryRef.current.length);
      if (window.innerWidth > 1040 || sidebarOpen || action === "none" || !swipeAllowedTarget(event.target)) return;
      if (event.clientX > Math.min(44, window.innerWidth * 0.12)) return;
      swipeStartRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
      swipeActiveRef.current = false;
      swipeActionRef.current = action;
      panel.classList.remove("admin-content--snap");
    };
    const onPointerMove = (event: PointerEvent) => {
      const start = swipeStartRef.current;
      if (!start || event.pointerId !== start.pointerId) return;
      const progress = swipeProgress(start, event.clientX, event.clientY);
      if (!swipeActiveRef.current && !progress.horizontal) return;
      swipeActiveRef.current = true;
      event.preventDefault();
      const maximumOffset = swipeActionRef.current === "sidebar" ? 96 : window.innerWidth;
      panel.style.setProperty("--admin-swipe-x", `${Math.min(progress.dx, maximumOffset)}px`);
    };
    const finish = (event: PointerEvent) => {
      const start = swipeStartRef.current;
      if (!start || event.pointerId !== start.pointerId) return;
      const progress = swipeProgress(start, event.clientX, event.clientY);
      swipeStartRef.current = null;
      const action = swipeActionRef.current;
      swipeActionRef.current = "none";
      if (!swipeActiveRef.current) return;
      swipeActiveRef.current = false;
      panel.classList.add("admin-content--snap");
      if (progress.complete && action === "sidebar") {
        panel.style.setProperty("--admin-swipe-x", "0px");
        setSidebarOpen(true);
        window.setTimeout(() => panel.classList.remove("admin-content--snap"), 270);
      } else if (progress.complete && action === "previous") {
        panel.style.setProperty("--admin-swipe-x", `${window.innerWidth}px`);
        window.setTimeout(() => {
          returnToPreviousTab();
          panel.classList.remove("admin-content--snap");
          panel.style.setProperty("--admin-swipe-x", "0px");
        }, 220);
      } else {
        panel.style.setProperty("--admin-swipe-x", "0px");
      }
    };
    const cancel = () => {
      swipeStartRef.current = null;
      swipeActiveRef.current = false;
      swipeActionRef.current = "none";
      panel.classList.add("admin-content--snap");
      panel.style.setProperty("--admin-swipe-x", "0px");
    };
    panel.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    return () => {
      panel.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [activeTab, returnToPreviousTab, sidebarOpen]);

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

  const saveResource = async <K extends AdminEditableResource,>(
    resource: string,
    body: AdminData[K],
    message: string,
    draftResource: K
  ) => {
    setSaved("");
    setError("");
    try {
      const savedResource = await api<AdminData[K]>(`/api/admin/${resource}`, {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify(body)
      });
      latestAdminOverviewRequestRef.current += 1;
      dirtyAdminResourcesRef.current.delete(draftResource);
      setData((current) => current ? { ...current, [draftResource]: savedResource } : current);
      setSaved(message);
      setTimeout(() => setSaved(""), 3000);
      await loadAdmin();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось сохранить");
    }
  };

  const saveChecklistConfiguration = async () => {
    if (!data) return;
    setSaved("");
    setError("");
    try {
      const savedConfiguration = await api<{ items: ChecklistItem[]; windows: ChecklistWindows }>("/api/admin/checklist", {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({ items: data.checklistItems, windows: data.checklistWindows })
      });
      latestAdminOverviewRequestRef.current += 1;
      dirtyAdminResourcesRef.current.delete("checklistItems");
      dirtyAdminResourcesRef.current.delete("checklistWindows");
      setData((current) => current ? {
        ...current,
        checklistItems: savedConfiguration.items,
        checklistWindows: savedConfiguration.windows
      } : current);
      setSaved("Шаблоны и время чек-листов сохранены");
      setTimeout(() => setSaved(""), 3000);
      await loadAdmin();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось сохранить чек-листы");
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
      latestAdminOverviewRequestRef.current += 1;
      setData((current) => {
        if (!current) return current;
        if (!dirtyAdminResourcesRef.current.has("settings")) return { ...current, settings };
        return {
          ...current,
          settings: { ...settings, ...current.settings, logoUrl: settings.logoUrl }
        };
      });
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

  const deleteStaffMember = async (waiter: Waiter) => {
    setSaved("");
    setError("");
    try {
      await api(`/api/admin/waiters/${encodeURIComponent(waiter.id)}`, {
        method: "DELETE",
        headers: authHeaders
      });
      latestAdminOverviewRequestRef.current += 1;
      setData((current) => current ? {
        ...current,
        waiters: current.waiters.filter((item) => item.id !== waiter.id)
      } : current);
      setSaved(`Сотрудник «${waiter.name}» удалён`);
      setTimeout(() => setSaved(""), 3000);
      await loadAdmin();
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось удалить сотрудника");
      return false;
    }
  };

  const acknowledgeCall = async (callId: string) => {
    await api(`/api/admin/calls/${callId}/acknowledge`, {
      method: "POST",
      headers: authHeaders
    });
    await loadAdmin();
  };

  const syncOffers = async () => {
    setError("");
    try {
      const offers = await api<Offer[]>("/api/admin/offers/sync", { method: "POST", headers: authHeaders });
      latestAdminOverviewRequestRef.current += 1;
      dirtyAdminResourcesRef.current.delete("offers");
      setData((current) => current ? { ...current, offers } : current);
      setSaved("Акции обновлены из CRM");
      window.setTimeout(() => setSaved(""), 3000);
      await loadAdmin();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось обновить акции из CRM");
    }
  };

  if (!token) {
    return (
      <main className="admin-login">
        <form onSubmit={login}>
          <AdminAppLogo className="admin-app-logo--login" />
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
    { id: "shifts", label: "Смены и рейтинг", icon: <Trophy size={18} /> },
    { id: "shift-journal", label: "Журнал смен", icon: <CalendarDays size={18} /> },
    { id: "employee-control", label: "Контроль сотрудников", icon: <Eye size={18} /> },
    { id: "ai-analytics", label: "ИИ-аналитика", icon: <Sparkles size={18} /> },
    { id: "checklist", label: "Чек-листы", icon: <ClipboardCheck size={18} /> },
    ...(data.accessRole === "owner"
      ? [
          { id: "owner-profile", label: "Профиль владельца", icon: <KeyRound size={18} /> }
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
      <EscalationAlerts
        data={data}
        acknowledgeCall={(callId) => void acknowledgeCall(callId)}
        updateCall={(callId, status) => void updateCall(callId, status)}
      />
      <button
        className={`admin-sidebar-backdrop ${sidebarOpen ? "is-visible" : ""}`}
        type="button"
        aria-label="Закрыть меню"
        aria-hidden={!sidebarOpen}
        tabIndex={sidebarOpen ? 0 : -1}
        onClick={() => setSidebarOpen(false)}
      />
      <aside
        id="admin-navigation"
        className={`admin-sidebar ${sidebarOpen ? "admin-sidebar--open" : ""}`}
        aria-label="Разделы панели управления"
      >
        <div className="admin-sidebar-head">
          <div className="brand-lockup">
            <AdminAppLogo className="admin-app-logo--sidebar" />
            <div>
              <strong>{data.settings.name}</strong>
              <span>{[
                data.telegramEnabled ? "Telegram" : "",
                data.maxEnabled ? "MAX" : ""
              ].filter(Boolean).join(" + ") || "Мессенджеры не настроены"} · {data.username}</span>
            </div>
          </div>
          <button
            className="sidebar-close-button"
            type="button"
            aria-label="Закрыть меню"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={22} />
          </button>
        </div>

        <nav>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={activeTab === tab.id ? "active" : ""}
              onClick={() => {
                selectAdminTab(tab.id);
              }}
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
            setSidebarOpen(false);
            setToken("");
          }}
        >
          <LogOut size={18} />
          Выйти
        </button>
      </aside>

      <section className="admin-content" ref={contentRef}>
        <div className="admin-mobile-bar">
          <button
            className="mobile-menu-button"
            type="button"
            aria-controls="admin-navigation"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={21} />
            <span>Меню</span>
          </button>
          <strong>{tabs.find((tab) => tab.id === activeTab)?.label}</strong>
        </div>
        <header className="admin-header">
          <div>
            <p>Панель управления</p>
            <h1>{tabs.find((tab) => tab.id === activeTab)?.label}</h1>
          </div>
          <button className="icon-button admin-refresh-button" onClick={() => void loadAdmin()} aria-label="Обновить данные" title="Обновить данные">
            <RefreshCw size={18} />
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
            onChange={(settings) => updateAdminDraftResource("settings", settings)}
            onUploadLogo={uploadLogo}
            onSave={() => void saveResource("settings", data.settings, "Настройки заведения сохранены", "settings")}
          />
        )}

        {activeTab === "tables" && (
          <TablesEditor
            data={data}
            publicUrl={publicUrl}
            onChange={(tables) => updateAdminDraftResource("tables", tables)}
            onSave={() => void saveResource("tables", data.tables, "Столы сохранены", "tables")}
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
            onWaitersChange={(waiters) => updateAdminDraftResource("waiters", waiters)}
            onRolesChange={(staffRoles) => updateAdminDraftResource("staffRoles", staffRoles)}
            onSaveWaiters={() => void saveResource("waiters", data.waiters, "Сотрудники сохранены", "waiters")}
            onSaveRoles={() => void saveResource("staff-roles", data.staffRoles, "Должности сохранены", "staffRoles")}
            onDeleteWaiter={deleteStaffMember}
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
            mode="ratings"
          />
        )}

        {activeTab === "shift-journal" && (
          <ShiftsAndRatings
            ratings={data.ratings}
            shifts={data.shifts}
            performance={data.performance}
            performanceAiEnabled={data.performanceAiEnabled}
            authHeaders={authHeaders}
            onRefresh={loadAdmin}
            title="Смены сотрудников"
            mode="journal"
          />
        )}

        {activeTab === "employee-control" && (
          <EmployeeControl
            waiters={data.waiters}
            roles={data.staffRoles}
            tables={data.tables}
            shifts={data.shifts}
            ratings={data.ratings}
            accessRole={data.accessRole}
            venueTimeZone={data.venueTimeZone}
            authHeaders={authHeaders}
            onRefresh={loadAdmin}
          />
        )}

        {activeTab === "ai-analytics" && (
          <ShiftsAndRatings
            ratings={data.ratings}
            shifts={data.shifts}
            performance={data.performance}
            performanceAiEnabled={data.performanceAiEnabled}
            authHeaders={authHeaders}
            onRefresh={loadAdmin}
            title="Общая аналитика"
            mode="ai"
          />
        )}

        {activeTab === "checklist" && (
          <ChecklistEditor
            items={data.checklistItems}
            windows={data.checklistWindows}
            shiftTasks={data.shiftTasks}
            roles={data.staffRoles}
            waiters={data.waiters}
            authHeaders={authHeaders}
            onChange={(checklistItems) => updateAdminDraftResource("checklistItems", checklistItems)}
            onWindowsChange={(checklistWindows) => updateAdminDraftResource("checklistWindows", checklistWindows)}
            onSave={() => void saveChecklistConfiguration()}
            onRefresh={loadAdmin}
          />
        )}

        {activeTab === "owner-profile" && data.accessRole === "owner" && data.adminAccount && (
          <OwnerProfile
            ownerUsername={data.username}
            adminAccount={data.adminAccount}
            ownerNotifications={data.ownerNotifications}
            ownerWebPush={data.ownerWebPush}
            telegramAvailable={data.telegramEnabled}
            maxAvailable={data.maxEnabled}
            authHeaders={authHeaders}
            onRefresh={loadAdmin}
          />
        )}

        {activeTab === "actions" && (
          <ActionsEditor
            actions={data.actions}
            onChange={(actions) => updateAdminDraftResource("actions", actions)}
            onSave={() => void saveResource("actions", data.actions, "Кнопки вызова сохранены", "actions")}
          />
        )}

        {activeTab === "offers" && (
          <OffersEditor
            offers={data.offers}
            onChange={(offers) => updateAdminDraftResource("offers", offers)}
            onSave={() => void saveResource("offers", data.offers, "Акции сохранены", "offers")}
            onSync={() => void syncOffers()}
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
  ownerNotifications,
  ownerWebPush,
  telegramAvailable,
  maxAvailable,
  authHeaders,
  onRefresh
}: {
  ownerUsername: string;
  adminAccount: AdminAccountSummary;
  ownerNotifications: OwnerNotificationSettings;
  ownerWebPush: OwnerWebPushStatus;
  telegramAvailable: boolean;
  maxAvailable: boolean;
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
  const [notificationSettings, setNotificationSettings] = useState(ownerNotifications);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState("");
  const [notificationError, setNotificationError] = useState("");
  const [pushStatus, setPushStatus] = useState(ownerWebPush);
  const [pushPermission, setPushPermission] = useState<NotificationPermission>(
    typeof Notification === "undefined" ? "default" : Notification.permission
  );
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState("");
  const [pushError, setPushError] = useState("");

  const pushSupported = typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  const standalone = typeof window !== "undefined" && isStandaloneWebApp();

  useEffect(() => {
    setPushStatus(ownerWebPush);
  }, [ownerWebPush]);

  useEffect(() => {
    if (!pushSupported) return;
    let cancelled = false;
    void navigator.serviceWorker.register("/admin-sw.js", { scope: "/" }).then(async (registration) => {
      const subscription = await registration.pushManager.getSubscription();
      if (!cancelled) {
        setPushSubscribed(Boolean(subscription));
        setPushPermission(Notification.permission);
      }
    }).catch(() => {
      if (!cancelled) setPushError("Не удалось подготовить системные уведомления");
    });
    return () => { cancelled = true; };
  }, [pushSupported]);

  const enableWebPush = async () => {
    setPushMessage("");
    setPushError("");
    if (!pushSupported) {
      setPushError("Этот браузер не поддерживает системные Web Push-уведомления");
      return;
    }
    if (!pushStatus.enabled || !pushStatus.publicKey) {
      setPushError("Web Push ещё не настроен на сервере");
      return;
    }
    if (/iPad|iPhone|iPod/.test(navigator.userAgent) && !standalone) {
      setPushError("На iPhone сначала добавьте Faj QR на экран «Домой» и откройте приложение с иконки");
      return;
    }

    setPushBusy(true);
    try {
      const permission = await Notification.requestPermission();
      setPushPermission(permission);
      if (permission !== "granted") {
        throw new Error("Разрешите уведомления Faj QR в настройках iPhone");
      }
      const registration = await navigator.serviceWorker.register("/admin-sw.js", { scope: "/" });
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: webPushApplicationKey(pushStatus.publicKey)
      });
      const updated = await api<OwnerWebPushStatus>("/api/admin/web-push/subscriptions", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(subscription.toJSON())
      });
      setPushStatus(updated);
      setPushSubscribed(true);
      setPushMessage("Системные уведомления включены на этом устройстве");
      await onRefresh();
    } catch (error) {
      setPushError(error instanceof Error ? error.message : "Не удалось включить системные уведомления");
    } finally {
      setPushBusy(false);
    }
  };

  const disableWebPush = async () => {
    setPushMessage("");
    setPushError("");
    if (!pushSupported) return;
    setPushBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await api<OwnerWebPushStatus>("/api/admin/web-push/subscriptions", {
          method: "DELETE",
          headers: authHeaders,
          body: JSON.stringify({ endpoint: subscription.endpoint })
        });
        await subscription.unsubscribe();
      }
      setPushSubscribed(false);
      setPushMessage("Системные уведомления выключены на этом устройстве");
      await onRefresh();
    } catch (error) {
      setPushError(error instanceof Error ? error.message : "Не удалось выключить системные уведомления");
    } finally {
      setPushBusy(false);
    }
  };

  const testWebPush = async () => {
    setPushMessage("");
    setPushError("");
    setPushBusy(true);
    try {
      await api("/api/admin/web-push/test", { method: "POST", headers: authHeaders });
      setPushMessage("Тест отправлен. Проверьте экран блокировки и Центр уведомлений");
    } catch (error) {
      setPushError(error instanceof Error ? error.message : "Тестовое уведомление не отправлено");
    } finally {
      setPushBusy(false);
    }
  };

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

  const submitNotifications = async (event: FormEvent) => {
    event.preventDefault();
    setNotificationMessage("");
    setNotificationError("");
    const telegramChatId = notificationSettings.telegramChatId.trim();
    const maxUserId = notificationSettings.maxUserId.trim();
    if (telegramChatId && !/^-?\d+$/.test(telegramChatId)) {
      setNotificationError("Telegram ID должен состоять из цифр");
      return;
    }
    if (maxUserId && !/^\d+$/.test(maxUserId)) {
      setNotificationError("MAX user_id должен состоять из цифр");
      return;
    }
    if (notificationSettings.telegramEnabled && !telegramChatId) {
      setNotificationError("Укажите Telegram ID или выключите канал Telegram");
      return;
    }
    if (notificationSettings.maxEnabled && !maxUserId) {
      setNotificationError("Укажите MAX user_id или выключите канал MAX");
      return;
    }

    setNotificationBusy(true);
    try {
      const updated = await api<OwnerNotificationSettings>("/api/admin/owner-notifications", {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({
          telegramChatId,
          maxUserId,
          sberCardNumber: notificationSettings.sberCardNumber,
          telegramEnabled: notificationSettings.telegramEnabled,
          maxEnabled: notificationSettings.maxEnabled
        })
      });
      setNotificationSettings(updated);
      setNotificationMessage("Каналы входящих уведомлений сохранены");
      await onRefresh();
    } catch (requestError) {
      setNotificationError(
        requestError instanceof Error ? requestError.message : "Не удалось сохранить каналы"
      );
    } finally {
      setNotificationBusy(false);
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

      <form className="owner-notification-settings" onSubmit={submitNotifications}>
        <div className="owner-notification-heading">
          <div>
            <h3>Входящие уведомления владельца</h3>
            <p>
              Срочные вызовы всегда сохраняются в CRM. Здесь можно дополнительно получать их
              мгновенно в Telegram и MAX, даже когда CRM закрыта.
            </p>
          </div>
          <BellRing size={22} />
        </div>

        <div className="owner-channel-grid">
          <article className={`owner-channel-card${notificationSettings.telegramEnabled ? " is-enabled" : ""}`}>
            <div className="owner-channel-title">
              <div>
                <strong>Telegram</strong>
                <span className={telegramAvailable ? "channel-ready" : "channel-unavailable"}>
                  {telegramAvailable ? "Бот подключён" : "Бот сейчас недоступен"}
                </span>
              </div>
              <button
                className={`channel-toggle${notificationSettings.telegramEnabled ? " is-enabled" : ""}`}
                type="button"
                aria-pressed={notificationSettings.telegramEnabled}
                onClick={() => {
                  setNotificationSettings({
                    ...notificationSettings,
                    telegramEnabled: !notificationSettings.telegramEnabled
                  });
                  setNotificationMessage("");
                  setNotificationError("");
                }}
              >
                {notificationSettings.telegramEnabled ? "Включён" : "Выключен"}
              </button>
            </div>
            <label className="field">
              <span>Telegram ID владельца</span>
              <input
                inputMode="numeric"
                value={notificationSettings.telegramChatId}
                onChange={(event) => {
                  setNotificationSettings({
                    ...notificationSettings,
                    telegramChatId: event.target.value
                  });
                  setNotificationMessage("");
                  setNotificationError("");
                }}
                placeholder="Например: 123456789"
                maxLength={32}
              />
            </label>
          </article>

          <article className={`owner-channel-card${notificationSettings.maxEnabled ? " is-enabled" : ""}`}>
            <div className="owner-channel-title">
              <div>
                <strong>MAX</strong>
                <span className={maxAvailable ? "channel-ready" : "channel-unavailable"}>
                  {maxAvailable ? "Бот подключён" : "Бот сейчас недоступен"}
                </span>
              </div>
              <button
                className={`channel-toggle${notificationSettings.maxEnabled ? " is-enabled" : ""}`}
                type="button"
                aria-pressed={notificationSettings.maxEnabled}
                onClick={() => {
                  setNotificationSettings({
                    ...notificationSettings,
                    maxEnabled: !notificationSettings.maxEnabled
                  });
                  setNotificationMessage("");
                  setNotificationError("");
                }}
              >
                {notificationSettings.maxEnabled ? "Включён" : "Выключен"}
              </button>
            </div>
            <label className="field">
              <span>MAX user_id владельца</span>
              <input
                inputMode="numeric"
                value={notificationSettings.maxUserId}
                onChange={(event) => {
                  setNotificationSettings({
                    ...notificationSettings,
                    maxUserId: event.target.value
                  });
                  setNotificationMessage("");
                  setNotificationError("");
                }}
                placeholder="Например: 123456789"
                maxLength={32}
              />
            </label>
          </article>
        </div>

        <label className="field owner-sber-card-field">
          <span>Карта СберБанка владельца для перевода штрафов</span>
          <input
            inputMode="numeric"
            value={notificationSettings.sberCardNumber}
            onChange={(event) => {
              setNotificationSettings({
                ...notificationSettings,
                sberCardNumber: event.target.value
              });
              setNotificationMessage("");
              setNotificationError("");
            }}
            placeholder="Например: 2202 0000 0000 0000"
            maxLength={32}
          />
          <small>Номер будет показан администратору только при начисленном штрафе.</small>
        </label>

        <div className="owner-crm-channel">
          <CheckCircle2 size={18} />
          <span><strong>CRM включена всегда.</strong> Эскалация останется в профиле до подтверждения.</span>
        </div>

        {notificationMessage && <div className="success-line owner-account-status">{notificationMessage}</div>}
        {notificationError && <div className="error-line owner-account-status">{notificationError}</div>}

        <div className="button-row owner-account-actions">
          <button className="primary-button" type="submit" disabled={notificationBusy}>
            <Save size={18} />
            {notificationBusy ? "Сохраняем" : "Сохранить каналы"}
          </button>
        </div>
      </form>

      <div className="owner-notification-settings owner-web-push-settings">
        <div className="owner-notification-heading">
          <div>
            <h3>Системные уведомления iPhone</h3>
            <p>
              Приходят на экран блокировки, даже когда Faj QR закрыт. Уведомляем о срочных вызовах гостя и о чек-листе,
              который не завершён за {pushStatus.checklistOverdueMinutes} минут после начала смены.
            </p>
          </div>
          <BellRing size={22} />
        </div>

        <div className="owner-push-status-grid">
          <div className={pushStatus.enabled ? "is-ready" : "is-missing"}>
            <strong>Сервер</strong>
            <span>{pushStatus.enabled ? "Готов" : "Не настроен"}</span>
          </div>
          <div className={standalone ? "is-ready" : "is-missing"}>
            <strong>Приложение</strong>
            <span>{standalone ? "Открыто с экрана Домой" : "Откройте установленное приложение"}</span>
          </div>
          <div className={pushPermission === "granted" ? "is-ready" : "is-missing"}>
            <strong>Разрешение iPhone</strong>
            <span>{pushPermission === "granted" ? "Разрешено" : pushPermission === "denied" ? "Запрещено" : "Не запрошено"}</span>
          </div>
          <div className={pushSubscribed ? "is-ready" : "is-missing"}>
            <strong>Это устройство</strong>
            <span>{pushSubscribed ? "Подключено" : "Не подключено"}</span>
          </div>
        </div>

        {!standalone && (
          <p className="owner-push-instruction">
            На iPhone: откройте сайт в Safari → «Поделиться» → «На экран Домой», затем запустите Faj QR с новой иконки.
          </p>
        )}
        {pushMessage && <div className="success-line owner-account-status">{pushMessage}</div>}
        {pushError && <div className="error-line owner-account-status">{pushError}</div>}
        <div className="button-row owner-account-actions owner-push-actions">
          {pushSubscribed ? (
            <button className="ghost-button" type="button" disabled={pushBusy} onClick={() => void disableWebPush()}>
              Выключить на этом устройстве
            </button>
          ) : (
            <button className="primary-button" type="button" disabled={pushBusy || !pushStatus.enabled} onClick={() => void enableWebPush()}>
              <BellRing size={18} />
              {pushBusy ? "Подключаем" : "Включить на этом iPhone"}
            </button>
          )}
          <button className="secondary-button" type="button" disabled={pushBusy || !pushSubscribed} onClick={() => void testWebPush()}>
            Отправить тест
          </button>
        </div>
        <small>Подключено устройств владельца: {pushStatus.subscriptionCount}</small>
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
  const localDateKey = (value: Date) => new Intl.DateTimeFormat("en-CA", {
    timeZone: data.venueTimeZone || "Europe/Astrakhan"
  }).format(value);
  const today = localDateKey(new Date());
  const monthAgoDate = new Date();
  monthAgoDate.setDate(monthAgoDate.getDate() - 29);
  const [dateFrom, setDateFrom] = useState(localDateKey(monthAgoDate));
  const [dateTo, setDateTo] = useState(today);
  const analyticsStartedAt = new Date(data.analyticsStartedAt || 0);
  const analyticsStartedAtMs = analyticsStartedAt.getTime();
  const inPeriod = (value: string) => {
    const date = new Date(value);
    const timestamp = date.getTime();
    if (!Number.isFinite(timestamp)) return false;
    if (Number.isFinite(analyticsStartedAtMs) && timestamp < analyticsStartedAtMs) return false;
    const key = localDateKey(date);
    return (!dateFrom || key >= dateFrom) && (!dateTo || key <= dateTo);
  };
  const calls = data.calls.filter((call) => inPeriod(call.createdAt));
  const totalCalls = calls.reduce((sum, call) => sum + call.pressCount, 0);
  const missedCalls = calls.reduce(
    (sum, call) => sum + call.missedByStaff.filter((event) => inPeriod(event.at)).length,
    0
  );
  const repeatedCalls = calls.reduce(
    (sum, call) => sum + call.reasonCounts.reduce((reasonSum, reason) => reasonSum + Math.max(0, reason.count - 1), 0),
    0
  );
  const completedCalls = calls.filter((call) => call.status === "done").length;
  const responseTimes = calls
    .filter((call) => call.acceptedAt)
    .map((call) => Math.max(0, new Date(call.acceptedAt!).getTime() - new Date(call.cycleStartedAt).getTime()));
  const averageResponseSeconds = responseTimes.length
    ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length / 1000)
    : 0;
  const loyaltyRegistrations = data.loyaltyLeads.filter((lead) => inPeriod(lead.createdAt)).length;
  const feedbacks = data.feedbacks.filter((feedback) => inPeriod(feedback.createdAt));
  const averageFeedback = feedbacks.length
    ? Math.round((feedbacks.reduce((sum, feedback) => sum + feedback.rating, 0) / feedbacks.length) * 10) / 10
    : 0;
  const tableName = (id: string) => data.tables.find((table) => table.id === id)?.name || "Стол";

  return (
    <div className="dashboard-layout">
      <section className="admin-panel dashboard-period-filter">
        <div>
          <strong>Период отчёта</strong>
          <span>
            Все показатели ниже рассчитаны только за выбранные даты
            {Number.isFinite(analyticsStartedAtMs) && analyticsStartedAtMs > 0
              ? ` и учитывают новую статистику с ${analyticsStartedAt.toLocaleDateString("ru-RU")}.`
              : "."}
          </span>
        </div>
        <label className="field"><span>С</span><input type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => setDateFrom(event.target.value)} /></label>
        <label className="field"><span>По</span><input type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => setDateTo(event.target.value)} /></label>
      </section>

      <div className="admin-grid dashboard-metrics">
        <Metric title="Всего нажатий вызова" value={totalCalls} icon={<BellRing size={22} />} />
        <Metric title="Пропущенные вызовы" value={missedCalls} icon={<AlertTriangle size={22} />} />
        <Metric title="Повторные вызовы" value={repeatedCalls} icon={<RefreshCw size={22} />} />
        <Metric title="Завершено обращений" value={completedCalls} icon={<CheckCircle2 size={22} />} />
        <Metric title="Среднее время ответа" value={`${averageResponseSeconds} сек.`} icon={<Clock size={22} />} />
        <Metric title="Регистрации лояльности" value={loyaltyRegistrations} icon={<Gift size={22} />} />
        <Metric title="Отзывы" value={feedbacks.length} icon={<MessageSquare size={22} />} />
        <Metric title="Средняя оценка гостей" value={feedbacks.length ? `${averageFeedback} ★` : "—"} icon={<Star size={22} />} />
      </div>

      <section className="admin-panel">
        <div className="panel-heading">
          <div><h2>Вызовы за период</h2><p className="muted">Показаны последние 30 обращений внутри выбранного периода.</p></div>
          <MessageSquare size={20} />
        </div>
        <div className="call-list">
          {calls.slice(0, 30).map((call) => (
            <article className={`call-row status-${call.status}`} key={call.id}>
              <div>
                <strong>{tableName(call.tableId)} - {call.actionLabel}</strong>
                <span>{formatDate(call.createdAt)}{call.comment ? ` - ${call.comment}` : ""}</span>
              </div>
              <StatusButtons call={call} updateCall={updateCall} />
            </article>
          ))}
          {!calls.length && <p className="muted">За выбранный период вызовов нет.</p>}
        </div>
      </section>
    </div>
  );
}

function EscalationAlerts({
  data,
  acknowledgeCall,
  updateCall
}: {
  data: AdminData;
  acknowledgeCall: (callId: string) => void;
  updateCall: (callId: string, status: CallStatus) => void;
}) {
  const alerts = data.calls.filter((call) => {
    if (call.status === "done" || call.status === "cancelled") return false;
    return data.accessRole === "owner"
      ? call.routingStage === "owner" && !call.ownerAcknowledgedAt
      : call.routingStage === "admin" && !call.adminAcknowledgedAt;
  });
  if (!alerts.length) return null;

  const tableLabel = (call: ServiceCall) => {
    const table = data.tables.find((item) => item.id === call.tableId);
    return table ? `${table.name}${table.zone ? ` · ${table.zone}` : ""}` : "Стол";
  };

  return (
    <aside className="escalation-toast-stack" role="alert" aria-live="assertive">
      {alerts.slice(0, 3).map((call) => (
        <article className="escalation-toast" key={call.id}>
          <div className="escalation-toast__heading">
            <AlertTriangle size={24} />
            <div>
              <strong>
                {data.accessRole === "owner" ? "Требуется контроль владельца" : "Требуется контроль администратора"}
              </strong>
              <span>{tableLabel(call)} · {call.actionLabel}</span>
            </div>
          </div>
          <p>{call.routingReason || "Сотрудник не подтвердил вызов вовремя."}</p>
          <small>Последний запрос: {formatDate(call.lastRequestedAt)}</small>
          <div className="escalation-toast__actions">
            {call.status === "new" ? (
              <button className="primary-button" onClick={() => updateCall(call.id, "accepted")}>
                <Check size={16} />
                Принять
              </button>
            ) : (
              <button className="primary-button" onClick={() => acknowledgeCall(call.id)}>
                <ShieldCheck size={16} />
                Подтвердить контроль
              </button>
            )}
            <button className="ghost-button" onClick={() => updateCall(call.id, "done")}>
              <CheckCircle2 size={16} />
              Готово
            </button>
          </div>
        </article>
      ))}
      {alerts.length > 3 && <div className="escalation-toast__more">Еще срочных вызовов: {alerts.length - 3}</div>}
    </aside>
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
        <h2>Официанты и мессенджеры</h2>
        <div className="button-row">
          <button className="ghost-button" onClick={() => onChange([...waiters, { id: "", name: "Официант", roleId: "waiter", telegramChatId: "", maxUserId: "", tipUrl: "", active: true }])}>
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
            <Field label="MAX user_id" value={waiter.maxUserId} onChange={(value) => update(index, { maxUserId: value })} />
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
  onSaveRoles,
  onDeleteWaiter
}: {
  waiters: Waiter[];
  roles: StaffRoleDefinition[];
  accessRole: AdminAccessRole;
  onWaitersChange: (waiters: Waiter[]) => void;
  onRolesChange: (roles: StaffRoleDefinition[]) => void;
  onSaveWaiters: () => void;
  onSaveRoles: () => void;
  onDeleteWaiter: (waiter: Waiter) => Promise<boolean>;
}) {
  const [roleFilter, setRoleFilter] = useState("all");
  const [deletingWaiterId, setDeletingWaiterId] = useState("");
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
  const deleteWaiter = async (waiter: Waiter, index: number) => {
    if (!waiter.id) {
      onWaitersChange(waiters.filter((_, waiterIndex) => waiterIndex !== index));
      return;
    }
    if (!window.confirm(`Удалить сотрудника «${waiter.name}»? История завершённых смен сохранится.`)) return;
    setDeletingWaiterId(waiter.id);
    try {
      await onDeleteWaiter(waiter);
    } finally {
      setDeletingWaiterId("");
    }
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
          <details className="role-editor-disclosure">
            <summary>Список должностей ({roles.length})</summary>
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
          </details>
        </section>
      )}

      <section className="admin-panel">
        <div className="panel-heading">
          <div>
            <h2>Сотрудники</h2>
            <p className="muted checklist-intro">Добавьте сотрудника, выберите должность и укажите Telegram chat_id и/или MAX user_id, который покажет бот.</p>
          </div>
          <div className="button-row">
            <button
              className="ghost-button"
              onClick={() => onWaitersChange([...waiters, { id: "", name: "Новый сотрудник", roleId: "waiter", telegramChatId: "", maxUserId: "", tipUrl: "", active: true }])}
            >
              <Plus size={18} /> Сотрудник
            </button>
            <button className="primary-button compact" onClick={onSaveWaiters}>
              <Save size={18} /> Сохранить
            </button>
          </div>
        </div>

        <div className="staff-filter-toolbar">
          <label className="field">
            <span>Фильтр по должности</span>
            <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
              <option value="all">Все должности</option>
              {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
            </select>
          </label>
        </div>

        <div className="editor-list">
          {waiters.map((waiter, index) => ({ waiter, index })).filter(({ waiter }) => roleFilter === "all" || waiter.roleId === roleFilter).map(({ waiter, index }) => {
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
                <Field label="MAX user_id" value={waiter.maxUserId} onChange={(value) => updateWaiter(index, { maxUserId: value })} />
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
                  disabled={role?.kind === "owner" || deletingWaiterId === waiter.id}
                  title={role?.kind === "owner" ? "Владельца нельзя удалить из этого списка" : "Удалить сразу"}
                  onClick={() => void deleteWaiter(waiter, index)}
                >
                  <Trash2 size={18} />
                </button>
              </article>
            );
          })}
          {!waiters.some((waiter) => roleFilter === "all" || waiter.roleId === roleFilter) && <p className="muted">В этой должности сотрудников пока нет.</p>}
        </div>
      </section>
    </div>
  );
}

function ManagementTelegramEditor({
  waiters,
  roles,
  telegramBotUrl,
  maxBotUrl,
  onChange,
  onSave
}: {
  waiters: Waiter[];
  roles: StaffRoleDefinition[];
  telegramBotUrl: string;
  maxBotUrl: string;
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
          <h2>Администраторы в Telegram и MAX</h2>
          <p className="muted checklist-intro">Сотрудник запускает нужного бота и передаёт Telegram chat_id или MAX user_id. Один идентификатор можно назначить только одному сотруднику.</p>
        </div>
        <div className="button-row">
          {adminRole && (
            <button
              className="ghost-button"
              onClick={() => onChange([...waiters, { id: "", name: "Новый сотрудник", roleId: adminRole.id, telegramChatId: "", maxUserId: "", tipUrl: "", active: true }])}
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
          {maxBotUrl && (
            <a className="ghost-button telegram-bot-link" href={maxBotUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={17} /> Открыть MAX-бота
            </a>
          )}
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
            <Field label="MAX user_id" value={waiter.maxUserId} onChange={(value) => update(index, { maxUserId: value })} />
            <label className="toggle-row">
              <input type="checkbox" checked={waiter.active} onChange={(event) => update(index, { active: event.target.checked })} />
              Активен
            </label>
          </article>
        ))}
        {!management.length && <p className="muted">Добавьте сотрудника и зарегистрируйте его Telegram chat_id или MAX user_id.</p>}
      </div>
    </section>
  );
}

function ChecklistEditor({
  items,
  windows,
  shiftTasks,
  roles,
  waiters,
  authHeaders,
  onChange,
  onWindowsChange,
  onSave,
  onRefresh
}: {
  items: ChecklistItem[];
  windows: ChecklistWindows;
  shiftTasks: ShiftTask[];
  roles: StaffRoleDefinition[];
  waiters: Waiter[];
  authHeaders: Record<string, string>;
  onChange: (items: ChecklistItem[]) => void;
  onWindowsChange: (windows: ChecklistWindows) => void;
  onSave: () => void;
  onRefresh: () => Promise<void>;
}) {
  const availableRoles = roles.filter((role) => role.active || items.some((item) => item.roleId === role.id));
  const preferredRoleId = availableRoles.find((role) => role.kind === "waiter")?.id || availableRoles[0]?.id || "";
  const [roleId, setRoleId] = useState(preferredRoleId);
  const [section, setSection] = useState<"template" | "tasks">("template");
  const [templatePhase, setTemplatePhase] = useState<ChecklistPhase>("opening");
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
    .filter(({ item }) => item.roleId === roleId && (item.phase || "opening") === templatePhase)
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
          <p className="muted checklist-intro">Для каждого этапа задаётся своё время заполнения. Утренняя и вечерняя смены получают свой чек-лист открытия, а закрытие назначается каждой смене. Невыполненные задания по датам автоматически переносятся сотруднику на следующий день.</p>
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
          <div className="checklist-phase-tabs" role="tablist" aria-label="Этап смены">
            {CHECKLIST_PHASES.map((phase) => (
              <button key={phase} className={templatePhase === phase ? "active" : ""} onClick={() => setTemplatePhase(phase)}>
                {CHECKLIST_PHASE_META[phase].icon} {CHECKLIST_PHASE_META[phase].title}
              </button>
            ))}
          </div>
          <div className="checklist-window-editor">
            <div>
              <strong>Время заполнения: {CHECKLIST_PHASE_META[templatePhase].title}</strong>
              <span>Вне этого интервала сотрудник не сможет отметить пункт выполненным в Telegram или MAX.</span>
            </div>
            <label className="field">
              <span>С</span>
              <input
                type="time"
                value={windows[templatePhase].start}
                onChange={(event) => onWindowsChange({
                  ...windows,
                  [templatePhase]: { ...windows[templatePhase], start: event.target.value }
                })}
              />
            </label>
            <label className="field">
              <span>До</span>
              <input
                type="time"
                value={windows[templatePhase].end}
                onChange={(event) => onWindowsChange({
                  ...windows,
                  [templatePhase]: { ...windows[templatePhase], end: event.target.value }
                })}
              />
            </label>
            <span className="checklist-window-value">{formatChecklistWindow(windows[templatePhase])}</span>
          </div>
          <div className="section-toolbar">
            <p className="muted">{templatePhase === "closing"
              ? "Все пункты закрытия необходимо выполнить до ручного завершения смены. Автозакрытие выполняется в 02:00."
              : templatePhase === "evening"
                ? "Этот чек-лист назначается сотруднику, который открывает вечернюю смену. Обязательные пункты блокируют рабочие уведомления до выполнения."
                : "Этот чек-лист назначается сотруднику утренней смены. Обязательные пункты блокируют рабочие уведомления официанта до выполнения."}</p>
            <div className="button-row">
              <button
                className="ghost-button"
                onClick={() => onChange([...items, {
                  id: crypto.randomUUID(),
                  roleId,
                  phase: templatePhase,
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
                <Field label="Задача" value={item.title} onChange={(value) => updateItem(globalIndex, { title: value })} textarea autoGrow />
                <Field label="Пояснение" value={item.description} onChange={(value) => updateItem(globalIndex, { description: value })} textarea autoGrow />
                <div className="checklist-template-options">
                  {templatePhase !== "closing" && <label className="toggle-row">
                    <input type="checkbox" checked={item.requiredForCalls} onChange={(event) => updateItem(globalIndex, { requiredForCalls: event.target.checked })} />
                    Обязателен для допуска
                  </label>}
                  <label className="toggle-row">
                    <input type="checkbox" checked={item.countsForRating !== false} onChange={(event) => updateItem(globalIndex, { countsForRating: event.target.checked })} />
                    Учитывать в рейтинге
                  </label>
                  <label className="toggle-row">
                    <input type="checkbox" checked={item.active} onChange={(event) => updateItem(globalIndex, { active: event.target.checked })} />
                    Активен
                  </label>
                </div>
                <button className="icon-button" onClick={() => onChange(items.filter((_, index) => index !== globalIndex))} aria-label="Удалить пункт">
                  <Trash2 size={18} />
                </button>
              </article>
            ))}
            {!roleEntries.length && <p className="muted">Для этой должности раздел «{CHECKLIST_PHASE_META[templatePhase].title}» пока пуст.</p>}
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
            <Field label="Задание" value={taskTitle} onChange={setTaskTitle} placeholder="Например: проверить летнюю веранду" textarea autoGrow />
            <Field label="Пояснение" value={taskDescription} onChange={setTaskDescription} placeholder="Что именно нужно сделать" textarea autoGrow />
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
          <p className="muted checklist-intro">Персональное задание отправляется в Telegram и MAX в назначенную дату даже без открытой смены. Задание всей должности появляется у каждого сотрудника при начале смены. Если сотрудник не отметил задание выполненным, система создаст его персональную копию на новую дату.</p>
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
                    <span>{task.completedAt
                      ? `Выполнено ${formatDate(task.completedAt)}`
                      : task.waiterId
                        ? (task.notified ? "Уведомление отправлено" : "Ожидает даты отправки")
                        : "При начале смены"}</span>
                  </div>
                  <div className="task-badges">
                    {task.carriedFromTaskId && <span className="rollover-badge">Перенесено</span>}
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
    totalMissedCalls: roleSummaries.reduce((sum, item) => sum + item.missedCallCount, 0),
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

type EmployeeItemReviewDraft = {
  score: number;
  comment: string;
  photoUrl: string;
  photoFile: File | null;
};

function ReviewImagePreview({
  photoUrl,
  photoFile,
  authHeaders,
  alt
}: {
  photoUrl: string;
  photoFile: File | null;
  authHeaders: Record<string, string>;
  alt: string;
}) {
  const [source, setSource] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    setSource("");
    if (photoFile) {
      const objectUrl = URL.createObjectURL(photoFile);
      setSource(objectUrl);
      return () => URL.revokeObjectURL(objectUrl);
    }
    if (!photoUrl) {
      return;
    }
    if (!/^\/api\/admin\/review-media\/[A-Za-z0-9._-]+$/.test(photoUrl)) {
      setFailed(true);
      return;
    }
    const controller = new AbortController();
    let objectUrl = "";
    void fetch(photoUrl, { headers: authHeaders, signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Фото недоступно");
        return response.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [authHeaders, photoFile, photoUrl]);

  if (failed) return <div className="review-photo-placeholder">Фото недоступно</div>;
  if (!source) return <div className="review-photo-placeholder">Загружаем фото…</div>;
  return <img className="review-photo-preview" src={source} alt={alt} />;
}

function EmployeeControl({
  waiters,
  roles,
  tables,
  shifts,
  ratings,
  accessRole,
  venueTimeZone,
  authHeaders,
  onRefresh
}: {
  waiters: Waiter[];
  roles: StaffRoleDefinition[];
  tables: DiningTable[];
  shifts: WaiterShift[];
  ratings: WaiterRating[];
  accessRole: AdminAccessRole;
  venueTimeZone: string;
  authHeaders: Record<string, string>;
  onRefresh: () => Promise<void>;
}) {
  const todayKey = useMemo(
    () => new Intl.DateTimeFormat("en-CA", { timeZone: venueTimeZone || "Europe/Astrakhan" }).format(new Date(Date.now() - 2 * 60 * 60 * 1000)),
    [venueTimeZone]
  );
  const roleMap = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);
  const activeShiftByWaiterId = useMemo(() => new Map(
    shifts.filter((shift) => shift.status !== "ended").map((shift) => [shift.waiterId, shift])
  ), [shifts]);
  const eligibleWaiters = useMemo(
    () => waiters
      .filter((waiter) => {
        const role = roleMap.get(waiter.roleId);
        if (!role || role.kind === "owner") return false;
        return accessRole === "owner" || role.kind !== "admin";
      })
      .sort((left, right) => left.name.localeCompare(right.name, "ru")),
    [accessRole, roleMap, waiters]
  );
  const [selectedWaiterId, setSelectedWaiterId] = useState("");
  const [selectedDate, setSelectedDate] = useState(todayKey);
  const [onShiftOnly, setOnShiftOnly] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, EmployeeItemReviewDraft>>({});
  const [savingItem, setSavingItem] = useState("");
  const [notice, setNotice] = useState("");
  const [endingShiftId, setEndingShiftId] = useState("");
  const [shiftNotice, setShiftNotice] = useState("");

  useEffect(() => {
    if (!eligibleWaiters.some((waiter) => waiter.id === selectedWaiterId)) {
      setSelectedWaiterId("");
    }
  }, [eligibleWaiters, selectedWaiterId]);

  useEffect(() => {
    setNotice("");
    setShiftNotice("");
  }, [selectedWaiterId]);

  useEffect(() => {
    if (!selectedWaiterId) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedWaiterId("");
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [selectedWaiterId]);

  const selectedWaiter = eligibleWaiters.find((waiter) => waiter.id === selectedWaiterId) ?? null;
  const selectedRole = selectedWaiter ? roleMap.get(selectedWaiter.roleId) ?? null : null;
  const selectedActiveShift = selectedWaiter ? activeShiftByWaiterId.get(selectedWaiter.id) ?? null : null;
  const assignedTableCount = selectedWaiter
    ? tables.filter((table) => new Set([
      ...(table.waiterIds ?? []),
      ...(table.waiterId ? [table.waiterId] : [])
    ]).has(selectedWaiter.id)).length
    : 0;
  const employeeShifts = selectedWaiter
    ? shifts
      .filter((shift) => shift.waiterId === selectedWaiter.id)
      .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())
    : [];
  const dayShifts = employeeShifts.filter((shift) => shift.morningGreetingDate === selectedDate);
  const employeeRating = ratings.find((rating) => rating.waiterId === selectedWaiterId) ?? null;
  const allItems = employeeShifts.flatMap((shift) => shift.checklist);
  const completedItems = allItems.filter((item) => item.completedAt);
  const reviewedItems = completedItems.filter((item) => item.adminScore !== null);
  const explicitAverage = reviewedItems.length
    ? Math.round((reviewedItems.reduce((sum, item) => sum + (item.adminScore || 0), 0) / reviewedItems.length) * 100) / 100
    : 0;
  const completionRate = allItems.length ? Math.round((completedItems.length / allItems.length) * 100) : 0;
  const filteredWaiters = eligibleWaiters.filter((waiter) => !onShiftOnly || activeShiftByWaiterId.has(waiter.id));

  const draftKey = (shiftId: string, itemId: string) => `${shiftId}:${itemId}`;
  const draftFor = (shift: WaiterShift, item: WaiterShift["checklist"][number]) =>
    drafts[draftKey(shift.id, item.itemId)] || {
      score: item.adminScore ?? (!item.completedAt && item.phase === "closing" ? 4 : 5),
      comment: item.adminComment,
      photoUrl: item.adminPhotoUrl,
      photoFile: null
    };
  const updateDraft = (
    shift: WaiterShift,
    item: WaiterShift["checklist"][number],
    patch: Partial<EmployeeItemReviewDraft>
  ) => {
    const key = draftKey(shift.id, item.itemId);
    setDrafts((current) => ({ ...current, [key]: { ...draftFor(shift, item), ...patch } }));
  };

  const selectPhoto = (shift: WaiterShift, item: WaiterShift["checklist"][number], file?: File) => {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) {
      setNotice("Фото должно быть в формате PNG, JPG или WEBP и весить не более 8 МБ");
      return;
    }
    updateDraft(shift, item, { photoFile: file });
    setNotice("");
  };

  const saveItemReview = async (shift: WaiterShift, item: WaiterShift["checklist"][number]) => {
    const key = draftKey(shift.id, item.itemId);
    const draft = draftFor(shift, item);
    setSavingItem(key);
    setNotice("");
    try {
      if (!item.completedAt && item.phase === "closing" && draft.score > 4) {
        window.alert("Оценка свыше 4 не может быть назначена, так как пункт чек-листа закрытия выполнен не вовремя.");
        return;
      }
      if (item.phase === "closing" && !draft.photoFile && !draft.photoUrl) {
        throw new Error("Для пункта чек-листа закрытия обязательно добавьте фото подтверждение");
      }
      let photoUrl = draft.photoUrl;
      if (draft.photoFile) {
        const uploadResponse = await fetch("/api/admin/review-media", {
          method: "POST",
          headers: {
            ...authHeaders,
            "content-type": draft.photoFile.type
          },
          body: draft.photoFile
        });
        const uploadResult = await uploadResponse.json().catch(() => ({}));
        if (!uploadResponse.ok) throw new Error(uploadResult.error || "Не удалось загрузить фото");
        photoUrl = String(uploadResult.url || "");
      }
      await api(`/api/admin/shifts/${shift.id}/review`, {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({
          reviews: [{
            itemId: item.itemId,
            score: Math.max(1, Math.min(5, draft.score)),
            comment: draft.comment,
            photoUrl
          }]
        })
      });
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setNotice(`Оценка пункта «${item.title}» сохранена`);
      await onRefresh();
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : "Не удалось сохранить оценку");
    } finally {
      setSavingItem("");
    }
  };

  const endSelectedWaiterShift = async () => {
    if (!selectedWaiter || !selectedActiveShift || selectedActiveShift.roleKind !== "waiter" || assignedTableCount > 0) return;
    if (!window.confirm(`Завершить смену официанта «${selectedWaiter.name}»?`)) return;
    setEndingShiftId(selectedActiveShift.id);
    setShiftNotice("");
    try {
      await api<WaiterShift>(`/api/admin/shifts/${selectedActiveShift.id}/end`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({})
      });
      setShiftNotice(`Смена сотрудника «${selectedWaiter.name}» завершена`);
      await onRefresh();
    } catch (requestError) {
      setShiftNotice(requestError instanceof Error ? requestError.message : "Не удалось завершить смену");
    } finally {
      setEndingShiftId("");
    }
  };

  if (!eligibleWaiters.length) {
    return <section className="admin-panel empty-state employee-control-empty">Нет сотрудников, доступных для контроля.</section>;
  }

  return (
    <div className="employee-control-layout">
      <section className="admin-panel employee-picker-panel">
        <div className="panel-heading"><div><h2>Сотрудники</h2><p className="muted">Выберите сотрудника — его карточка откроется в отдельном окне.</p></div><Users size={20} /></div>
        <div className="employee-picker-toolbar">
          <div className="employee-scope-switch" role="group" aria-label="Список сотрудников">
            <button type="button" className={onShiftOnly ? "active" : ""} onClick={() => setOnShiftOnly(true)}>На смене</button>
            <button type="button" className={!onShiftOnly ? "active" : ""} onClick={() => setOnShiftOnly(false)}>Все сотрудники</button>
          </div>
          <label className="field employee-select-field">
            <span>Сотрудник</span>
            <select value="" onChange={(event) => setSelectedWaiterId(event.target.value)}>
              <option value="">Выберите сотрудника</option>
              {filteredWaiters.map((waiter) => {
                const role = roleMap.get(waiter.roleId);
                const shift = activeShiftByWaiterId.get(waiter.id);
                return <option key={waiter.id} value={waiter.id}>{shift ? "● " : ""}{waiter.name} · {role?.name || "Сотрудник"}</option>;
              })}
            </select>
          </label>
        </div>
        {!filteredWaiters.length && <p className="muted employee-picker-empty">Сейчас на смене нет сотрудников.</p>}
      </section>

      {selectedWaiter && (
        <div className="employee-control-modal" role="dialog" aria-modal="true" aria-label={`Карточка сотрудника ${selectedWaiter.name}`}>
          <div className="employee-control-modal__window">
          <div className="employee-control-modal__bar">
            <div><span className={selectedActiveShift ? "employee-online-dot is-active" : "employee-online-dot"} /><strong>{selectedWaiter.name}</strong></div>
            <button className="icon-button" type="button" onClick={() => setSelectedWaiterId("")} aria-label="Закрыть карточку" title="Закрыть"><X size={20} /></button>
          </div>
          <div className="employee-control-content">
          <section className="admin-panel employee-profile-card">
            <div className="employee-profile-heading">
              <span className="employee-avatar employee-avatar--large">{selectedWaiter.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span>
              <div className="employee-profile-identity"><p>Карточка сотрудника</p><h2>{selectedWaiter.name}</h2><span>{selectedRole?.name || "Сотрудник"} · {selectedActiveShift ? "на смене" : selectedWaiter.active ? "не на смене" : "неактивен"}</span></div>
              {selectedActiveShift?.roleKind === "waiter" && (
                <div className="employee-profile-shift-action">
                  {assignedTableCount === 0 ? (
                    <button className="ghost-button compact employee-end-shift-button" disabled={endingShiftId === selectedActiveShift.id} onClick={() => void endSelectedWaiterShift()}>
                      <LogOut size={17} /> {endingShiftId === selectedActiveShift.id ? "Завершаем" : "Завершить смену"}
                    </button>
                  ) : (
                    <span className="employee-shift-blocked">Смена не может быть завершена: назначено столов — {assignedTableCount}</span>
                  )}
                </div>
              )}
            </div>
            {shiftNotice && <div className="employee-profile-notice">{shiftNotice}</div>}
            <div className="employee-profile-metrics">
              <article><strong>{employeeShifts.length}</strong><span>смен за всё время</span></article>
              <article><strong>{completionRate}%</strong><span>выполнено пунктов</span></article>
              <article><strong>{reviewedItems.length ? `${explicitAverage} ★` : "—"}</strong><span>средняя оценка проверок</span></article>
              <article><strong>{employeeRating?.score ? `${employeeRating.score} ★` : "—"}</strong><span>общий рейтинг</span></article>
              <article><strong>{employeeRating?.missedCallCount ?? 0}</strong><span>пропущено вызовов</span></article>
            </div>
          </section>

          <section className="admin-panel employee-day-control">
            <div className="panel-heading employee-day-heading">
              <div><h2>Контроль чек-листа по дате</h2><p className="muted">По умолчанию показана сегодняшняя смена.</p></div>
              <div className="employee-date-control">
                <label className="field"><span><CalendarDays size={16} /> Дата</span><input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></label>
                {selectedDate !== todayKey && <button className="ghost-button compact" onClick={() => setSelectedDate(todayKey)}>Сегодня</button>}
              </div>
            </div>
            {notice && <div className="task-notice">{notice}</div>}
            <div className="employee-day-shifts">
              {dayShifts.map((shift) => {
                const completed = shift.checklist.filter((item) => item.completedAt).length;
                const total = shift.checklist.length;
                const progress = total ? Math.round((completed / total) * 100) : 100;
                const nextPending = shift.checklist.find((item) => !item.completedAt);
                const lastCompleted = [...shift.checklist].reverse().find((item) => item.completedAt);
                const phaseGroups = groupChecklistByPhase(shift.checklist);
                return (
                  <article className="employee-shift-control" key={shift.id}>
                    <div className="employee-shift-summary">
                      <div><strong>{shift.roleName} · {shift.status === "ended" ? "смена завершена" : shift.status === "active" ? "на линии" : "выполняет чек-лист"}</strong><span>Начало: {formatDate(shift.startedAt)}{shift.endedAt ? ` · завершение: ${formatDate(shift.endedAt)}` : ""}</span></div>
                      <strong>{completed} / {total}</strong>
                    </div>
                    <div className="employee-progress-track"><span style={{ width: `${progress}%` }} /></div>
                    <div className={`employee-stage-note ${nextPending ? "is-pending" : "is-complete"}`}>
                      {nextPending
                        ? lastCompleted
                          ? `Последний выполненный пункт: «${lastCompleted.title}». Следующий незавершённый: «${nextPending.title}».`
                          : `Сотрудник ещё не выполнил первый пункт: «${nextPending.title}».`
                        : "Все пункты чек-листа выполнены."}
                    </div>
                    {shift.roleKind === "admin" && (
                      <div className="admin-closing-summary">
                        <div><span>Пунктов под контролем</span><strong>{shift.adminReviewRequiredCount}</strong></div>
                        <div><span>Без отчёта</span><strong>{shift.adminReviewMissingCount}</strong></div>
                        <div><span>Снижение рейтинга</span><strong>{shift.adminRatingPenaltyStars ? `−${shift.adminRatingPenaltyStars} ★` : "—"}</strong></div>
                        <div><span>Штраф</span><strong>{shift.adminPenaltyAmount} ₽</strong></div>
                        {shift.adminPenaltyAmount > 0 && (
                          <div className="admin-penalty-receipt">
                            <span>Подтверждение перевода</span>
                            {shift.adminPenaltyReceiptUrl
                              ? <ReviewImagePreview photoFile={null} photoUrl={shift.adminPenaltyReceiptUrl} authHeaders={authHeaders} alt={`Чек штрафа за ${shift.morningGreetingDate}`} />
                              : <strong>Чек ещё не загружен</strong>}
                          </div>
                        )}
                      </div>
                    )}
                    <div className="employee-checklist-review">
                      {phaseGroups.map((group) => (
                        <details className="employee-checklist-phase" key={group.phase}>
                          <summary>
                            <span className="employee-checklist-phase-title">
                              <span aria-hidden="true">{CHECKLIST_PHASE_META[group.phase].icon}</span>
                              <span><strong>{CHECKLIST_PHASE_META[group.phase].title}</strong><small>{group.completed === group.entries.length ? "Все пункты выполнены" : `Осталось выполнить: ${group.entries.length - group.completed}`}</small></span>
                            </span>
                            <span className="employee-checklist-phase-metrics">
                              <strong>{group.completed} / {group.entries.length}</strong>
                              <small>{group.reviewed ? `оценено ${group.reviewed}${group.averageScore !== null ? ` · ${group.averageScore} ★` : ""}` : "ещё не оценено"}</small>
                            </span>
                          </summary>
                          <div className="employee-checklist-phase-items">
                            {group.entries.map(({ item, index }) => {
                              const draft = draftFor(shift, item);
                              const key = draftKey(shift.id, item.itemId);
                              const closingReviewRequired = item.phase === "closing" && (shift.roleKind === "waiter" || shift.roleId === "barista");
                              const reviewAvailable = Boolean(item.completedAt) || closingReviewRequired;
                              return (
                                <article className={`employee-checklist-item ${item.completedAt ? "is-completed" : "is-pending"}`} key={item.itemId}>
                                  <div className="employee-checklist-item-heading">
                                    <span className="employee-checklist-index">{index + 1}</span>
                                    <div><strong>{item.title}</strong><small>{CHECKLIST_PHASE_META[group.phase].shortTitle} · {item.completedAt ? `выполнено ${formatDate(item.completedAt)}` : "не выполнено"}{item.countsForRating === false ? " · оценка не влияет на общий рейтинг" : ""}</small></div>
                                    {item.completedAt ? <CheckCircle2 size={22} /> : <Clock size={22} />}
                                  </div>
                                  {item.description && <p>{item.description}</p>}
                                  {reviewAvailable && (
                                    <div className="employee-item-review-form">
                                      <div className="field star-review-field"><span>Оценка пункта</span><StarScore value={draft.score} onChange={(score) => {
                                        if (!item.completedAt && item.phase === "closing" && score > 4) {
                                          window.alert("Оценка свыше 4 не может быть назначена, так как пункт чек-листа закрытия выполнен не вовремя.");
                                          return;
                                        }
                                        updateDraft(shift, item, { score });
                                      }} /></div>
                                      {!item.completedAt && item.phase === "closing" && <div className="task-notice">Пункт выполнен не вовремя: максимальная оценка — 4 звезды. Фото обязательно.</div>}
                                      <label className="field employee-review-comment"><span>Комментарий руководителя</span><textarea rows={3} maxLength={500} value={draft.comment} onChange={(event) => updateDraft(shift, item, { comment: event.target.value })} placeholder="Что выполнено хорошо и что нужно улучшить" /></label>
                                      <div className="employee-review-photo">
                                        <span className="employee-review-photo-label">Фото к комментарию</span>
                                        {(draft.photoFile || draft.photoUrl) && <ReviewImagePreview photoFile={draft.photoFile} photoUrl={draft.photoUrl} authHeaders={authHeaders} alt={`Фото проверки: ${item.title}`} />}
                                        <div className="button-row">
                                          <label className="ghost-button compact review-photo-upload"><ImageIcon size={17} /> {draft.photoFile || draft.photoUrl ? "Заменить фото" : "Добавить фото"}<input type="file" accept="image/png,image/jpeg,image/webp" capture="environment" onChange={(event) => selectPhoto(shift, item, event.target.files?.[0])} /></label>
                                          {(draft.photoFile || draft.photoUrl) && <button className="ghost-button compact" type="button" onClick={() => updateDraft(shift, item, { photoFile: null, photoUrl: "" })}><X size={17} /> Убрать</button>}
                                        </div>
                                      </div>
                                      {item.reviewedAt && <small className="employee-review-meta">Последняя проверка: {formatDate(item.reviewedAt)}{item.reviewedByUsername ? ` · ${item.reviewedByUsername}` : ""}</small>}
                                      <button className="primary-button compact employee-review-save" disabled={savingItem === key} onClick={() => void saveItemReview(shift, item)}><Save size={18} /> {savingItem === key ? "Сохраняем" : "Сохранить оценку"}</button>
                                    </div>
                                  )}
                                </article>
                              );
                            })}
                          </div>
                        </details>
                      ))}
                    </div>
                  </article>
                );
              })}
              {!dayShifts.length && <div className="employee-no-shift"><CalendarDays size={28} /><strong>На выбранную дату смена не найдена</strong><span>Сотрудник не начинал чек-лист либо смена ещё не создана.</span></div>}
            </div>
          </section>

          <section className="admin-panel employee-history-card">
            <div className="panel-heading"><div><h2>История за всё время</h2><p className="muted">Последние смены, прогресс и количество проверенных пунктов.</p></div><RefreshCw size={20} /></div>
            <div className="employee-history-list">
              {employeeShifts.slice(0, 30).map((shift) => {
                const completed = shift.checklist.filter((item) => item.completedAt).length;
                const reviewed = shift.checklist.filter((item) => item.adminScore !== null).length;
                return <article key={shift.id}><div><strong>{shift.morningGreetingDate}</strong><span>{shift.roleName} · {shift.status === "ended" ? "завершена" : "в работе"}</span></div><div><strong>{completed} / {shift.checklist.length}</strong><span>выполнено</span></div><div><strong>{reviewed}</strong><span>оценено</span></div><div><strong>{shift.score ? `${shift.score} ★` : "—"}</strong><span>рейтинг смены</span></div></article>;
              })}
              {!employeeShifts.length && <p className="muted">История смен пока отсутствует.</p>}
            </div>
          </section>
        </div>
        </div>
        </div>
      )}
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
  title,
  mode
}: {
  ratings: WaiterRating[];
  shifts: WaiterShift[];
  performance: PerformanceAnalytics;
  performanceAiEnabled: boolean;
  authHeaders: Record<string, string>;
  onRefresh: () => Promise<void>;
  title: string;
  mode: "ratings" | "journal" | "ai";
}) {
  const [drafts, setDrafts] = useState<ShiftReviewDraft>({});
  const [savingShift, setSavingShift] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedRoleId, setSelectedRoleId] = useState("all");
  const [insight, setInsight] = useState<PerformanceInsightReport | null>(null);
  const [insightBusy, setInsightBusy] = useState(false);
  const [journalDate, setJournalDate] = useState("");
  const [journalWaiterId, setJournalWaiterId] = useState("all");
  const [selectedInsightWaiterId, setSelectedInsightWaiterId] = useState("");
  const [employeeInsight, setEmployeeInsight] = useState<PerformanceInsightReport | null>(null);
  const [employeeInsightBusy, setEmployeeInsightBusy] = useState(false);
  const ratedEmployees = ratings.filter((item) => item.shiftCount > 0);
  const average = ratedEmployees.length
    ? Math.round((ratedEmployees.reduce((sum, item) => sum + item.score, 0) / ratedEmployees.length) * 100) / 100
    : 0;
  const visibleRatings = selectedRoleId === "all" ? ratings : ratings.filter((item) => item.roleId === selectedRoleId);
  const roleTabs = performance.roleSummaries;
  const journalShifts = shifts
    .filter((shift) => !journalDate || new Intl.DateTimeFormat("en-CA").format(new Date(shift.startedAt)) === journalDate)
    .filter((shift) => journalWaiterId === "all" || shift.waiterId === journalWaiterId)
    .slice(0, 80);
  const journalEmployees = Array.from(new Map(
    shifts.map((shift) => [shift.waiterId, { id: shift.waiterId, name: shift.waiterName }])
  ).values()).sort((left, right) => left.name.localeCompare(right.name, "ru"));
  const visibleTaskPatterns = performance.taskPatterns
    .filter((item) => selectedRoleId === "all" || item.roleId === selectedRoleId);
  const visibleEmployeePatterns = performance.employeePatterns
    .filter((item) => selectedRoleId === "all" || item.roleId === selectedRoleId);

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

  const generateEmployeeInsight = async () => {
    if (!selectedInsightWaiterId) return;
    setEmployeeInsightBusy(true);
    setNotice("");
    try {
      setEmployeeInsight(await api<PerformanceInsightReport>(`/api/admin/employees/${selectedInsightWaiterId}/performance-insights`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({})
      }));
    } catch (requestError) {
      setNotice(requestError instanceof Error ? requestError.message : "Не удалось сформировать резюме сотрудника");
    } finally {
      setEmployeeInsightBusy(false);
    }
  };

  return (
    <div className="shift-admin-layout">
      {mode === "ratings" && <>
      <div className="admin-grid shift-metrics">
        <Metric title="Сотрудников в рейтинге" value={ratings.length} icon={<Users size={22} />} />
        <Metric title="Средний рейтинг" value={`${average} ★`} icon={<Star size={22} />} />
        <Metric title="Активные смены" value={shifts.filter((shift) => shift.status !== "ended").length} icon={<Clock size={22} />} />
        <Metric title="Пропущенные вызовы" value={ratings.reduce((sum, rating) => sum + rating.missedCallCount, 0)} icon={<AlertTriangle size={22} />} />
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
            <thead><tr><th>Место</th><th>Сотрудник</th><th>Должность</th><th>Рейтинг</th><th>Выполнение</th><th>Пропущено вызовов</th><th>Динамика</th><th>Смен</th></tr></thead>
            <tbody>
              {visibleRatings.map((rating) => (
                <tr key={rating.waiterId}>
                  <td className="ranking-place">#{rating.rank}</td>
                  <td><strong>{rating.waiterName}</strong></td>
                  <td>{rating.roleName}</td>
                  <td><span className="rating-value"><Star size={16} fill="currentColor" /><strong>{rating.shiftCount ? rating.score : "—"}</strong></span></td>
                  <td>{rating.completionRate}%</td>
                  <td>{rating.missedCallCount}</td>
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
            <thead><tr><th>Подразделение</th><th>Сотрудников</th><th>Оцененных смен</th><th>Средний рейтинг</th><th>Выполнение задач</th><th>Пропущено вызовов</th></tr></thead>
            <tbody>
              {performance.roleSummaries.map((role) => <tr key={role.roleId}><td><strong>{role.roleName}</strong></td><td>{role.employeeCount}</td><td>{role.ratedShiftCount}</td><td>{role.ratedShiftCount ? `${role.averageStars} ★` : "—"}</td><td>{role.completionRate}%</td><td>{role.missedCallCount}</td></tr>)}
              {!performance.roleSummaries.length && <tr><td className="ops-table-empty" colSpan={6}>Данных по подразделениям пока нет.</td></tr>}
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
              {visibleTaskPatterns.filter((item) => item.issueRate > 0).slice(0, 12).map((item) => (
                <tr key={item.key}><td>{item.roleName}</td><td><strong>{item.taskTitle}</strong>{!item.countsForRating && <small className="table-note">Без влияния на рейтинг</small>}</td><td>{item.assignments}</td><td>{item.missed}</td><td>{item.lowRatings}</td><td>{item.averageStars === null ? "—" : `${item.averageStars} ★`}</td><td><strong>{item.issueRate}%</strong></td></tr>
              ))}
              {!visibleTaskPatterns.some((item) => item.issueRate > 0) && <tr><td className="ops-table-empty" colSpan={7}>Повторяющихся сбоев пока не обнаружено.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-panel employee-patterns-panel">
        <div className="panel-heading"><div><h2>Паттерны конкретных сотрудников</h2><p className="muted">Список строится по повторяющимся пропускам и оценкам ниже 4 звезд.</p></div><UserRound size={20} /></div>
        <div className="employee-pattern-grid">
          {visibleEmployeePatterns.slice(0, 12).map((item) => (
            <article key={item.key} className="employee-pattern-row">
              <div><strong>{item.waiterName}</strong><span>{item.roleName}</span></div>
              <div><strong>{item.taskTitle}</strong><span>{item.missed} пропусков · {item.lowRatings} низких оценок · сбой {item.issueRate}%</span></div>
              <p>{item.recommendation}</p>
            </article>
          ))}
          {!visibleEmployeePatterns.length && <p className="muted">Индивидуальных повторяющихся нарушений пока нет.</p>}
        </div>
      </section>

      </>}

      {mode === "ai" && <>
      <div className="admin-grid shift-metrics">
        <Metric title="Проанализировано смен" value={performance.analyzedShiftCount} icon={<ClipboardCheck size={22} />} />
        <Metric title="Пропущено вызовов" value={performance.totalMissedCalls} icon={<AlertTriangle size={22} />} />
        <Metric title="Повторяющиеся сбои" value={performance.taskPatterns.filter((item) => item.issueRate > 0).length} icon={<RefreshCw size={22} />} />
        <Metric title="Сотрудники в зоне внимания" value={new Set(performance.employeePatterns.map((item) => item.waiterId)).size} icon={<Users size={22} />} />
      </div>
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
        {!insight && (
          <div className="ai-baseline-summary">
            <h3>Текущие рекомендации по фактическим данным</h3>
            {performance.recommendations.map((recommendation, index) => <p key={`${index}-${recommendation}`}><strong>{index + 1}.</strong> {recommendation}</p>)}
          </div>
        )}
      </section>

      <section className="admin-panel employee-ai-card">
        <div className="panel-heading">
          <div><h2>ИИ-резюме конкретного сотрудника</h2><p className="muted">Выберите сотрудника, чтобы получить персональную оценку динамики и конкретные рекомендации.</p></div>
        </div>
        <div className="employee-ai-toolbar">
          <label className="field"><span>Сотрудник</span><select value={selectedInsightWaiterId} onChange={(event) => { setSelectedInsightWaiterId(event.target.value); setEmployeeInsight(null); }}><option value="">Выберите сотрудника</option>{ratings.map((rating) => <option key={rating.waiterId} value={rating.waiterId}>{rating.waiterName} · {rating.roleName}</option>)}</select></label>
          <button className="primary-button compact" disabled={!selectedInsightWaiterId || employeeInsightBusy} onClick={() => void generateEmployeeInsight()}><Sparkles size={18} /> {employeeInsightBusy ? "Анализируем" : "Сформировать резюме"}</button>
        </div>
        {employeeInsight && <div className="ai-insight-result"><div className="ai-insight-meta"><span>{employeeInsight.source === "openrouter" ? "ИИ-анализ" : "Локальный анализ"}</span><span>{employeeInsight.model}</span><span>{formatDate(employeeInsight.generatedAt)}</span></div><p className="ai-summary">{employeeInsight.summary}</p><div className="ai-recommendation-grid">{employeeInsight.recommendations.map((item, index) => <article key={`${index}-${item}`}><strong>{index + 1}</strong><p>{item}</p></article>)}</div></div>}
      </section>
      </>}

      {mode === "journal" && <section className="admin-panel">
        <div className="panel-heading shift-journal-heading">
          <div><h2>{title}: журнал</h2><p className="muted">Выберите дату, чтобы показать смены только за нужный день.</p></div>
          <div className="shift-journal-filter">
            <label className="field">
              <span><UserRound size={16} /> Сотрудник</span>
              <select value={journalWaiterId} onChange={(event) => setJournalWaiterId(event.target.value)}>
                <option value="all">Все сотрудники</option>
                {journalEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
              </select>
            </label>
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
                {groupChecklistByPhase(shift.checklist).map((group) => (
                  <details className="shift-review-phase" key={group.phase}>
                    <summary>
                      <span><strong>{CHECKLIST_PHASE_META[group.phase].icon} {CHECKLIST_PHASE_META[group.phase].title}</strong><small>{group.completed} из {group.entries.length} выполнено · {group.reviewed} оценено</small></span>
                      <span className="shift-phase-score">{group.averageScore === null ? "—" : `${group.averageScore} ★`}</span>
                    </summary>
                    <div className="shift-review-phase-items">
                      {group.entries.map(({ item }) => {
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
                    </div>
                  </details>
                ))}
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
      </section>}
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
  onSave,
  onSync
}: {
  offers: Offer[];
  onChange: (offers: Offer[]) => void;
  onSave: () => void;
  onSync: () => void;
}) {
  const update = (index: number, patch: Partial<Offer>) => {
    onChange(offers.map((offer, offerIndex) => (offerIndex === index ? { ...offer, ...patch } : offer)));
  };

  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <div><h2>Акции и спецпредложения</h2><p className="muted">Единый список хранится в CRM и автоматически передаётся в Qrnastol.</p></div>
        <div className="button-row">
          <button className="icon-button" onClick={onSync} aria-label="Обновить акции из CRM" title="Обновить акции из CRM"><RefreshCw size={18} /></button>
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
      <div className="admin-grid feedback-metrics">
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
  autoGrow,
  full,
  short,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  textarea?: boolean;
  autoGrow?: boolean;
  full?: boolean;
  short?: boolean;
  placeholder?: string;
}) {
  const helpText = placeholder && placeholder.length > 18 ? placeholder : "";
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resizeTextarea = (element: HTMLTextAreaElement) => {
    if (!autoGrow) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  };

  useEffect(() => {
    if (textareaRef.current) resizeTextarea(textareaRef.current);
  }, [autoGrow, value]);

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
        <textarea
          ref={textareaRef}
          className={autoGrow ? "auto-grow-textarea" : undefined}
          rows={autoGrow ? 1 : 4}
          value={value}
          onChange={(event) => {
            resizeTextarea(event.target);
            onChange(event.target.value);
          }}
          placeholder={placeholder}
          title={value || helpText || undefined}
        />
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
              <div className="popup-admin-row" key={popup.id} style={{ background: popup.active ? "#fff" : "#f9f9f9", opacity: popup.active ? 1 : 0.7 }}>
                {popup.imageUrl ? (
                  <img className="popup-admin-thumbnail" src={popup.imageUrl} alt="" />
                ) : (
                  <div className="popup-admin-thumbnail popup-admin-placeholder">
                    <Gift size={24} color="#ccc" />
                  </div>
                )}

                <div className="popup-admin-content">
                  <div className="popup-admin-heading">
                    <span style={{ fontSize: "12px", padding: "2px 6px", borderRadius: "4px", background: popup.active ? "#dff2df" : "#123c28", color: popup.active ? "#123c28" : "#fff", fontWeight: "bold" }}>
                      {popup.active ? "АКТИВНО" : "НЕАКТИВНО"}
                    </span>
                    <strong style={{ fontSize: "16px" }}>{popup.title}</strong>
                  </div>
                  <div className="popup-admin-body">
                    {popup.body}
                  </div>
                  <div className="popup-admin-meta">
                    <span>Кнопка: {popup.buttonText || "нет"}</span>
                    <span>Порядок: {popup.sort}</span>
                  </div>
                </div>

                <div className="popup-admin-actions">
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
