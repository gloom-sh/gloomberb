import { YahooHttpClient } from "../../../sources/yahoo-finance/http";
import { httpFetch, type HttpFetchTransport } from "../../../utils/http-transport";

export const MARKET_HEATMAP_UNIVERSES = [
  { id: "us-equity", label: "US Stocks", yahooQuoteType: "EQUITY", sortField: "intradaymarketcap", sizeField: "intradaymarketcap", minSize: 1_000_000_000 },
  { id: "us-etf", label: "US ETFs", yahooQuoteType: "ETF", sortField: "fundnetassets", sizeField: "fundnetassets", minSize: 1_000_000_000 },
] as const;

export type MarketHeatmapUniverseId = typeof MARKET_HEATMAP_UNIVERSES[number]["id"];
export type MarketHeatmapSource = "yahoo" | "nasdaq";
export type MarketHeatmapSizeKind = "market-cap" | "net-assets";

export interface MarketHeatmapAsset {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  /**
   * Whether the source actually carried a session change. `changePercent` keeps
   * a numeric 0 for the shared screener row shape, so tiles must read this
   * before showing a flat session that was really missing data.
   */
  hasChange: boolean;
  size: number | null;
  sizeKind: MarketHeatmapSizeKind;
  volume: number | null;
  currency: string;
  exchange: string;
  sector: string | null;
  industry: string | null;
  marketState: string | null;
  source: MarketHeatmapSource;
}

export interface MarketHeatmapResult {
  universe: MarketHeatmapUniverseId;
  source: MarketHeatmapSource;
  fetchedAt: number;
  assets: MarketHeatmapAsset[];
}

export interface MarketHeatmapFetchOptions {
  count?: number;
  forceRefresh?: boolean;
  cache?: boolean;
}

export interface YahooMarketHeatmapClient {
  postJsonWithCrumb<T>(url: string, body: unknown): Promise<T>;
}

export type MarketHeatmapFetchTransport = HttpFetchTransport;

export interface MarketHeatmapSources {
  yahooClient?: YahooMarketHeatmapClient;
  nasdaqFetch?: MarketHeatmapFetchTransport;
}

const YAHOO_SCREENER_URL = "https://query1.finance.yahoo.com/v1/finance/screener?lang=en-US&region=US&formatted=false&corsDomain=finance.yahoo.com";
const NASDAQ_SCREENER_URL = "https://api.nasdaq.com/api/screener/stocks";
const DEFAULT_COUNT = 80;
const CACHE_TTL_MS = 60_000;
const defaultYahooClient = new YahooHttpClient();
const activeFetches = new Map<string, Promise<MarketHeatmapResult>>();
const memoryCache = new Map<string, { expiresAt: number; result: MarketHeatmapResult }>();

const NASDAQ_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  Accept: "application/json,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://www.nasdaq.com",
  Referer: "https://www.nasdaq.com/",
};

function universeSpec(universe: MarketHeatmapUniverseId) {
  return MARKET_HEATMAP_UNIVERSES.find((entry) => entry.id === universe) ?? MARKET_HEATMAP_UNIVERSES[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseLooseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "N/A" || trimmed === "--") return null;
  const negative = trimmed.startsWith("(") && trimmed.endsWith(")");
  const parsed = Number(trimmed.replace(/[$,%(),]/g, ""));
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function sizeKindForUniverse(universe: MarketHeatmapUniverseId): MarketHeatmapSizeKind {
  return universe === "us-etf" ? "net-assets" : "market-cap";
}

function buildYahooScreenerBody(universe: MarketHeatmapUniverseId, count: number): unknown {
  const spec = universeSpec(universe);
  return {
    size: count,
    offset: 0,
    sortField: spec.sortField,
    sortType: "DESC",
    quoteType: spec.yahooQuoteType,
    topOperator: "AND",
    query: {
      operator: "AND",
      operands: [
        { operator: "EQ", operands: ["region", "us"] },
        { operator: "EQ", operands: ["quoteType", spec.yahooQuoteType] },
        { operator: "GT", operands: [spec.sizeField, spec.minSize] },
      ],
    },
    userId: "",
    userIdType: "guid",
  };
}

export function parseYahooMarketHeatmapResponse(data: unknown, universe: MarketHeatmapUniverseId): MarketHeatmapAsset[] {
  if (!isRecord(data)) return [];
  const finance = isRecord(data.finance) ? data.finance : null;
  const results = Array.isArray(finance?.result) ? finance.result : [];
  const first = isRecord(results[0]) ? results[0] : null;
  const quotes = Array.isArray(first?.quotes) ? first.quotes : [];
  const sizeKind = sizeKindForUniverse(universe);
  const assets: MarketHeatmapAsset[] = [];

  for (const quote of quotes) {
    if (!isRecord(quote)) continue;
    const symbol = getString(quote, "symbol");
    if (!symbol) continue;
    const size = sizeKind === "net-assets"
      ? getNumber(quote, "netAssets") ?? getNumber(quote, "fundNetAssets")
      : getNumber(quote, "marketCap") ?? getNumber(quote, "intradayMarketCap");
    const price = getNumber(quote, "regularMarketPrice") ?? 0;
    const change = getNumber(quote, "regularMarketChange") ?? 0;
    const changePercentValue = getNumber(quote, "regularMarketChangePercent");

    assets.push({
      symbol,
      name: getString(quote, "shortName") ?? getString(quote, "longName") ?? getString(quote, "displayName") ?? symbol,
      price,
      change,
      changePercent: changePercentValue ?? 0,
      hasChange: changePercentValue != null,
      size,
      sizeKind,
      volume: getNumber(quote, "regularMarketVolume"),
      currency: getString(quote, "currency") ?? "USD",
      exchange: getString(quote, "fullExchangeName") ?? getString(quote, "exchange") ?? "",
      sector: getString(quote, "sector"),
      industry: getString(quote, "industry"),
      marketState: getString(quote, "marketState"),
      source: "yahoo",
    });
  }

  return assets;
}

export function parseNasdaqMarketHeatmapResponse(data: unknown): MarketHeatmapAsset[] {
  if (!isRecord(data)) return [];
  const dataNode = isRecord(data.data) ? data.data : null;
  const rows = Array.isArray(dataNode?.rows) ? dataNode.rows : [];
  const assets: MarketHeatmapAsset[] = [];

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const symbol = getString(row, "symbol");
    if (!symbol) continue;
    const size = parseLooseNumber(row.marketCap);
    if (size == null || size <= 0) continue;
    const price = parseLooseNumber(row.lastsale) ?? 0;
    const changePercentValue = parseLooseNumber(row.pctchange);

    assets.push({
      symbol,
      name: getString(row, "name") ?? symbol,
      price,
      change: parseLooseNumber(row.netchange) ?? 0,
      changePercent: changePercentValue ?? 0,
      hasChange: changePercentValue != null,
      size,
      sizeKind: "market-cap",
      volume: parseLooseNumber(row.volume),
      currency: "USD",
      exchange: getString(row, "exchange") ?? "",
      sector: getString(row, "sector"),
      industry: getString(row, "industry"),
      marketState: null,
      source: "nasdaq",
    });
  }

  return assets.sort((left, right) => (right.size ?? 0) - (left.size ?? 0));
}

