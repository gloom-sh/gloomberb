import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type {
  CloudFredSeriesPayload,
  CloudMarketResponse,
  CloudPricePointPayload,
  CloudQuotePayload,
} from "../../../api-client/types";
import { createPluginCache } from "../../../data/plugin-cache";
import { canonicalExchange, normalizeSymbol } from "../../../utils/exchanges";
import type { PricePoint } from "../../../types/financials";
import { resolveDatedReturns, type DatedReturn } from "./metrics";
import { qualifySharpeCadence } from "./sharpe-cadence";
import { evidenceDay } from "./risk-evidence";

export interface RiskInstrument {
  symbol: string;
  exchange: string;
}
export interface RiskMarketHistory {
  instrument: RiskInstrument;
  currency: string | null;
  quote: CloudQuotePayload | null;
  points: CloudPricePointPayload[];
  returns: DatedReturn[];
  asOf: string | null;
  /** Latest completed close, used as the mark when no current quote arrived. */
  closeMark?: { price: number; date: string; currency: string } | null;
  error: string | null;
}
export interface RiskMarketSnapshot {
  histories: RiskMarketHistory[];
  yields: CloudFredSeriesPayload | null;
  volatility: CloudFredSeriesPayload | null;
  fetchedAt: string;
  warnings: string[];
  brokerOptions?: import("./risk-options").PortfolioOptionBook;
}
// Listing venues as the quotes report them; MTUM lists on Cboe BZX, not Arca.
export const RISK_FACTOR_INSTRUMENTS: RiskInstrument[] = [
  ["SPY", "ARCA"],
  ["IWM", "ARCA"],
  ["IWD", "ARCA"],
  ["IWF", "ARCA"],
  ["MTUM", "BATS"],
  ["IEF", "ARCA"],
  ["HYG", "ARCA"],
].map(([symbol, exchange]) => ({ symbol: symbol!, exchange: exchange! }));
/** US equity venues quote only in USD, so the listing venue alone establishes currency. */
const US_LISTING_VENUES = new Set(["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS", "CBOE"]);
export const riskInstrumentId = (instrument: RiskInstrument) =>
  `${canonicalExchange(instrument.exchange)}:${normalizeSymbol(instrument.symbol)}`;
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Cloud source unavailable";
const sessionError = (error: unknown) =>
  error instanceof ApiRequestError && [401, 403].includes(error.status ?? 0);
export const portfolioRiskCache = createPluginCache<RiskMarketSnapshot>({
  kind: "portfolio-risk",
  source: "gloom-cloud",
  schemaVersion: 1,
  policy: { staleMs: 2 * 60_000, expireMs: 24 * 60 * 60_000 },
});
type RiskCloudClient = Pick<
  typeof apiClient,
  "getCloudHistory" | "getCloudQuotesBatch" | "getCloudFredSeries"
>;

export function validateRiskQuote(
  quote: CloudQuotePayload | null,
  instrument: RiskInstrument,
  now = new Date(),
): asserts quote is CloudQuotePayload {
  // A stale quote still establishes listing identity; it is not used as a mark.
  if (!quote || quote.currency !== "USD")
    throw new Error("Current USD listing identity unavailable");
  if (normalizeSymbol(quote.symbol) !== normalizeSymbol(instrument.symbol))
    throw new Error("Quote symbol differs from the requested holding");
  const exchange = canonicalExchange(
    instrument.exchange || quote.listingExchangeName || "",
  );
  if (
    !exchange ||
    (quote.listingExchangeName &&
      canonicalExchange(quote.listingExchangeName) !== exchange)
  )
    throw new Error("Quote listing differs from the requested holding");
  if (
    !Number.isFinite(quote.price) ||
    quote.price <= 0 ||
    !Number.isFinite(quote.lastUpdated) ||
    quote.lastUpdated <= 0 ||
    quote.lastUpdated > now.getTime() + 300_000 ||
    now.getTime() - quote.lastUpdated > 7 * 86_400_000
  )
    throw new Error("Current quote price or timestamp unavailable");
}

