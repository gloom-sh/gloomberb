import { Buffer } from "node:buffer";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { PRESERVED_PASSWORD_HINT } from "../../brokers/profile-form";
import type { BrokerAdapter } from "../../types/broker";
import type { BrokerInstanceConfig } from "../../types/config";
import type { GloomPlugin } from "../../types/plugin";
import { normalizeSimpleFinSnapshot, type BrokerPortfolioSnapshot } from "./normalize";

type FetchLike = typeof fetch;

const pendingAccessUrls = new Map<string, string>();

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (/^(?:fc|fd|fe[89ab])/.test(normalized)) return true;
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 0
    || parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127)
    || parts[0]! >= 224;
}

export function decodeSimpleFinSetupToken(value: string): string {
  const token = value.replace(/\s+/g, "");
  if (!token || token.length > 12_000 || !/^[A-Za-z0-9+/_=-]+$/.test(token)) {
    throw new Error("The SimpleFIN setup token is not valid.");
  }
  try {
    const decoded = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    if (!decoded.startsWith("https://")) throw new Error("Invalid protocol");
    return decoded;
  } catch {
    throw new Error("The SimpleFIN setup token is not valid.");
  }
}

async function validateSimpleFinUrl(value: string, requireCredentials: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SimpleFIN returned an invalid URL.");
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.hash) {
    throw new Error("SimpleFIN returned an unsafe URL.");
  }
  if (requireCredentials && (!url.username || !url.password)) {
    throw new Error("SimpleFIN returned an access URL without credentials.");
  }
  if (isIP(url.hostname) && isPrivateAddress(url.hostname)) {
    throw new Error("SimpleFIN returned a private network URL.");
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("The SimpleFIN server address is not valid.");
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("SimpleFIN returned a private network URL.");
  }
  return url;
}

async function timedFetch(fetchImpl: FetchLike, url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("SimpleFIN took too long to respond.");
    }
    throw new Error(`Gloomberb could not reach SimpleFIN. ${error instanceof Error ? error.message : ""}`.trim());
  } finally {
    clearTimeout(timer);
  }
}

async function claimAccessUrl(setupToken: string, fetchImpl: FetchLike): Promise<string> {
  const claimUrl = await validateSimpleFinUrl(decodeSimpleFinSetupToken(setupToken), false);
  const response = await timedFetch(fetchImpl, claimUrl, {
    method: "POST",
    headers: { "Content-Length": "0" },
  }, 20_000);
  if (response.status === 403) {
    throw new Error("The SimpleFIN setup token was already used or is no longer valid.");
  }
  if (!response.ok) throw new Error(`SimpleFIN could not claim the setup token. Status: ${response.status}.`);
  const accessUrl = (await response.text()).trim();
  if (accessUrl.length > 8_000) throw new Error("SimpleFIN returned an invalid access URL.");
  await validateSimpleFinUrl(accessUrl, true);
  return accessUrl;
}

async function loadAccounts(accessUrl: string, fetchImpl: FetchLike): Promise<unknown> {
  const url = await validateSimpleFinUrl(accessUrl, true);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = "";
  url.password = "";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/accounts`;
  url.searchParams.set("balances-only", "1");
  url.searchParams.set("version", "2");
  const response = await timedFetch(fetchImpl, url, {
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    },
  }, 30_000);
  if (response.status === 402) throw new Error("SimpleFIN Bridge needs attention before this profile can sync.");
  if (response.status === 403) throw new Error("The SimpleFIN connection was revoked.");
  if (!response.ok) throw new Error(`SimpleFIN could not load accounts. Status: ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new Error("SimpleFIN returned an invalid accounts response.");
  }
}

async function loadSimpleFinPortfolio(
  instance: BrokerInstanceConfig,
  fetchImpl: FetchLike = fetch,
): Promise<BrokerPortfolioSnapshot> {
  let accessUrl = pendingAccessUrls.get(instance.id)
    ?? (typeof instance.config.accessUrl === "string" ? instance.config.accessUrl : "");
  if (!accessUrl) {
    const setupToken = typeof instance.config.setupToken === "string" ? instance.config.setupToken : "";
    accessUrl = await claimAccessUrl(setupToken, fetchImpl);
    pendingAccessUrls.set(instance.id, accessUrl);
  }
  return normalizeSimpleFinSnapshot(await loadAccounts(accessUrl, fetchImpl));
}

export const simpleFinBroker: BrokerAdapter = {
  id: "simplefin",
  name: "SimpleFIN",
  configSchema: [{
    key: "setupToken",
    label: "Setup Token",
    type: "password",
    required: true,
    placeholder: "One-time token from SimpleFIN Bridge",
  }],

  async validate(instance) {
    return [instance.config.setupToken, instance.config.accessUrl]
      .some((value) => typeof value === "string" && value.trim().length > 0);
  },

  async importPositions(instance) {
    return (await loadSimpleFinPortfolio(instance)).positions;
  },

  async importPortfolioSnapshot(instance) {
    return loadSimpleFinPortfolio(instance);
  },

  async listAccounts(instance) {
    return (await loadSimpleFinPortfolio(instance)).accounts;
  },

  getPersistedConfigUpdate(instance) {
    const accessUrl = pendingAccessUrls.get(instance.id);
    if (!accessUrl) return null;
    pendingAccessUrls.delete(instance.id);
    return { setupToken: "", accessUrl };
  },

  toConfigValues(instance) {
    return {
      setupToken: typeof instance.config.accessUrl === "string"
        ? PRESERVED_PASSWORD_HINT
        : instance.config.setupToken,
    };
  },

  fromConfigValues(values, previous) {
    const setupToken = typeof values.setupToken === "string" ? values.setupToken.trim() : "";
    const accessUrl = previous && typeof previous.config.accessUrl === "string" ? previous.config.accessUrl : "";
    if (setupToken === PRESERVED_PASSWORD_HINT && accessUrl) return { setupToken: "", accessUrl };
    if (setupToken) return { setupToken };
    return accessUrl ? { setupToken: "", accessUrl } : { setupToken: "" };
  },
};

export const simpleFinPlugin: GloomPlugin = {
  id: "simplefin",
  name: "SimpleFIN",
  version: "1.0.0",
  description: "Read-only investment position sync through SimpleFIN Bridge.",
  toggleable: true,
  broker: simpleFinBroker,
};
