import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config, isProduction } from "./config";
import type { AdminAccessRole } from "./types";

export type AdminAuth = {
  username: string;
  role: AdminAccessRole;
  exp: number;
};

const ownerPassword = config.OWNER_PASSWORD || config.ADMIN_PASSWORD;
const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");
const sign = (payload: string) =>
  createHmac("sha256", config.ADMIN_SECRET).update(payload).digest("base64url");

const safeEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

export const authenticateAdmin = (username: string, password: string): Omit<AdminAuth, "exp"> | null => {
  const normalized = username.trim().toLowerCase();
  if (normalized === config.OWNER_USERNAME.trim().toLowerCase() && safeEqual(password, ownerPassword)) {
    return { username: config.OWNER_USERNAME, role: "owner" };
  }
  if (normalized === config.ADMIN_USERNAME.trim().toLowerCase() && safeEqual(password, config.ADMIN_PASSWORD)) {
    return { username: config.ADMIN_USERNAME, role: "admin" };
  }
  return null;
};

export const createAdminToken = (auth: Omit<AdminAuth, "exp">) => {
  const payload = base64url(
    JSON.stringify({
      ...auth,
      exp: Date.now() + config.ADMIN_TOKEN_TTL_HOURS * 60 * 60 * 1000
    })
  );
  return `${payload}.${sign(payload)}`;
};

export const verifyAdminToken = (token: string): AdminAuth | null => {
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as Partial<AdminAuth>;
    if (
      typeof parsed.exp !== "number" ||
      parsed.exp <= Date.now() ||
      (parsed.role !== "admin" && parsed.role !== "owner") ||
      typeof parsed.username !== "string"
    ) {
      return null;
    }
    return parsed as AdminAuth;
  } catch {
    return null;
  }
};

type AuthenticatedRequest = Request & { adminAuth?: AdminAuth };

export const getAdminAuth = (request: Request) => (request as AuthenticatedRequest).adminAuth ?? null;

export const requireAdmin = (request: Request, response: Response, next: NextFunction) => {
  const header = request.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const auth = token ? verifyAdminToken(token) : null;
  if (!auth) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }
  (request as AuthenticatedRequest).adminAuth = auth;
  next();
};

export const requireOwner = (request: Request, response: Response, next: NextFunction) => {
  const auth = getAdminAuth(request);
  if (auth?.role !== "owner") {
    response.status(403).json({ error: "Доступно только владельцу" });
    return;
  }
  next();
};

export const assertProductionSecrets = () => {
  if (!isProduction) return;
  if (config.ADMIN_USERNAME.trim().toLowerCase() === config.OWNER_USERNAME.trim().toLowerCase()) {
    throw new Error("OWNER_USERNAME must be different from ADMIN_USERNAME");
  }
  if (config.ADMIN_PASSWORD === "admin123") throw new Error("ADMIN_PASSWORD must be changed in production");
  if (!config.OWNER_PASSWORD || config.OWNER_PASSWORD.length < 8) {
    throw new Error("OWNER_PASSWORD must be configured in production");
  }
  if (safeEqual(config.OWNER_PASSWORD, config.ADMIN_PASSWORD)) {
    throw new Error("OWNER_PASSWORD must be different from ADMIN_PASSWORD");
  }
  if (config.ADMIN_SECRET === "change-this-secret") {
    throw new Error("ADMIN_SECRET must be changed in production");
  }
};
