import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type {
  CryptoMarketAsset,
  CryptoMarketsPayload,
  StablecoinSupplyHistoryPayload,
  StablecoinSupplyPayload,
} from "../../../api-client/crypto-markets";
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

const DAY_MS = 86_400_000;
/** How many UTC days old a coin's latest daily close may be for its previous close to stand, as Gloom Cloud judges a coin quote's. */
const PREVIOUS_CLOSE_MAX_AGE_DAYS = 2;

/**
 * A coin of a board from before Gloom Cloud measured its moves since 00:00
 * UTC (a server not yet updated, a copy cached from one), whose change runs
 * over the screener's 24 hours: moved from its previous close instead, the
 * close of its last UTC day while its daily closes reach the last two days.
 * Otherwise that close may be weeks old (Toncoin on 18 Oct 2026), and the
 * coin has no move.
 */
function onUtcDayBasis(asset: CryptoMarketAsset, now: number): CryptoMarketAsset {
  const history = asset.history;
  const last = history?.closes.findLastIndex((close) => close != null) ?? -1;
  const lastDay = history && last >= 0 ? Date.parse(`${history.start}T00:00:00Z`) / DAY_MS + last : null;
  const holds = lastDay != null && asset.previousClose != null && asset.previousClose > 0
    && Math.floor(now / DAY_MS) - lastDay <= PREVIOUS_CLOSE_MAX_AGE_DAYS;
  const change = holds ? asset.price - asset.previousClose! : null;
  return {
    ...asset,
    previousClose: holds ? asset.previousClose : null,
    change,
    changePercent: change != null ? (change / asset.previousClose!) * 100 : null,
  };
}

export function validateCryptoMarkets(data: CryptoMarketsPayload, now = Date.now()): CryptoMarketsPayload {
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
  const legacy = data.dayChangeBasis !== "utc-day";
  const assets = data.assets.map((asset) => {
    const valid = withValidStablecoinFields(asset);
    return legacy ? onUtcDayBasis(valid, now) : valid;
  });
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

// Stablecoin supply ------------------------------------------------------------

const stablecoinSupplyCache = createPluginCache<StablecoinSupplyPayload>({
  kind: "stablecoin-supply",
  source: "gloom-cloud",
  schemaVersion: 1,
  // The server reads the source once a UTC day; a month-old copy still dates itself.
  policy: { staleMs: 30 * 60_000, expireMs: 30 * 86_400_000 },
});

const stablecoinSupplyHistoryCache = createPluginCache<StablecoinSupplyHistoryPayload>({
  kind: "stablecoin-supply-history",
  source: "gloom-cloud",
  schemaVersion: 1,
  policy: { staleMs: 30 * 60_000, expireMs: 30 * 86_400_000 },
});

export const STABLECOIN_SUPPLY_CACHES = [stablecoinSupplyCache, stablecoinSupplyHistoryCache] as const;

const MAX_SUPPLY_DAYS = 20_000;
const supplyValues = (values: unknown) =>
  Array.isArray(values) && values.length <= MAX_SUPPLY_DAYS && values.every((value) => value === null || (isFiniteNumber(value) && value >= 0));
const nullableString = (value: unknown) => value === null || typeof value === "string";
const supplyStatus = (value: unknown) => value === "available" || value === "stale" || value === "unavailable";

export function validateStablecoinSupply(data: StablecoinSupplyPayload): StablecoinSupplyPayload {
  const history = data?.history;
  if (
    !data
    || data.version !== 1
    || !instant(data.generatedAt)
    || !nullableInstant(data.fetchedAt)
    || !(data.asOf === null || date(data.asOf))
    || !supplyStatus(data.status)
    || (data.total !== null && (
      !data.total
      || !isFiniteNumber(data.total.supply)
      || ![data.total.change7d, data.total.change7dPercent, data.total.change30d, data.total.change30dPercent].every(nullableNumber)
    ))
    || !Array.isArray(data.coins)
    || data.coins.length > 500
    || !data.coins.every((coin) => !!coin
      && typeof coin.symbol === "string"
      && coin.symbol.length > 0
      && typeof coin.name === "string"
      && typeof coin.pegType === "string"
      && nullableString(coin.pegMechanism)
      && isFiniteNumber(coin.supply)
      && coin.supply >= 0
      && [coin.price, coin.change7d, coin.change7dPercent, coin.change30d, coin.change30dPercent, coin.share].every(nullableNumber))
    || (history !== null && (
      !history
      || !date(history.start)
      || !supplyValues(history.total)
      || !Array.isArray(history.coins)
      || history.coins.length > 20
      || !history.coins.every((coin) => !!coin
        && typeof coin.symbol === "string"
        && typeof coin.name === "string"
        && supplyValues(coin.values)
        && coin.values.length === history.total.length)
    ))
    || !Array.isArray(data.warnings)
    || data.warnings.some((warning) => typeof warning !== "string")
  ) {
    throw new Error("The server returned invalid stablecoin supply");
  }
  return data;
}

function validateStablecoinSupplyHistory(data: StablecoinSupplyHistoryPayload): StablecoinSupplyHistoryPayload {
  if (
    !data
    || data.version !== 1
    || !instant(data.generatedAt)
    || !(data.asOf === null || date(data.asOf))
    || !supplyStatus(data.status)
    || typeof data.symbol !== "string"
    || typeof data.name !== "string"
    || (data.history !== null && (!data.history || !date(data.history.start) || !supplyValues(data.history.values)))
    || !Array.isArray(data.warnings)
  ) {
    throw new Error("The server returned invalid stablecoin supply history");
  }
  return data;
}

function supplyError(error: unknown, what: string): unknown {
  if (error instanceof ApiRequestError && error.status === 503) return new Error(`${what} is temporarily unavailable`);
  return unavailableOnServer(error, `${what} is not available yet.`);
}

export async function fetchStablecoinSupply(
  client: Pick<typeof apiClient, "getCloudStablecoinSupply"> = apiClient,
): Promise<StablecoinSupplyPayload> {
  try {
    return validateStablecoinSupply(await client.getCloudStablecoinSupply());
  } catch (error) {
    throw supplyError(error, "Stablecoin supply");
  }
}

export function cachedStablecoinSupply() {
  return cachedCloudResource(stablecoinSupplyCache, "all", validateStablecoinSupply);
}

export function loadStablecoinSupply(force = false) {
  return loadCloudResource(stablecoinSupplyCache, "all", () => fetchStablecoinSupply(), { force, validate: validateStablecoinSupply });
}

/** One listed stablecoin's daily supply, by its symbol (USDT). */
export function loadStablecoinSupplyHistory(symbol: string) {
  const key = symbol.trim().toUpperCase();
  return loadCloudResource(stablecoinSupplyHistoryCache, key, async () => {
    try {
      return validateStablecoinSupplyHistory(await apiClient.getCloudStablecoinSupplyHistory(key));
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) throw new Error(`No stablecoin supply series for ${key}: it is not among the stablecoins CRYP lists.`);
      throw supplyError(error, `${key} supply history`);
    }
  }, { validate: validateStablecoinSupplyHistory });
}
