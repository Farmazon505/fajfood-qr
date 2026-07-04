import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4173),
  HOST: z.string().default("127.0.0.1"),
  PUBLIC_BASE_URL: z.string().url().optional(),
  ADMIN_PASSWORD: z.string().min(8).default("admin123"),
  ADMIN_SECRET: z.string().min(16).default("change-this-secret"),
  ADMIN_TOKEN_TTL_HOURS: z.coerce.number().min(1).max(168).default(12),
  APP_DATA_DIR: z.string().default(path.resolve(process.cwd(), "data")),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_ENABLE_POLLING: z.enum(["true", "false"]).default("false"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false")
});

export const config = envSchema.parse(process.env);

export const isProduction = config.NODE_ENV === "production";

export const publicBaseUrl = () =>
  (config.PUBLIC_BASE_URL || `http://localhost:5174`).replace(/\/$/, "");
