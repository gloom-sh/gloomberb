import type { TimeRange } from "../../time-series/range";
import { subtractTimeRange } from "../../time-series/date-window";
import { verifiedPriceHistorySource } from "../history-coverage";
import type {
  OptionsChain,
  PricePoint,
  Quote,
  TickerFinancials,
} from "../../types/financials";
import {
  type CloudFinancialsPayload,
  type CloudMarketBatchItem,
  type CloudMarketResponse,
  type CloudOptionsChainPayload,
  type CloudPricePointPayload,
  type CloudQuotePayload,
} from "../../api-client";
import { normalizePriceValueByDivisor, resolveCurrencyUnit } from "../../utils/currency-units";
import { resolveExchangeTimeZone } from "../../utils/exchanges";
import { createProviderMiss } from "../provider-errors";
import { reconcileQuoteDayRange } from "../../market-data/quotes/day-range";
import { redactUnavailableFundamentals } from "../../utils/fundamentals";
import { retractKnownCloudValuation } from "./valuation-observations";
import { withdrawKnownProviderStatements } from "../../utils/statement-observations";
import { hasShopOperatingIdentity, normalizeFinancialOperatingResults } from "../../utils/operating-result";

export const GLOOMBERB_CLOUD_PROVIDER_ID = "gloomberb-cloud" as const;

export type CloudProviderMeta = NonNullable<
  CloudMarketResponse<unknown>["providerMeta"]
>;

function cloudInternalProviderId(providerMeta?: CloudProviderMeta): string | null {
  const upstream = providerMeta?.provider ?? providerMeta?.upstream;
  return upstream ? `${GLOOMBERB_CLOUD_PROVIDER_ID}:${upstream}` : null;
}

export function mapQuote(
  quote: CloudQuotePayload,
  providerMeta?: CloudProviderMeta,
): Quote {
  const { currency, divisor } = resolveCurrencyUnit(quote.currency);
  const listingExchangeName = quote.listingExchangeName ?? quote.exchangeName;
  const listingExchangeFullName =
    quote.listingExchangeFullName ??
    quote.fullExchangeName ??
    listingExchangeName;
  const internalProviderId = cloudInternalProviderId(providerMeta);
  const change = typeof quote.change === "number" && Number.isFinite(quote.change)
    ? quote.change / divisor
    : Number.NaN;
  const changePercent = typeof quote.changePercent === "number" && Number.isFinite(quote.changePercent)
    ? quote.changePercent
    : Number.NaN;
  return withoutUndefinedFields(reconcileQuoteDayRange({
    ...quote,
    currency: currency || quote.currency,
    price: normalizePriceValueByDivisor(quote.price, divisor) ?? quote.price,
    change,
    changePercent,
    previousClose: normalizePriceValueByDivisor(quote.previousClose, divisor),
    regularClose: normalizePriceValueByDivisor(quote.regularClose, divisor),
    high52w: normalizePriceValueByDivisor(quote.high52w, divisor),
    low52w: normalizePriceValueByDivisor(quote.low52w, divisor),
    bid: normalizePriceValueByDivisor(quote.bid, divisor),
    ask: normalizePriceValueByDivisor(quote.ask, divisor),
    open: normalizePriceValueByDivisor(quote.open, divisor),
    high: normalizePriceValueByDivisor(quote.high, divisor),
    low: normalizePriceValueByDivisor(quote.low, divisor),
    mark: normalizePriceValueByDivisor(quote.mark, divisor),
    lastTradePrice: normalizePriceValueByDivisor(quote.lastTradePrice, divisor),
    preMarketPrice: normalizePriceValueByDivisor(quote.preMarketPrice, divisor),
    preMarketChange: normalizePriceValueByDivisor(
      quote.preMarketChange,
      divisor,
    ),
    postMarketPrice: normalizePriceValueByDivisor(
      quote.postMarketPrice,
      divisor,
    ),
    postMarketChange: normalizePriceValueByDivisor(
      quote.postMarketChange,
      divisor,
    ),
    listingExchangeName,
    listingExchangeFullName,
    exchangeName: listingExchangeName,
    fullExchangeName: listingExchangeFullName,
    providerId: GLOOMBERB_CLOUD_PROVIDER_ID,
    provenance: internalProviderId
      ? {
          ...quote.provenance,
          price: {
            providerId: internalProviderId,
            dataSource: quote.dataSource,
          },
          session: {
            providerId: internalProviderId,
            dataSource: quote.dataSource,
          },
          routing: {
            providerId: GLOOMBERB_CLOUD_PROVIDER_ID,
            dataSource: quote.dataSource,
          },
          fields: {
            ...quote.provenance?.fields,
            cloudProvider: {
              providerId: internalProviderId,
              dataSource: quote.dataSource,
            },
            ...(providerMeta?.fallbackReason
              ? { fallbackReason: { providerId: providerMeta.fallbackReason } }
              : {}),
          },
        }
      : quote.provenance,
  }));
}

