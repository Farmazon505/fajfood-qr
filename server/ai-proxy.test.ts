import assert from "node:assert/strict";
import test from "node:test";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { createAiProxyAgent } from "./ai-proxy";

test("AI proxy factory supports direct, SOCKS and HTTP connections", () => {
  assert.equal(createAiProxyAgent(""), undefined);
  assert.ok(createAiProxyAgent("socks5h://127.0.0.1:1088") instanceof SocksProxyAgent);
  assert.ok(createAiProxyAgent("http://127.0.0.1:8080") instanceof HttpsProxyAgent);
  assert.throws(() => createAiProxyAgent("ftp://127.0.0.1:21"), /Unsupported AI proxy protocol/);
});
