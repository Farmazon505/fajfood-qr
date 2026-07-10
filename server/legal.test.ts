import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  MARKETING_CONSENT_TEXT,
  PERSONAL_DATA_CONSENT_HASH,
  PERSONAL_DATA_CONSENT_TEXT,
  PERSONAL_DATA_CONSENT_VERSION,
} from "./legal";

test("personal data consent has a stable evidence hash", () => {
  assert.match(PERSONAL_DATA_CONSENT_VERSION, /^\d{4}-\d{2}-\d{2}-v\d+$/);
  assert.equal(
    PERSONAL_DATA_CONSENT_HASH,
    createHash("sha256").update(PERSONAL_DATA_CONSENT_TEXT, "utf8").digest("hex"),
  );
  assert.match(PERSONAL_DATA_CONSENT_TEXT, /ИНН 055200298875/);
  assert.match(PERSONAL_DATA_CONSENT_TEXT, /отзыва/);
});

test("marketing consent is separate and voluntary", () => {
  assert.match(MARKETING_CONSENT_TEXT, /не требуется для участия/);
});