/**
 * JSON has no undefined, so a field the server left out must stay absent here
 * too; the desktop window only ever sees the JSON form. Whether an omitted
 * field keeps the earlier value is decided when contributions merge: the
 * 52-week range and name carry over, a close or volume from another trading
 * day does not.
 */
function withoutUndefinedFields<T extends object>(value: T): T {
  const result = {} as T;
  for (const key in value) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
}

const LOCAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?)?$/;
const EXPLICIT_TIME_ZONE_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function getZonedDateParts(date: Date, timeZone: string): Map<string, string> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = new Map<string, string>();
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts.set(part.type, part.value);
  }
  return parts;
}

function getTimeZoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = getZonedDateParts(new Date(utcMs), timeZone);
  const zonedAsUtcMs = Date.UTC(
    Number(parts.get("year")),
    Number(parts.get("month")) - 1,
    Number(parts.get("day")),
    Number(parts.get("hour")),
    Number(parts.get("minute")),
    Number(parts.get("second")),
  );
  return zonedAsUtcMs - utcMs;
}

function exchangeLocalDateTimeToUtc(
  match: RegExpMatchArray,
  timeZone: string,
): Date {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? "0");
  const minute = Number(match[5] ?? "0");
  const second = Number(match[6] ?? "0");
  const localAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = getTimeZoneOffsetMs(localAsUtcMs, timeZone);
  const firstUtcMs = localAsUtcMs - firstOffset;
  const verifiedOffset = getTimeZoneOffsetMs(firstUtcMs, timeZone);
  return new Date(localAsUtcMs - verifiedOffset);
}

function parseCloudPricePointDate(
  value: Date | string | number,
  exchange: string,
): Date {
  if (value instanceof Date || typeof value === "number") return new Date(value);
  if (EXPLICIT_TIME_ZONE_PATTERN.test(value)) return new Date(value);

  const match = value.match(LOCAL_DATE_TIME_PATTERN);
  if (!match) return new Date(value);

  const hasTime = match[4] !== undefined;
  if (!hasTime) {
    return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  }

  const timeZone = resolveExchangeTimeZone(exchange);
  return timeZone ? exchangeLocalDateTimeToUtc(match, timeZone) : new Date(value);
}

export function mapPricePoint(
  point: CloudPricePointPayload,
  divisor = 1,
  exchange = "",
): PricePoint {
  return {
    date: parseCloudPricePointDate(point.date, exchange),
    ...(verifiedPriceHistorySource(point.historySource) ? { historySource: verifiedPriceHistorySource(point.historySource) } : {}),
    open: normalizePriceValueByDivisor(point.open, divisor),
    high: normalizePriceValueByDivisor(point.high, divisor),
    low: normalizePriceValueByDivisor(point.low, divisor),
    close: normalizePriceValueByDivisor(point.close, divisor) ?? point.close,
    volume: point.volume,
  };
}

