import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { CryptoMarketAsset, CryptoMarketsPayload } from "../../../api-client/crypto-markets";
import { createPluginCache } from "../../../data/plugin-cache";

export const cryptoMarketsCache = createPluginCache<CryptoMarketsPayload>({
  kind: "crypto-markets",
  source: "gloom-cloud",
  schemaVersion: 1,
  policy: { staleMs: 30_000, expireMs: 86_400_000 },
});

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nullableNumber = (value: unknown) => value === null || finite(value);
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const nullableInstant = (value: unknown) => value === null || instant(value);
const date = (value: unknown): value is string =>
  typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function validAsset(asset: CryptoMarketAsset): boolean {
  return (
    !!asset
    && typeof asset.symbol === "string"
    && /^[A-Z0-9]+-USD$/.test(asset.symbol)
    && typeof asset.code === "string"
    && asset.code.length > 0
    && typeof asset.name === "string"
    && (asset.kind === "coin" || asset.kind === "stablecoin")
    && Number.isInteger(asset.rank)
    && asset.rank > 0
    && finite(asset.price)
    && asset.price > 0
    && [
      asset.previousClose,
      asset.change,
      asset.changePercent,
      asset.dayHigh,
      asset.dayLow,
      asset.volume24h,
      asset.marketCap,
      asset.circulatingSupply,
      asset.maxSupply,
      asset.high52w,
      asset.low52w,
      asset.yearAgoPrice,
    ].every(nullableNumber)
    && nullableInstant(asset.quoteTime)
    && (asset.history === null
      || (!!asset.history
        && date(asset.history.start)
        && Array.isArray(asset.history.closes)
        && asset.history.closes.length <= 400
        && asset.history.closes.every((close) => close === null || (finite(close) && close > 0))))
  );
}

export function validateCryptoMarkets(data: CryptoMarketsPayload): CryptoMarketsPayload {
  if (
    !data
    || data.version !== 1
    || !instant(data.generatedAt)
    || !nullableInstant(data.asOf)
    || !["available", "partial", "unavailable"].includes(data.status)
    || !data.source
    || typeof data.source.name !== "string"
    || typeof data.source.url !== "string"
    || !Array.isArray(data.assets)
    || data.assets.length > 500
    || !data.assets.every(validAsset)
    || new Set(data.assets.map((asset) => asset.symbol)).size !== data.assets.length
    || !Array.isArray(data.warnings)
    || data.warnings.some((warning) => typeof warning !== "string")
  ) {
    throw new Error("Gloom Cloud returned an invalid crypto board");
  }
  return data;
}

export async function fetchCryptoMarkets(
  client: Pick<typeof apiClient, "getCloudCryptoMarkets"> = apiClient,
): Promise<CryptoMarketsPayload> {
  try {
    return validateCryptoMarkets(await client.getCloudCryptoMarkets());
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) {
      throw new Error("Crypto markets are not available on this Gloom Cloud server yet");
    }
    if (error instanceof ApiRequestError && error.status === 503) {
      throw new Error("Crypto prices are temporarily unavailable");
    }
    throw error;
  }
}

export interface CryptoMarketsResource {
  payload: CryptoMarketsPayload;
  stale: boolean;
  refreshError: string | null;
}

export function cachedCryptoMarkets(): CryptoMarketsResource | null {
  const cached = cryptoMarketsCache.get("usd", { allowExpired: true });
  if (!cached) return null;
  try {
    return { payload: validateCryptoMarkets(cached.data), stale: cached.stale, refreshError: null };
  } catch {
    return null;
  }
}

export async function loadCryptoMarkets(force = false): Promise<CryptoMarketsResource> {
  const result = await cryptoMarketsCache.load("usd", () => fetchCryptoMarkets(), { force });
  if (result.error instanceof ApiRequestError && [401, 403].includes(result.error.status ?? 0)) {
    throw result.error;
  }
  return {
    payload: validateCryptoMarkets(result.data),
    stale: result.stale,
    refreshError: result.refreshError ?? null,
  };
}
