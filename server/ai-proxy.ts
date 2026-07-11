import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

const socksProtocols = new Set(["socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"]);

export const createAiProxyAgent = (proxyUrl: string) => {
  const value = proxyUrl.trim();
  if (!value) return undefined;

  const protocol = new URL(value).protocol.toLowerCase();
  if (socksProtocols.has(protocol)) return new SocksProxyAgent(value);
  if (protocol === "http:" || protocol === "https:") return new HttpsProxyAgent(value);

  throw new Error(`Unsupported AI proxy protocol: ${protocol}`);
};
