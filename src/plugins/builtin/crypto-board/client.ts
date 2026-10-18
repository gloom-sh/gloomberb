import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { CryptoMarketAsset, CryptoMarketsPayload } from "../../../api-client/crypto-markets";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";
import { isFiniteNumber } from "../../../utils/guards";

export const cryptoMarketsCache = createPluginCache<CryptoMarketsPayload>({
  kind: "crypto-markets",
  source: "gloom-cloud",
  schemaVersion: 1,
  // Stale before the pane's 15-second refresh, so every tick fetches.
  policy: { staleMs: 10_000, expireMs: 86_400_000 },
});

const nullableNumber = (value: unknown) => value === null || isFiniteNumber(value);
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
    && isFiniteNumber(asset.price)
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
        && asset.history.closes.every((close) => close === null || (isFiniteNumber(close) && close > 0))))
  );
}

const validPeg = (peg: CryptoMarketAsset["peg"]) =>
  !!peg
  && typeof peg.currency === "string"
  && /^[A-Z]{3}$/.test(peg.currency)
  && typeof peg.accrues === "boolean"
  && (peg.price === null || (isFiniteNumber(peg.price) && peg.price > 0))
  && nullableInstant(peg.asOf);

const validRange = (range: CryptoMarketAsset["range24h"]) =>
  !!range
  && [range.low, range.high].every((value) => isFiniteNumber(value) && value > 0)
  && [range.lowAt, range.highAt, range.start, range.end].every(instant);

/** A malformed peg or 24h range is dropped from its coin alone; the coin and the rest of the board stay. */
function withValidStablecoinFields(asset: CryptoMarketAsset): CryptoMarketAsset {
  const peg = asset.peg != null && !validPeg(asset.peg);
  const range = asset.range24h != null && !validRange(asset.range24h);
  if (!peg && !range) return asset;
  return { ...asset, ...(peg ? { peg: null } : {}), ...(range ? { range24h: null } : {}) };
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
    throw new Error("The server returned an invalid crypto board");
  }
  const assets = data.assets.map(withValidStablecoinFields);
  return assets.every((asset, index) => asset === data.assets[index]) ? data : { ...data, assets };
}

export async function fetchCryptoMarkets(
  client: Pick<typeof apiClient, "getCloudCryptoMarkets"> = apiClient,
): Promise<CryptoMarketsPayload> {
  try {
    return validateCryptoMarkets(await client.getCloudCryptoMarkets());
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 503) {
      throw new Error("Crypto prices are temporarily unavailable");
    }
    throw unavailableOnServer(error, "Crypto markets are not available yet.");
  }
}

export function cachedCryptoMarkets() {
  return cachedCloudResource(cryptoMarketsCache, "usd", validateCryptoMarkets);
}

export function loadCryptoMarkets(force = false) {
  return loadCloudResource(cryptoMarketsCache, "usd", () => fetchCryptoMarkets(), { force, validate: validateCryptoMarkets });
}
