import { createHash } from "node:crypto";
import { Router, type RequestHandler } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const limited: RequestHandler = (request, response) => {
  const reset = (request as typeof request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
  const retryAfterSeconds = Math.max(1, Math.ceil(((reset?.getTime() || Date.now() + 60_000) - Date.now()) / 1000));
  response.setHeader("Retry-After", String(retryAfterSeconds));
  response.status(429).json({ error: `Слишком много попыток. Повторите через ${Math.ceil(retryAfterSeconds / 60)} мин. Уже начатое подтверждение можно продолжить в боте.`,
    code: "LOYALTY_RATE_LIMIT", retryAfterSeconds });
};

export function createLoyaltyRateLimits() {
  const common = { standardHeaders: true, legacyHeaders: false, handler: limited };
  const attempts = Router();
  // A restaurant's Wi-Fi is shared by many guests. Only the broad abuse ceiling
  // uses IP; the small retry budget belongs to the normalized guest phone.
  attempts.use(rateLimit({ ...common, windowMs: 15 * 60_000, limit: 120 }));
  attempts.use(rateLimit({ ...common, windowMs: 15 * 60_000, limit: 5,
    keyGenerator: request => {
      const digits = String(request.body?.phone || "").replace(/\D/g, "");
      const phone = digits.length === 10 ? `7${digits}` : digits.length === 11 && /^[78]/.test(digits) ? `7${digits.slice(1)}` : null;
      return phone ? `phone:${digest(phone)}` : `invalid:${ipKeyGenerator(request.ip || "127.0.0.1")}`;
    } }));
  const reads = rateLimit({ ...common, windowMs: 60_000, limit: 90,
    skip: request => request.method !== "GET",
    keyGenerator: request => {
      const token = (request.headers.authorization || "").replace(/^Bearer /, "");
      return /^[A-Za-z0-9_-]{43}$/.test(token) ? `session:${digest(token)}` : `anonymous:${ipKeyGenerator(request.ip || "127.0.0.1")}`;
    } });
  return { attempts, reads };
}
