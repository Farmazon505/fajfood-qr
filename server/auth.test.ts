import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AdminCredentialManager, authenticateAdmin, createAdminToken, verifyAdminToken } from "./auth";
import { config } from "./config";

test("admin and owner receive different authorization roles", () => {
  const admin = authenticateAdmin(config.ADMIN_USERNAME, config.ADMIN_PASSWORD);
  const owner = authenticateAdmin(config.OWNER_USERNAME, config.OWNER_PASSWORD || config.ADMIN_PASSWORD);
  assert.equal(admin?.role, "admin");
  assert.equal(owner?.role, "owner");
  assert.equal(verifyAdminToken(createAdminToken(admin!))?.role, "admin");
  assert.equal(verifyAdminToken(createAdminToken(owner!))?.role, "owner");
  assert.equal(authenticateAdmin(config.ADMIN_USERNAME, "wrong-password"), null);
});

test("administrator credentials are hashed, persisted and replace previous access", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qrnastol-admin-auth-"));
  try {
    const manager = new AdminCredentialManager(directory, "admin", "initial-password");
    await manager.initialize();
    const initialAuth = manager.authenticate("ADMIN", "initial-password");
    assert.equal(initialAuth?.role, "admin");

    const previousVersion = initialAuth?.credentialVersion;
    const summary = await manager.update("restaurant-admin", "new-secure-password");
    assert.equal(summary.username, "restaurant-admin");
    assert.equal(manager.authenticate("admin", "initial-password"), null);
    assert.equal(manager.acceptsCredentialVersion(previousVersion), false);
    assert.equal(manager.authenticate("restaurant-admin", "new-secure-password")?.role, "admin");

    const storedFile = await readFile(path.join(directory, "admin-credentials.json"), "utf8");
    assert.doesNotMatch(storedFile, /initial-password|new-secure-password/);

    const reloaded = new AdminCredentialManager(directory, "fallback", "fallback-password");
    await reloaded.initialize();
    assert.equal(reloaded.authenticate("restaurant-admin", "new-secure-password")?.role, "admin");
    assert.equal(reloaded.authenticate("fallback", "fallback-password"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
