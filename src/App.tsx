import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { TableTentDesigner } from "./TableTentDesigner";
import {
  BellRing,
  ChevronLeft,
  Check,
  CheckCircle2,
  Clock,
  CreditCard,
  Gift,
  HeartHandshake,
  ImageIcon,
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
  Save,
  Settings,
  Utensils,
  Star,
  AlertTriangle,
  Table2,
  Tags,
  Trash2,
  Upload,
  UserRound,
  Users,
  Wifi
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type {
  AppData,
  CallAction,
  CallStatus,
  DiningTable,
  GuestFeedback,
  LoyaltyLead,
  Offer,
  ServiceCall,
  VenueSettings,
  Waiter
} from "../server/types";

type Bootstrap = {
  settings: VenueSettings;
  offers: Offer[];
  actions: CallAction[];
  table: DiningTable | null;
  publicBaseUrl: string;
};

type TipTarget = {
  enabled: boolean;
  waiterName?: string;
  url?: string;
  message?: string;
};

type AdminData = AppData & {
  publicBaseUrl: string;
  telegramEnabled: boolean;
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
  const [error, setError] = useState("");
  const [comment, setComment] = useState("");
  const [guestName, setGuestName] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [orderModalAction, setOrderModalAction] = useState<CallAction | null>(null);
  const [tipBusy, setTipBusy] = useState(false);
  const [tipNotice, setTipNotice] = useState("");
  const [sentAction, setSentAction] = useState<SentAction>(null);
  const [view, setView] = useState<GuestView>(() => guestViewFromPath(window.location.pathname));
  const [loyalty, setLoyalty] = useState({ name: "", phone: "", birthday: "", consent: true });
  const [loyaltyDone, setLoyaltyDone] = useState(false);

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
    if (!sentAction) return undefined;
    const timeout = window.setTimeout(() => setSentAction(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [sentAction]);

  useEffect(() => {
    if (!tipNotice) return undefined;
    const timeout = window.setTimeout(() => setTipNotice(""), 6000);
    return () => window.clearTimeout(timeout);
  }, [tipNotice]);

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

    try {
      await api("/api/public/loyalty", {
        method: "POST",
        body: JSON.stringify({ ...loyalty, tableSlug: data.table.slug })
      });
      setLoyaltyDone(true);
      setLoyalty({ name: "", phone: "", birthday: "", consent: true });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось отправить анкету");
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
  const heroBackground = settings.heroImage;

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
                  {isSent && (
                    <div className="call-feedback" role="status">
                      <CheckCircle2 size={16} />
                      <span>Вызов "{sentAction.label}" отправлен. Официант уже видит стол и причину.</span>
                    </div>
                  )}
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
          <p>{settings.loyaltyText}</p>
          <form className="loyalty-form" onSubmit={submitLoyalty}>
            <input
              required
              value={loyalty.name}
              onChange={(event) => setLoyalty({ ...loyalty, name: event.target.value })}
              placeholder="Имя"
            />
            <input
              required
              value={loyalty.phone}
              onChange={(event) => setLoyalty({ ...loyalty, phone: event.target.value })}
              placeholder="Телефон"
            />
            <input
              value={loyalty.birthday}
              onChange={(event) => setLoyalty({ ...loyalty, birthday: event.target.value })}
              placeholder="День рождения"
            />
            <label className="check-row">
              <input
                type="checkbox"
                checked={loyalty.consent}
                onChange={(event) => setLoyalty({ ...loyalty, consent: event.target.checked })}
              />
              Согласен получать сообщения по программе лояльности
            </label>
            <button type="submit" className="primary-button">
              Зарегистрироваться
            </button>
          </form>
          {loyaltyDone && (
            <div className="success-line">
              <CheckCircle2 size={18} />
              Анкета сохранена. Администратор увидит заявку в панели.
            </div>
          )}
          {error && <div className="error-line">{error}</div>}
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
      const result = await api<{ token: string }>("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ password })
      });
      localStorage.setItem("adminToken", result.token);
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
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Пароль администратора"
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
    { id: "waiters", label: "Официанты", icon: <Users size={18} /> },
    { id: "actions", label: "Кнопки", icon: <BellRing size={18} /> },
    { id: "offers", label: "Акции", icon: <Tags size={18} /> },
    { id: "loyalty", label: "Лояльность", icon: <UserRound size={18} /> },
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
            <span>{data.telegramEnabled ? "Telegram подключен" : "Telegram не настроен"}</span>
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
            publicUrl={data.publicBaseUrl || window.location.origin}
          />
        )}

        {activeTab === "waiters" && (
          <WaitersEditor
            waiters={data.waiters}
            onChange={(waiters) => setData({ ...data, waiters })}
            onSave={() => void saveResource("waiters", data.waiters, "Официанты сохранены")}
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

        {activeTab === "feedbacks" && <FeedbacksList feedbacks={data.feedbacks} tables={data.tables} waiters={data.waiters} />}
      </section>
    </main>
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

function Metric({ title, value, icon }: { title: string; value: number; icon: ReactNode }) {
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
          <button className="ghost-button" onClick={() => onChange([...waiters, { id: "", name: "Официант", telegramChatId: "", tipUrl: "", active: true }])}>
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
  return (
    <label className={`field ${full ? "field-full" : ""} ${short ? "field-short" : ""}`}>
      <span>{label}</span>
      {textarea ? (
        <textarea rows={4} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      ) : (
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      )}
    </label>
  );
}
