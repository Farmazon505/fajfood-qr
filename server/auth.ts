import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config, isProduction } from "./config";

export const adminPassword = config.ADMIN_PASSWORD;

const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

const sign = (payload: string) =>
  createHmac("sha256", config.ADMIN_SECRET).update(payload).digest("base64url");

const safeEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

export const createAdminToken = () => {
  const payload = base64url(
    JSON.stringify({
      exp: Date.now() + config.ADMIN_TOKEN_TTL_HOURS * 60 * 60 * 1000
    })
  );
  return `${payload}.${sign(payload)}`;
};

export const verifyAdminToken = (token: string) => {
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return false;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as { exp?: number };
    return typeof parsed.exp === "number" && parsed.exp > Date.now();
  } catch {
    return false;
  }
};

export const requireAdmin = (request: Request, response: Response, next: NextFunction) => {
  const header = request.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (token && verifyAdminToken(token)) {
    next();
    return;
  }

  response.status(401).json({ error: "Unauthorized" });
};

export const assertProductionSecrets = () => {
  if (!isProduction) return;
  if (adminPassword === "admin123") {
    throw new Error("ADMIN_PASSWORD must be changed in production");
  }
  if (config.ADMIN_SECRET === "change-this-secret") {
    throw new Error("ADMIN_SECRET must be changed in production");
  }
};
