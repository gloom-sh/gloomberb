import { apiClient } from "../../../api-client";
import { isAccessDenied } from "../../../api-client/errors";
import type {
  CloudFredSeriesPayload,
  CloudMarketResponse,
  CloudPricePointPayload,
  CloudQuotePayload,
} from "../../../api-client/types";
import { createPluginCache } from "../../../data/plugin-cache";
import { loadCloudResource } from "../shared/cloud-resource";
import { canonicalExchange, normalizeSymbol } from "../../../utils/exchanges";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import type { PricePoint } from "../../../types/financials";
import { resolveDatedReturns, type DatedReturn } from "./metrics";
import { qualifySharpeCadence } from "./sharpe-cadence";
import { evidenceDay } from "./risk-evidence";

export interface RiskInstrument {
  symbol: string;
  exchange: string;
}
/** A holding to load: what ranks it by value before any daily history is requested. */
export interface RiskHoldingRequest extends RiskInstrument {
  /** Signed quantity; with a USD quote it ranks the holding by current value. */
  quantity?: number;
  /** The currency the position is recorded in, for the rate that values it when it is left out. */
  currency?: string | null;
  /** USD value from the broker's own snapshot, ranking a holding no USD quote values. */
  snapshotValue?: number | null;
  /** Outside the basket model whatever its history says (a short, a derivative): quoted, never history-requested. */
  unsupported?: boolean;
}
interface RiskMarketHistory {
  instrument: RiskInstrument;
  currency: string | null;
  quote: CloudQuotePayload | null;
  returns: DatedReturn[];
  asOf: string | null;
  /** Latest completed close, used as the mark when no current quote arrived. */
  closeMark?: { price: number; date: string; currency: string } | null;
  /** The listing's own price when it does not quote in USD: it values a left-out holding, never a return. */
  listing?: { price: number; currency: string } | null;
  error: string | null;
}
export interface RiskMarketSnapshot {
  histories: RiskMarketHistory[];
  yields: CloudFredSeriesPayload | null;
  volatility: CloudFredSeriesPayload | null;
  fetchedAt: string;
  warnings: string[];
  brokerOptions?: import("./risk-options").PortfolioOptionBook;
  /** USD per unit of each listing or position currency of the holdings, at load time. */
  fxRates?: Record<string, number>;
}
/**
 * The most holdings one load requests daily history for, largest current USD
 * value first. Each holding costs one Cloud request of up to 18 months of
 * closes, four in flight, again after every two-minute cache expiry, and the
 * correlation view pairs every basket holding with every other. See
 * docs/research-data.md for the measured cost behind the number.
 */
export const RISK_HISTORY_LIMIT = 150;
/** Holdings quoted in one load, 50 to a batch request. */
const RISK_QUOTE_LIMIT = 500;
const HISTORY_CONCURRENCY = 4;
const MAX_FX_CURRENCIES = 24;
export const BEYOND_SIZE_REASON = `Beyond the supported size: only the ${RISK_HISTORY_LIMIT} largest holdings by value are modelled`;
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
export const portfolioRiskCache = createPluginCache<RiskMarketSnapshot>({
  kind: "portfolio-risk",
  source: "gloom-cloud",
  schemaVersion: 3,
  policy: { staleMs: 2 * 60_000, expireMs: 24 * 60 * 60_000 },
});
type RiskCloudClient = Pick<
  typeof apiClient,
  "getCloudHistory" | "getCloudQuotesBatch" | "getCloudFredSeries" | "getCloudExchangeRate"
>;

