import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { validateTelegramInitData } from "./staff-auth";

const signedInitData = (token: string, authDate: number) => {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "query-1",
    user: JSON.stringify({ id: 10001, first_name: "Анна", username: "anna" }),
  });
  const dataCheckString = Array.from(params.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secretKey).update(dataCheckString).digest("hex"));
  return params.toString();
};

test("validates signed Telegram Mini App data", () => {
  const now = 1_800_000_000;
  const value = validateTelegramInitData(signedInitData("bot-token", now - 15), "bot-token", { now });
  assert.equal(value?.id, "10001");
  assert.equal(value?.firstName, "Анна");
});

test("rejects forged and expired Telegram Mini App data", () => {
  const now = 1_800_000_000;
  assert.equal(validateTelegramInitData(signedInitData("other-token", now), "bot-token", { now }), null);
  assert.equal(
    validateTelegramInitData(signedInitData("bot-token", now - 90_000), "bot-token", { now }),
    null
  );
});
