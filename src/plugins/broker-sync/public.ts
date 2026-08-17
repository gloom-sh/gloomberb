import type { BrokerAdapter } from "../../types/broker";
import type { GloomPlugin } from "../../types/plugin";
import { normalizePublicSnapshot, type BrokerPortfolioSnapshot } from "./normalize";

const PUBLIC_API_URL = "https://api.public.com";

type FetchLike = typeof fetch;

function publicError(status: number, fallback: string): Error {
  if (status === 400 || status === 401 || status === 403) {
    return new Error("Public rejected the API secret. Create a new secret in Public API settings.");
  }
  return new Error(fallback);
}

async function readJson(response: Response, fallback: string): Promise<unknown> {
  if (!response.ok) throw publicError(response.status, `${fallback} Status: ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${fallback} Public returned an invalid response.`);
  }
}

async function publicRequest(
  path: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  timeoutMs = 20_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(`${PUBLIC_API_URL}${path}`, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Public took too long to respond.");
    }
    throw new Error(`Gloomberb could not reach Public. ${error instanceof Error ? error.message : ""}`.trim());
  } finally {
    clearTimeout(timer);
  }
}

export async function loadPublicPortfolio(apiSecret: string, fetchImpl: FetchLike = fetch): Promise<BrokerPortfolioSnapshot> {
  const secret = apiSecret.trim();
  if (!secret || secret.length > 2_000 || /[\u0000-\u0020\u007f]/.test(secret)) {
    throw new Error("Enter the API secret exactly as Public generated it.");
  }

  const tokenPayload = await readJson(await publicRequest(
    "/userapiauthservice/personal/access-tokens",
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ secret, validityInMinutes: 5 }),
    },
    fetchImpl,
  ), "Public could not create an access token.") as { accessToken?: unknown };
  if (typeof tokenPayload.accessToken !== "string" || !tokenPayload.accessToken) {
    throw new Error("Public did not return an access token.");
  }
  const headers = { Accept: "application/json", Authorization: `Bearer ${tokenPayload.accessToken}` };
  const accountsPayload = await readJson(await publicRequest(
    "/userapigateway/trading/account",
    { headers },
    fetchImpl,
  ), "Public could not load accounts.");
  const accountValues = (accountsPayload as { accounts?: unknown }).accounts;
  if (!Array.isArray(accountValues)) throw new Error("Public returned an invalid account list.");

  const portfolioPayloads = await Promise.all(accountValues.map(async (value) => {
    const accountId = value && typeof value === "object" && typeof (value as { accountId?: unknown }).accountId === "string"
      ? (value as { accountId: string }).accountId
      : "";
    if (!accountId) throw new Error("Public returned an account without an ID.");
    return readJson(await publicRequest(
      `/userapigateway/trading/${encodeURIComponent(accountId)}/portfolio/v2`,
      { headers },
      fetchImpl,
    ), `Public could not load account ${accountId}.`);
  }));

  return normalizePublicSnapshot(accountsPayload, portfolioPayloads);
}

export const publicBroker: BrokerAdapter = {
  id: "public",
  name: "Public",
  configSchema: [{
    key: "apiSecret",
    label: "API Secret",
    type: "password",
    required: true,
    placeholder: "Secret from Public API settings",
  }],

  async validate(instance) {
    return typeof instance.config.apiSecret === "string" && instance.config.apiSecret.trim().length > 0;
  },

  async importPositions(instance) {
    return (await loadPublicPortfolio(String(instance.config.apiSecret ?? ""))).positions;
  },

  async importPortfolioSnapshot(instance) {
    return loadPublicPortfolio(String(instance.config.apiSecret ?? ""));
  },

  async listAccounts(instance) {
    return (await loadPublicPortfolio(String(instance.config.apiSecret ?? ""))).accounts;
  },
};

export const publicPlugin: GloomPlugin = {
  id: "public",
  name: "Public",
  version: "1.0.0",
  description: "Read-only account and position sync for Public.",
  toggleable: true,
  broker: publicBroker,
};