function validateRiskQuote(
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

/** The USD value a holding ranks by before its history loads; unknown ranks last. */
function rankValue(request: RiskHoldingRequest, quote: CloudQuotePayload | null): number {
  if (quote && request.quantity != null && Number.isFinite(request.quantity))
    return Math.abs(request.quantity * quote.price);
  const snapshot = request.snapshotValue;
  return snapshot != null && Number.isFinite(snapshot) ? Math.abs(snapshot) : -1;
}
const largestFirst = (
  left: { rank: number; order: number },
  right: { rank: number; order: number },
) => right.rank - left.rank || left.order - right.order;

/**
 * Quotes every holding, then requests daily history only for the factor
 * proxies and the largest USD holdings that can enter the basket, up to
 * RISK_HISTORY_LIMIT. Holdings that quote in another currency, positions the
 * caller marks unsupported and holdings past the limit get no history request;
 * their entry says why. The signal stops the fetch: no request starts once it
 * aborts, the ones in flight are cancelled, and the call rejects instead of
 * returning a partial snapshot nobody is waiting for.
 */
export async function fetchPortfolioRiskMarket(
  holdings: readonly RiskHoldingRequest[],
  client: RiskCloudClient = apiClient,
  now = new Date(),
  signal?: AbortSignal,
): Promise<RiskMarketSnapshot> {
  signal?.throwIfAborted();
  const normalized = (row: RiskInstrument): RiskInstrument => ({
    symbol: normalizeSymbol(row.symbol),
    exchange: canonicalExchange(row.exchange),
  });
  const factors = new Map(
    RISK_FACTOR_INSTRUMENTS.map((row) => [riskInstrumentId(row), normalized(row)]),
  );
  const entries = new Map<
    string,
    { id: string; instrument: RiskInstrument; request: RiskHoldingRequest; order: number; rank: number }
  >();
  for (const request of holdings) {
    const id = riskInstrumentId(request);
    if (!entries.has(id))
      entries.set(id, {
        id,
        instrument: normalized(request),
        request,
        order: entries.size,
        rank: rankValue(request, null),
      });
  }
  const quoted = [...entries.values()].sort(largestFirst).slice(0, RISK_QUOTE_LIMIT);
  const targets = [
    ...new Map([
      ...quoted.map((row) => [row.id, row.instrument] as const),
      ...factors,
    ]).values(),
  ];
  const quotes = new Map<string, CloudQuotePayload>();
  const listings = new Map<string, { price: number; currency: string }>();
  const warnings: string[] = [];
  for (let start = 0; start < targets.length; start += 50) {
    signal?.throwIfAborted();
    const requested = targets.slice(start, start + 50);
    try {
      const response = await client.getCloudQuotesBatch(
        requested,
        "cache-first",
        signal ? { signal } : undefined,
      );
      for (const item of response.data?.items ?? []) {
        const target = requested.find(
          (row) =>
            normalizeSymbol(row.symbol) === normalizeSymbol(item.symbol) &&
            canonicalExchange(row.exchange) ===
              canonicalExchange(item.exchange),
        );
        if (
          !target ||
          item.status !== "success" ||
          !item.data ||
          normalizeSymbol(item.data.symbol) !== normalizeSymbol(target.symbol)
        )
          continue;
        const id = riskInstrumentId(target);
        // A holding quoted in another currency never enters the USD basket;
        // its price only values what is left out.
        if (!factors.has(id) && item.data.currency && item.data.currency !== "USD") {
          if (Number.isFinite(item.data.price) && item.data.price > 0)
            listings.set(id, { price: item.data.price, currency: item.data.currency });
          continue;
        }
        try {
          validateRiskQuote(item.data, target, now);
          quotes.set(id, item.data);
        } catch (error) {
          warnings.push(`${target.symbol}: ${message(error)}`);
        }
      }
    } catch (error) {
      if (isAccessDenied(error) || signal?.aborted) throw error;
      warnings.push(`Holding marks: ${message(error)}`);
    }
  }
  const candidates = quoted
    .filter((row) => !factors.has(row.id) && !row.request.unsupported && !listings.has(row.id))
    .map((row) => ({ ...row, rank: rankValue(row.request, quotes.get(row.id) ?? null) }))
    .sort(largestFirst);
  const requestedIds = new Set([
    ...factors.keys(),
    ...candidates.slice(0, RISK_HISTORY_LIMIT).map((row) => row.id),
  ]);
  const instruments = [
    ...new Map([...factors, ...[...entries.values()].map((row) => [row.id, row.instrument] as const)]).entries(),
  ];
  const start = new Date(now);
  start.setUTCMonth(start.getUTCMonth() - 18);
  start.setUTCDate(1);
  const today = now.toISOString().slice(0, 10);
  const startDate = start.toISOString().slice(0, 10),
    endDate = new Date(Date.parse(today) - 86_400_000)
      .toISOString()
      .slice(0, 10);
  const histories: RiskMarketHistory[] = instruments.map(([id, instrument]) => {
    const quote = quotes.get(id) ?? null,
      listing = listings.get(id) ?? null;
    return {
      instrument,
      quote,
      listing,
      currency: quote?.currency ?? listing?.currency ?? null,
      returns: [],
      asOf: null,
      error: requestedIds.has(id)
        ? null
        : listing
          ? "Current USD listing identity unavailable"
          : entries.get(id)?.request.unsupported
            ? "Outside the long USD equity basket"
            : BEYOND_SIZE_REASON,
    };
  });
  const pending = instruments.flatMap(([id], index) =>
    requestedIds.has(id) ? [index] : [],
  );
  let next = 0;
  const historyWork = Promise.all(
    Array.from({ length: Math.min(HISTORY_CONCURRENCY, pending.length) }, async () => {
      while (next < pending.length) {
        signal?.throwIfAborted();
        const index = pending[next++]!,
          entry = histories[index]!,
          { instrument, quote } = entry;
        try {
          const response = await client.getCloudHistory(
            instrument.symbol,
            instrument.exchange || quote?.listingExchangeName || "",
            {
              interval: "1day",
              startDate,
              // validateRiskHistory drops today's bar; ending on yesterday
              // loses yesterday's close for most listings.
              endDate: today,
              outputsize: 1000,
              rangeKey: "2Y",
            },
            signal ? { signal } : undefined,
          );
          const resolved = validateRiskHistory(
            response,
            instrument,
            quote,
            now,
          );
          histories[index] = {
            ...entry,
            currency: quote?.currency ?? resolved.closeMark?.currency ?? null,
            ...resolved,
            error: null,
          };
        } catch (error) {
          if (isAccessDenied(error) || signal?.aborted) throw error;
          histories[index] = { ...entry, error: message(error) };
        }
      }
    }),
  );
  // Rates value left-out holdings that do not quote in USD; they never convert a return.
  const fxCurrencies = [
    ...new Set(
      [...entries.values()].flatMap((row) => {
        const currency = resolveCurrencyUnit(
          listings.get(row.id)?.currency ?? (quotes.has(row.id) ? null : row.request.currency),
        ).currency;
        return currency && currency !== "USD" ? [currency] : [];
      }),
    ),
  ].slice(0, MAX_FX_CURRENCIES);
  const [, fred, fx] = await Promise.all([
    historyWork,
    Promise.allSettled(
      ["DGS10", "VIXCLS"].map(async (id) =>
        validateFred(
          await client.getCloudFredSeries(id, {
            startDate,
            endDate,
            limit: 1000,
            sortOrder: "asc",
          }, signal ? { signal } : undefined),
          id,
        ),
      ),
    ),
    Promise.allSettled(
      fxCurrencies.map(async (currency) => {
        const response = await client.getCloudExchangeRate(currency);
        const rate = response.status === "success" || response.status === "partial"
          ? response.data?.rate
          : undefined;
        if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0)
          throw new Error(response.reasonCode ?? "Rate unavailable");
        return [currency, rate] as const;
      }),
    ),
  ]);
  signal?.throwIfAborted();
  for (const [index, result] of fred.entries()) {
    if (result.status === "rejected") {
      if (isAccessDenied(result.reason)) throw result.reason;
      warnings.push(
        `${index ? "Volatility" : "Treasury yield"}: ${message(result.reason)}`,
      );
    }
  }
  const fxRates: Record<string, number> = {};
  for (const [index, result] of fx.entries()) {
    if (result.status === "fulfilled") fxRates[result.value[0]] = result.value[1];
    else {
      if (isAccessDenied(result.reason)) throw result.reason;
      warnings.push(`${fxCurrencies[index]} exchange rate: ${message(result.reason)}`);
    }
  }
  return {
    histories,
    yields: fred[0]!.status === "fulfilled" ? fred[0]!.value : null,
    volatility: fred[1]!.status === "fulfilled" ? fred[1]!.value : null,
    fetchedAt: now.toISOString(),
    warnings,
    fxRates,
  };
}
/** What changes the requests: identity, size and whether a holding can enter the basket. */
const cacheKey = (holdings: readonly RiskHoldingRequest[]) =>
  [
    ...new Set(
      holdings.map(
        (row) => `${riskInstrumentId(row)}|${row.quantity ?? ""}|${row.currency ?? ""}|${row.unsupported ? 1 : 0}`,
      ),
    ),
  ].sort().join(",");
export async function loadPortfolioRiskMarket(
  holdings: readonly RiskHoldingRequest[],
  force = false,
) {
  const { payload, stale, refreshError } = await loadCloudResource(
    portfolioRiskCache,
    cacheKey(holdings),
    () => fetchPortfolioRiskMarket(holdings),
    { force },
  );
  return {
    ...payload,
    warnings: [
      ...payload.warnings,
      ...(stale ? ["Cached portfolio risk market observations are stale."] : []),
      ...(refreshError ? [refreshError] : []),
    ],
  };
}
