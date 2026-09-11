export type StoredLoyaltyVerification = {
  id: string; accessToken: string; expiresAt: string;
  channels: { telegram: { url: string } | null; max: { url: string } | null };
};
export const VERIFICATION_STORAGE_KEY = "qrnastol.pendingVerification";

export function parseStoredVerification(raw: string | null, now = Date.now()): StoredLoyaltyVerification | null {
  try {
    if (!raw) return null;
    const value = JSON.parse(raw) as StoredLoyaltyVerification;
    if (!value || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(value.id) ||
      typeof value.accessToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.accessToken) ||
      typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= now || Date.parse(value.expiresAt) - now > 15 * 60_000 || !value.channels) return null;
    for (const [channel, host] of [[value.channels.telegram, "t.me"], [value.channels.max, "max.ru"]] as const) {
      if (channel) {
        const url = new URL(channel.url);
        if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password) return null;
      }
    }
    return value;
  } catch { return null; }
}
