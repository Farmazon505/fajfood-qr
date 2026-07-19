import path from "node:path";
import { z } from "zod";

const aiProxyUrlSchema = z.string().trim().refine((value) => {
  if (!value) return true;
  try {
    return ["http:", "https:", "socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"].includes(
      new URL(value).protocol.toLowerCase()
    );
  } catch {
    return false;
  }
}, "AI_PROXY_URL must be an HTTP(S) or SOCKS proxy URL");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4173),
  HOST: z.string().default("127.0.0.1"),
  PUBLIC_BASE_URL: z.string().url().optional(),
  ADMIN_USERNAME: z.string().min(1).default("admin"),
  ADMIN_PASSWORD: z.string().min(8).default("admin123"),
  OWNER_USERNAME: z.string().min(1).default("owner"),
  OWNER_PASSWORD: z.string().optional().default(""),
  ADMIN_SECRET: z.string().min(16).default("change-this-secret"),
  ADMIN_TOKEN_TTL_HOURS: z.coerce.number().min(1).max(168).default(12),
  APP_DATA_DIR: z.string().default(path.resolve(process.cwd(), "data")),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_BOT_USERNAME: z.string().trim().regex(/^@?[A-Za-z0-9_]{5,}$/).default("QROFFICBOT"),
  TELEGRAM_ENABLE_POLLING: z.enum(["true", "false"]).default("false"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  VENUE_TIME_ZONE: z.string().min(1).default("Europe/Astrakhan"),
  CRM_BASE_URL: z.string().url().optional().or(z.literal("")).default(""),
  CRM_LOYALTY_SERVICE_SECRET: z.string().optional().default(""),
  CRM_STAFF_SERVICE_SECRET: z.string().optional().default(""),
  LOYALTY_REGISTRATION_ALLOWLIST: z.string().optional().default(""),
  AI_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  AI_PROXY_URL: aiProxyUrlSchema.default(""),
  OPENROUTER_API_KEY: z.string().optional().default(""),
  AI_MODEL: z.string().min(1).default("openai/gpt-4o-mini"),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(12000)
});

export const config = envSchema.parse(process.env);

export const isProduction = config.NODE_ENV === "production";

export const publicBaseUrl = () =>
  (config.PUBLIC_BASE_URL || `http://localhost:5174`).replace(/\/$/, "");