/** Daily Cloud observations, currency and listing metadata must agree before risk math. */
export function validateRiskHistory(
  response: CloudMarketResponse<CloudPricePointPayload[]>,
  instrument: RiskInstrument,
  quote: CloudQuotePayload | null,
  now = new Date(),
): {
  points: CloudPricePointPayload[];
  returns: DatedReturn[];
  asOf: string;
  closeMark: { price: number; date: string; currency: string } | null;
} {
  if (
    response.status !== "success" ||
    !Array.isArray(response.data) ||
    response.data.length < 2
  )
    throw new Error(response.reasonCode ?? "Daily history unavailable");
  // Without a current quote the history must carry its own USD identity.
  const historyCurrency =
    response.currency ??
    response.providerMeta?.currency ??
    quote?.currency ??
    (US_LISTING_VENUES.has(canonicalExchange(instrument.exchange)) ? "USD" : null);
  if (quote) validateRiskQuote(quote, instrument, now);
  else if (historyCurrency !== "USD")
    throw new Error("Current USD listing identity unavailable");
  const exchange = canonicalExchange(
    instrument.exchange || quote?.listingExchangeName || "",
  );
  if (response.stale || response.providerMeta?.stale)
    throw new Error("Daily history is stale");
  const meta = response.providerMeta;
  if (meta?.servedResolution && !["1d", "1day"].includes(meta.servedResolution))
    throw new Error("Cloud returned non-daily history");
  if (
    meta?.normalizedSymbol &&
    normalizeSymbol(meta.normalizedSymbol) !==
      normalizeSymbol(instrument.symbol)
  )
    throw new Error("History symbol differs from the requested holding");
  if (
    meta?.normalizedExchange &&
    canonicalExchange(meta.normalizedExchange) !== exchange
  )
    throw new Error("History listing differs from the requested holding");
  if (
    [response.currency, meta?.currency].some(
      (currency) => currency != null && currency !== (quote?.currency ?? historyCurrency),
    )
  )
    throw new Error("History and quote currencies differ");
  if (response.data.length > 1500)
    throw new Error("Cloud daily history exceeds the supported buffer");
  const today = now.toISOString().slice(0, 10);
  const dated = new Map<string, CloudPricePointPayload>();
  for (const row of response.data) {
    if (
      !row ||
      typeof row.date !== "string" ||
      !Number.isFinite(Date.parse(row.date)) ||
      !evidenceDay(row.date.slice(0, 10)) ||
      !Number.isFinite(row.close) ||
      row.close <= 0
    )
      throw new Error("Cloud daily history contains invalid observations");
    const date = new Date(row.date).toISOString().slice(0, 10);
    if (date >= today) continue;
    const previous = dated.get(date);
    if (
      previous &&
      (previous.date !== row.date || previous.close !== row.close)
    )
      throw new Error(
        "Cloud history contains contradictory daily observations",
      );
    dated.set(date, row);
  }
  const points = [...dated.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const last = points.at(-1)?.date.slice(0, 10);
  if (!last || Date.parse(today) - Date.parse(last) > 7 * 86_400_000)
    throw new Error("Daily history has no recent completed observation");
  const prices: PricePoint[] = points.map((point) => ({
    ...point,
    date: new Date(point.date),
  }));
  const resolved = resolveDatedReturns(prices);
  if (resolved.integrity)
    throw new Error("Daily history has inconsistent OHLC observations");
  const cadence = qualifySharpeCadence(resolved.returns, [
    { symbol: instrument.symbol, exchange, history: prices },
  ]);
  if (!cadence.supported)
    throw new Error(cadence.reason ?? "Daily session cadence unavailable");
  const lastPoint = points.at(-1)!;
  return {
    points,
    returns: resolved.returns,
    asOf: last,
    // A missing or stale quote is not a current mark; the latest dated close is.
    closeMark:
      quote && !quote.stale
        ? null
        : { price: lastPoint.close, date: last, currency: historyCurrency! },
  };
}
function validateFred(
  data: CloudFredSeriesPayload,
  id: string,
): CloudFredSeriesPayload {
  if (
    !data ||
    !Array.isArray(data.observations) ||
    data.info?.id !== id ||
    data.stale ||
    data.observations.length > 2000 ||
    new Set(data.observations.map((row) => row.date)).size !==
      data.observations.length ||
    data.observations.some(
      (row) =>
        !evidenceDay(row.date) ||
        (row.value !== null && !Number.isFinite(row.value)),
    )
  )
    throw new Error(`${id} history is unavailable or invalid`);
  if (
    (id === "DGS10" && !/percent/i.test(data.info.units)) ||
    (id === "VIXCLS" && !/index/i.test(data.info.units))
  )
    throw new Error(`${id} units are unverified`);
  return data;
}

export async function fetchPortfolioRiskMarket(
  instruments: readonly RiskInstrument[],
  client: RiskCloudClient = apiClient,
  now = new Date(),
): Promise<RiskMarketSnapshot> {
  const unique = [
    ...new Map(
      [...instruments, ...RISK_FACTOR_INSTRUMENTS].map((row) => [
        riskInstrumentId(row),
        {
          symbol: normalizeSymbol(row.symbol),
          exchange: canonicalExchange(row.exchange),
        },
      ]),
    ).values(),
  ];
  if (unique.length > 87)
    throw new Error(
      "Portfolio risk supports at most 80 holdings plus its factor proxies",
    );
  const quotes = new Map<string, CloudQuotePayload>();
  const warnings: string[] = [];
  for (let start = 0; start < unique.length; start += 50) {
    const requested = unique.slice(start, start + 50);
    try {
      const response = await client.getCloudQuotesBatch(
        requested,
        "cache-first",
      );
      for (const item of response.data?.items ?? []) {
        const target = requested.find(
          (row) =>
            normalizeSymbol(row.symbol) === normalizeSymbol(item.symbol) &&
            canonicalExchange(row.exchange) ===
              canonicalExchange(item.exchange),
        );
        if (
          target &&
          item.status === "success" &&
          item.data &&
          normalizeSymbol(item.data.symbol) === normalizeSymbol(target.symbol)
        ) {
          try {
            validateRiskQuote(item.data, target, now);
            quotes.set(riskInstrumentId(target), item.data);
          } catch (error) {
            warnings.push(`${target.symbol}: ${message(error)}`);
          }
        }
      }
    } catch (error) {
      if (sessionError(error)) throw error;
      warnings.push(`Holding marks: ${message(error)}`);
    }
  }
  const start = new Date(now);
  start.setUTCMonth(start.getUTCMonth() - 18);
  start.setUTCDate(1);
  const startDate = start.toISOString().slice(0, 10),
    endDate = new Date(Date.parse(now.toISOString().slice(0, 10)) - 86_400_000)
      .toISOString()
      .slice(0, 10);
  const histories: RiskMarketHistory[] = new Array(unique.length);
  let next = 0;
  const historyWork = Promise.all(
    Array.from({ length: Math.min(4, unique.length) }, async () => {
      while (next < unique.length) {
        const index = next++,
          instrument = unique[index]!,
          quote = quotes.get(riskInstrumentId(instrument)) ?? null;
        try {
          const response = await client.getCloudHistory(
            instrument.symbol,
            instrument.exchange || quote?.listingExchangeName || "",
            {
              interval: "1day",
              startDate,
              endDate,
              outputsize: 1000,
              rangeKey: "2Y",
            },
          );
          const resolved = validateRiskHistory(
            response,
            instrument,
            quote,
            now,
          );
          histories[index] = {
            instrument,
            quote,
            currency: quote?.currency ?? resolved.closeMark?.currency ?? null,
            ...resolved,
            error: null,
          };
        } catch (error) {
          if (sessionError(error)) throw error;
          histories[index] = {
            instrument,
            quote,
            currency: quote?.currency ?? null,
            points: [],
            returns: [],
            asOf: null,
            error: message(error),
          };
        }
      }
    }),
  );
  const [, fred] = await Promise.all([
    historyWork,
    Promise.allSettled(
      ["DGS10", "VIXCLS"].map(async (id) =>
        validateFred(
          await client.getCloudFredSeries(id, {
            startDate,
            endDate,
            limit: 1000,
            sortOrder: "asc",
          }),
          id,
        ),
      ),
    ),
  ]);
  for (const [index, result] of fred.entries()) {
    if (result.status === "rejected") {
      if (sessionError(result.reason)) throw result.reason;
      warnings.push(
        `${index ? "Volatility" : "Treasury yield"}: ${message(result.reason)}`,
      );
    }
  }
  const closeMarked = histories.filter((row) => row?.closeMark).length;
  if (closeMarked)
    warnings.push(
      `${closeMarked} instrument${closeMarked === 1 ? "" : "s"} had no current quote; holdings are weighted at the latest completed close.`,
    );
  return {
    histories,
    yields: fred[0]!.status === "fulfilled" ? fred[0]!.value : null,
    volatility: fred[1]!.status === "fulfilled" ? fred[1]!.value : null,
    fetchedAt: now.toISOString(),
    warnings,
  };
}
const cacheKey = (instruments: readonly RiskInstrument[]) =>
  [...new Set(instruments.map(riskInstrumentId))].sort().join(",");
export async function loadPortfolioRiskMarket(
  instruments: readonly RiskInstrument[],
  force = false,
) {
  const resource = await portfolioRiskCache.load(
    cacheKey(instruments),
    () => fetchPortfolioRiskMarket(instruments),
    { force },
  );
  if (sessionError(resource.error)) throw resource.error;
  return {
    ...resource.data,
    warnings: [
      ...resource.data.warnings,
      ...(resource.stale
        ? ["Cached portfolio risk market observations are stale."]
        : []),
      ...(resource.refreshError ? [resource.refreshError] : []),
    ],
  };
}
