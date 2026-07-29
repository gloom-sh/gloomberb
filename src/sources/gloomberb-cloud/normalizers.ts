import type { TimeRange } from "../../time-series/range";
import type {
  OptionsChain,
  PricePoint,
  Quote,
  TickerFinancials,
} from "../../types/financials";
import {
  type CloudMarketBatchItem,
  type CloudMarketResponse,
  type CloudOptionsChainPayload,
  type CloudPricePointPayload,
  type CloudQuotePayload,
} from "../../api-client";
import { normalizePriceValueByDivisor, resolveCurrencyUnit } from "../../utils/currency-units";
import { resolveExchangeTimeZone } from "../../utils/exchanges";
import { createProviderMiss } from "../provider-errors";

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
  return {
    ...quote,
    currency: currency || quote.currency,
    price: normalizePriceValueByDivisor(quote.price, divisor) ?? quote.price,
    change: normalizePriceValueByDivisor(quote.change, divisor) ?? quote.change,
    previousClose: normalizePriceValueByDivisor(quote.previousClose, divisor),
    high52w: normalizePriceValueByDivisor(quote.high52w, divisor),
    low52w: normalizePriceValueByDivisor(quote.low52w, divisor),
    bid: normalizePriceValueByDivisor(quote.bid, divisor),
    ask: normalizePriceValueByDivisor(quote.ask, divisor),
    open: normalizePriceValueByDivisor(quote.open, divisor),
    high: normalizePriceValueByDivisor(quote.high, divisor),
    low: normalizePriceValueByDivisor(quote.low, divisor),
    mark: normalizePriceValueByDivisor(quote.mark, divisor),
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
  };
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
    open: normalizePriceValueByDivisor(point.open, divisor),
    high: normalizePriceValueByDivisor(point.high, divisor),
    low: normalizePriceValueByDivisor(point.low, divisor),
    close: normalizePriceValueByDivisor(point.close, divisor) ?? point.close,
    volume: point.volume,
  };
}

export function mapCloudFinancials(
  financials: TickerFinancials,
  providerMeta?: CloudProviderMeta,
): TickerFinancials {
  const quote = financials.quote
    ? mapQuote(financials.quote as CloudQuotePayload, providerMeta)
    : undefined;
  const divisor = quote ? resolveCurrencyUnit(quote.currency).divisor : 1;
  return {
    quote,
    quoteContributions: financials.quoteContributions,
    profile: financials.profile,
    fundamentals: financials.fundamentals,
    annualStatements: financials.annualStatements ?? [],
    quarterlyStatements: financials.quarterlyStatements ?? [],
    priceHistory: (financials.priceHistory ?? []).map((point) =>
      point.date instanceof Date
        ? point
        : mapPricePoint(point as unknown as CloudPricePointPayload, divisor),
    ),
  };
}

export function mapOptionsChain(
  chain: CloudOptionsChainPayload,
): OptionsChain {
  return {
    underlyingSymbol: chain.underlyingSymbol,
    expirationDates: chain.expirationDates ?? [],
    calls: chain.calls ?? [],
    puts: chain.puts ?? [],
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
  }

  const year = includeTime ? date.getFullYear() : date.getUTCFullYear();
  const month = padTimePart(
    (includeTime ? date.getMonth() : date.getUTCMonth()) + 1,
  );
  const day = padTimePart(includeTime ? date.getDate() : date.getUTCDate());
  if (!includeTime) {
    return `${year}-${month}-${day}`;
  }
  const hours = padTimePart(date.getHours());
  const minutes = padTimePart(date.getMinutes());
  const seconds = padTimePart(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function getRangeStartDate(
  range: TimeRange,
  endDate = new Date(),
): Date {
  const startDate = new Date(endDate);
  switch (range) {
    case "1D":
      startDate.setDate(startDate.getDate() - 1);
      break;
    case "1W":
      startDate.setDate(startDate.getDate() - 7);
      break;
    case "1M":
      startDate.setMonth(startDate.getMonth() - 1);
      break;
    case "3M":
      startDate.setMonth(startDate.getMonth() - 3);
      break;
    case "6M":
      startDate.setMonth(startDate.getMonth() - 6);
      break;
    case "1Y":
      startDate.setFullYear(startDate.getFullYear() - 1);
      break;
    case "5Y":
      startDate.setFullYear(startDate.getFullYear() - 5);
      break;
    case "ALL":
      startDate.setFullYear(startDate.getFullYear() - 20);
      break;
  }
  return startDate;
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
      return { interval: "1month", outputsize: 240, rangeKey: range };
    default:
      return { interval: "1day", outputsize: 366, rangeKey: range };
  }
}