async function fetchYahooMarketHeatmap(
  universe: MarketHeatmapUniverseId,
  count: number,
  client: YahooMarketHeatmapClient,
): Promise<MarketHeatmapAsset[]> {
  const data = await client.postJsonWithCrumb<unknown>(YAHOO_SCREENER_URL, buildYahooScreenerBody(universe, count));
  return parseYahooMarketHeatmapResponse(data, universe);
}

async function fetchNasdaqMarketHeatmap(count: number, transport: MarketHeatmapFetchTransport): Promise<MarketHeatmapAsset[]> {
  const url = new URL(NASDAQ_SCREENER_URL);
  url.searchParams.set("tableonly", "true");
  url.searchParams.set("limit", "10000");
  url.searchParams.set("offset", "0");
  url.searchParams.set("download", "true");

  const response = await transport(url.toString(), {
    headers: NASDAQ_HEADERS,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`[${response.status}] Nasdaq screener unavailable`);
  }

  const data = await response.json();
  return parseNasdaqMarketHeatmapResponse(data).slice(0, count);
}

async function loadMarketHeatmap(
  universe: MarketHeatmapUniverseId,
  count: number,
  sources?: MarketHeatmapSources,
): Promise<MarketHeatmapResult> {
  const yahooClient = sources?.yahooClient ?? defaultYahooClient;
  const nasdaqFetch = sources?.nasdaqFetch ?? httpFetch;
  let yahooError: unknown;

  try {
    const assets = await fetchYahooMarketHeatmap(universe, count, yahooClient);
    if (assets.length > 0) {
      return { universe, source: "yahoo", fetchedAt: Date.now(), assets: assets.slice(0, count) };
    }
  } catch (error) {
    yahooError = error;
  }

  if (universe === "us-equity") {
    const assets = await fetchNasdaqMarketHeatmap(count, nasdaqFetch);
    return { universe, source: "nasdaq", fetchedAt: Date.now(), assets };
  }

  throw yahooError instanceof Error
    ? yahooError
    : new Error("Market heatmap unavailable");
}

export async function fetchMarketHeatmap(
  universe: MarketHeatmapUniverseId,
  options?: MarketHeatmapFetchOptions,
  sources?: MarketHeatmapSources,
): Promise<MarketHeatmapResult> {
  const count = Math.max(1, Math.min(160, Math.round(options?.count ?? DEFAULT_COUNT)));
  const cacheKey = `${universe}:${count}`;
  const useCache = options?.cache !== false && !sources?.yahooClient && !sources?.nasdaqFetch;
  const now = Date.now();
  const cached = memoryCache.get(cacheKey);
  if (useCache && !options?.forceRefresh && cached && cached.expiresAt > now) {
    return cached.result;
  }

  if (useCache) {
    const active = activeFetches.get(cacheKey);
    if (active) return active;
  }

  const fetchPromise = loadMarketHeatmap(universe, count, sources)
    .then((result) => {
      if (useCache) {
        memoryCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
      }
      return result;
    })
    .finally(() => {
      if (activeFetches.get(cacheKey) === fetchPromise) {
        activeFetches.delete(cacheKey);
      }
    });

  if (useCache) activeFetches.set(cacheKey, fetchPromise);
  return fetchPromise;
}

export function resetMarketHeatmapCache(): void {
  activeFetches.clear();
  memoryCache.clear();
}
