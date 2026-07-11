import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { config, isProduction } from "./config";
import type { AdminAccessRole, AdminAccountSummary } from "./types";

export type AdminAuth = {
  username: string;
  role: AdminAccessRole;
  credentialVersion?: string;
  exp: number;
};

const storedAdminCredentialsSchema = z.object({
  version: z.literal(1),
  username: z.string().trim().min(1).max(64),
  salt: z.string().min(16),
  passwordHash: z.string().min(32),
  credentialVersion: z.string().min(16),
  updatedAt: z.string().datetime()
}).strict();

type StoredAdminCredentials = z.infer<typeof storedAdminCredentialsSchema>;

const ownerPassword = config.OWNER_PASSWORD || config.ADMIN_PASSWORD;
const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");
const sign = (payload: string) =>
  createHmac("sha256", config.ADMIN_SECRET).update(payload).digest("base64url");
const normalizeUsername = (value: string) => value.trim().toLowerCase();

const safeEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const derivePasswordHash = (password: string, salt: string) =>
  scryptSync(password, Buffer.from(salt, "base64url"), 64).toString("base64url");

const createStoredCredentials = (username: string, password: string): StoredAdminCredentials => {
  const salt = randomBytes(16).toString("base64url");
  return storedAdminCredentialsSchema.parse({
    version: 1,
    username: username.trim(),
    salt,
    passwordHash: derivePasswordHash(password, salt),
    credentialVersion: randomUUID(),
    updatedAt: new Date().toISOString()
  });
};

export class AdminCredentialManager {
  private readonly filePath: string;
  private credentials: StoredAdminCredentials;
  private initialized = false;

  constructor(
    dataDirectory: string,
    bootstrapUsername: string,
    bootstrapPassword: string
  ) {
    this.filePath = path.resolve(dataDirectory, "admin-credentials.json");
    this.credentials = createStoredCredentials(bootstrapUsername, bootstrapPassword);
  }

  async initialize() {
    if (this.initialized) return;
    try {
      const stored = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      this.credentials = storedAdminCredentialsSchema.parse(stored);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Файл учётной записи администратора повреждён", { cause: error });
      }
      await this.persist(this.credentials);
    }
    this.initialized = true;
  }

  authenticate(username: string, password: string): Omit<AdminAuth, "exp"> | null {
    if (username.length > 64 || password.length > 128) return null;
    if (normalizeUsername(username) !== normalizeUsername(this.credentials.username)) return null;
    const actualHash = Buffer.from(derivePasswordHash(password, this.credentials.salt), "base64url");
    const expectedHash = Buffer.from(this.credentials.passwordHash, "base64url");
    if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) return null;
    return {
      username: this.credentials.username,
      role: "admin",
      credentialVersion: this.credentials.credentialVersion
    };
  }

  summary(): AdminAccountSummary {
    return {
      username: this.credentials.username,
      updatedAt: this.credentials.updatedAt
    };
  }

  acceptsCredentialVersion(version: string | undefined) {
    return Boolean(version) && safeEqual(version || "", this.credentials.credentialVersion);
  }

  async update(username: string, password: string) {
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username.trim()) || password.length < 8 || password.length > 128) {
      throw new Error("Некорректные параметры учётной записи администратора");
    }
    const next = createStoredCredentials(username, password);
    await this.persist(next);
    this.credentials = next;
    return this.summary();
  }

  private async persist(credentials: StoredAdminCredentials) {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(credentials, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

const adminCredentials = new AdminCredentialManager(
  config.APP_DATA_DIR,
  config.ADMIN_USERNAME,
  config.ADMIN_PASSWORD
);

export const initializeAdminCredentials = () => adminCredentials.initialize();
export const getAdminAccountSummary = () => adminCredentials.summary();

export const updateAdminAccount = async (username: string, password: string) => {
  if (normalizeUsername(username) === normalizeUsername(config.OWNER_USERNAME)) {
    throw new Error("Логин администратора должен отличаться от логина владельца");
  }
  if (safeEqual(password, ownerPassword)) {
    throw new Error("Пароль администратора должен отличаться от пароля владельца");
  }
  return adminCredentials.update(username, password);
};

export const authenticateAdmin = (username: string, password: string): Omit<AdminAuth, "exp"> | null => {
  const normalized = normalizeUsername(username);
  if (normalized === normalizeUsername(config.OWNER_USERNAME) && safeEqual(password, ownerPassword)) {
    return { username: config.OWNER_USERNAME, role: "owner" };
  }
  return adminCredentials.authenticate(username, password);
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
      typeof parsed.username !== "string" ||
      (parsed.role === "admin" && !adminCredentials.acceptsCredentialVersion(parsed.credentialVersion))
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
  if (normalizeUsername(config.ADMIN_USERNAME) === normalizeUsername(config.OWNER_USERNAME)) {
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
