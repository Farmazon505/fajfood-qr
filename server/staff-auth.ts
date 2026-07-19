import { createHmac, timingSafeEqual } from "node:crypto";

export type TelegramStaffIdentity = {
  id: string;
  firstName: string;
  lastName: string;
  username: string;
  authDate: number;
};

const safeHexEqual = (left: string, right: string) => {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
};

export function validateTelegramInitData(
  initData: string,
  botToken: string,
  options: { now?: number; maxAgeSeconds?: number } = {}
): TelegramStaffIdentity | null {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const providedHash = params.get("hash") || "";
  params.delete("hash");

  const dataCheckString = Array.from(params.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (!safeHexEqual(providedHash, expectedHash)) return null;

  const authDate = Number(params.get("auth_date"));
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const maxAge = options.maxAgeSeconds ?? 24 * 60 * 60;
  if (!Number.isFinite(authDate) || authDate > now + 60 || now - authDate > maxAge) return null;

  try {
    const user = JSON.parse(params.get("user") || "{}") as Record<string, unknown>;
    const id = String(user.id || "").trim();
    if (!/^\d+$/.test(id)) return null;
    return {
      id,
      firstName: String(user.first_name || ""),
      lastName: String(user.last_name || ""),
      username: String(user.username || ""),
      authDate,
    };
  } catch {
    return null;
  }
}
