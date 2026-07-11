import assert from "node:assert/strict";
import test from "node:test";
import { authenticateAdmin, createAdminToken, verifyAdminToken } from "./auth";
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