export function mapCloudFinancials(
  financials: CloudFinancialsPayload,
  providerMeta?: CloudProviderMeta,
  target?: { symbol: string; exchange?: string },
): TickerFinancials {
  const rawQuote = financials.quote;
  const quote = rawQuote ? mapQuote(rawQuote, providerMeta) : undefined;
  const divisor = rawQuote ? resolveCurrencyUnit(rawQuote.currency).divisor : 1;
  const exchange = rawQuote?.listingExchangeName ?? rawQuote?.exchangeName ?? "";
  return normalizeFinancialOperatingResults(withdrawKnownProviderStatements(retractKnownCloudValuation({
    quote,
    quoteMetadata: financials.quoteMetadata,
    quoteContributions: financials.quoteContributions,
    profile: financials.profile,
    fundamentals: redactUnavailableFundamentals(financials.fundamentals),
    financialCurrency: financials.financialCurrency,
    statementHistory: financials.statementHistory,
    operatingHistoryRetryAt: typeof financials.operatingHistoryRetryAt === "number" && Number.isFinite(financials.operatingHistoryRetryAt)
      && financials.operatingHistoryRetryAt > 0 && hasShopOperatingIdentity({
        quote, quoteMetadata: financials.quoteMetadata, financialCurrency: financials.financialCurrency,
      }, target) ? financials.operatingHistoryRetryAt : undefined,
    earningsHistoryRetryAt: financials.earningsHistoryRetryAt,
    annualStatements: financials.annualStatements ?? [],
    quarterlyStatements: financials.quarterlyStatements ?? [],
    priceHistory: (financials.priceHistory ?? []).map((point) =>
      point.date instanceof Date
        ? point
        : mapPricePoint(point as unknown as CloudPricePointPayload, divisor, exchange),
    ),
    ...(financials.epsEstimates ? { epsEstimates: financials.epsEstimates } : {}),
  }, target), target ?? { symbol: quote?.symbol ?? financials.quoteMetadata?.symbol ?? "", exchange }, "provider:gloomberb-cloud"), target);
}

export function mapOptionsChain(
  chain: CloudOptionsChainPayload,
): OptionsChain {
  return {
    underlyingSymbol: chain.underlyingSymbol,
    expirationDates: chain.expirationDates ?? [],
    calls: chain.calls ?? [],
    puts: chain.puts ?? [],
    providerId: chain.providerId,
    dataSource: chain.dataSource,
    feed: chain.feed,
    delayMinutes: chain.delayMinutes,
    realtimeEligible: chain.realtimeEligible,
    asOf: chain.asOf,
  };
}

export function isEmptyCloudStatus(
  status: CloudMarketResponse<unknown>["status"],
): boolean {
  return status === "empty" || status === "unsupported";
}

export function mapBatchError<T>(
  item: CloudMarketBatchItem<T>,
  fallbackMessage: string,
): Error {
  if (isEmptyCloudStatus(item.status)) {
    return createProviderMiss(item.reasonCode ?? fallbackMessage);
  }
  return new Error(item.reasonCode ?? fallbackMessage);
}

export function toCloudInterval(interval: string): string {
  switch (interval) {
    case "1m":
      return "1min";
    case "5m":
      return "5min";
    case "15m":
      return "15min";
    case "30m":
      return "30min";
    case "45m":
      return "45min";
    case "1d":
      return "1day";
    case "1wk":
      return "1week";
    case "1mo":
      return "1month";
    default:
      return interval;
  }
}

function padTimePart(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatCloudDateTime(
  date: Date,
  includeTime: boolean,
  exchange = "",
): string {
  if (includeTime) {
    const timeZone = resolveExchangeTimeZone(exchange);
    if (timeZone) {
      const parts = getZonedDateParts(date, timeZone);
      return `${parts.get("year")}-${parts.get("month")}-${parts.get(
        "day",
      )} ${parts.get("hour")}:${parts.get("minute")}:${parts.get("second")}`;
    }
    // Without a venue timezone, an explicit offset keeps host and server clocks
    // from interpreting the same intraday boundary as different instants.
    return date.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  const year = date.getUTCFullYear();
  const month = padTimePart(date.getUTCMonth() + 1);
  const day = padTimePart(date.getUTCDate());
  return `${year}-${month}-${day}`;
}

export function getRangeStartDate(
  range: TimeRange,
  endDate = new Date(),
): Date {
  return subtractTimeRange(endDate, range);
}

export function toHistoryRequest(range: TimeRange): {
  interval: string;
  outputsize: number;
  rangeKey: TimeRange;
} {
  switch (range) {
    case "1D":
      return { interval: "5min", outputsize: 24 * 12, rangeKey: range };
    case "1W":
      return { interval: "1h", outputsize: 7 * 24, rangeKey: range };
    case "1M":
      return { interval: "1day", outputsize: 31, rangeKey: range };
    case "3M":
      return { interval: "1day", outputsize: 93, rangeKey: range };
    case "6M":
      return { interval: "1day", outputsize: 186, rangeKey: range };
    case "1Y":
      return { interval: "1day", outputsize: 366, rangeKey: range };
    case "5Y":
      return { interval: "1week", outputsize: 261, rangeKey: range };
    case "ALL":
      return { interval: "1month", outputsize: 600, rangeKey: range };
    default:
      return { interval: "1day", outputsize: 366, rangeKey: range };
  }
}
