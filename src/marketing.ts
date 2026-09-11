type EventName = "popup_shown" | "popup_closed" | "popup_clicked" | "form_started";
let start: Promise<void> | null = null;
let activeToken: string | null = null;
const sent = new Set<EventName>();

async function send(path: string, body: unknown, headers: Record<string, string> = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body), signal: AbortSignal.timeout(7000), keepalive: true });
      if (response.ok) return response.status === 204 ? null : await response.json().catch(() => null);
      if (response.status < 500) throw new Error("Tracking rejected");
    } catch { /* A tracking failure must never disable waiter calls or registration. */ }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw new Error("Tracking unavailable");
}

export function startMarketing(tableSlug: string, loyaltyToken?: string | null) {
  if (!start) {
    const url = new URL(window.location.href);
    const token = url.searchParams.get("faj_visit") || undefined;
    url.searchParams.delete("faj_visit");
    window.history.replaceState({}, "", url);
    start = send("/api/public/marketing/start", { tableSlug, requestId: crypto.randomUUID(), ...(token ? { token } : {}) },
      loyaltyToken ? { authorization: `Bearer ${loyaltyToken}` } : {}).then(result => {
        activeToken = result && typeof result.token === "string" ? result.token : null;
      });
    void start.catch(() => undefined);
  }
}
export function trackMarketing(event: EventName) {
  if (!start || sent.has(event)) return;
  sent.add(event);
  void start.then(() => activeToken ? send("/api/public/marketing/event", { event, token: activeToken }) : undefined)
    .catch(() => { sent.delete(event); });
}

export function isLoyaltyPopup(popup: { purpose?: string; buttonUrl: string }) {
  return popup.purpose === "loyalty" || /(^|\/)loyalty\/?(?:\?|$)/.test(popup.buttonUrl);
}
export function popupEligible(input: { hasCard: boolean; isRegistering: boolean; isLoyalty: boolean; lastSeen: number; now: number }) {
  if (input.isRegistering) return false;
  if (input.hasCard && input.isLoyalty) return false;
  return !input.lastSeen || input.now - input.lastSeen >= 86_400_000;
}
