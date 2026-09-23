import type { Quote } from "../../types/financials";
import { resolvePriceBasis } from "../market/price-basis";
import { hasLikelyQuoteUnitMismatch, resolveCurrencyUnit } from "../../utils/currency-units";
import { canonicalExchange, resolveExchangeTimeZone } from "../../utils/exchanges";

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

// Intl.DateTimeFormat.format costs about 15us and every quote merge asks for
// the incoming and the retained quote's date, so the retained one repeats on
// each tick. Keyed by minute: a session boundary falls on a whole minute, and
// the cache stays small across a day of streaming.
const ZONE_DATE_CACHE_LIMIT = 4096;
const zoneDateCache = new Map<string, string>();

function zoneDate(zone: string, timestamp: number): string | null {
  const minute = Math.floor(timestamp / 60_000);
  const key = `${zone}:${minute}`;
  const cached = zoneDateCache.get(key);
  if (cached !== undefined) return cached;
  const observedAt = new Date(minute * 60_000);
  if (!Number.isFinite(observedAt.getTime())) return null;
  let formatter = dateFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatters.set(zone, formatter);
  }
  const date = formatter.format(observedAt);
  if (zoneDateCache.size >= ZONE_DATE_CACHE_LIMIT) zoneDateCache.clear();
  zoneDateCache.set(key, date);
  return date;
}

function declaredSessionDate(quote: Quote): string | null {
  const declared = quote.changeSessionDate;
  const declaredTime = typeof declared === "string" && /^\d{4}-\d{2}-\d{2}$/.test(declared)
    ? Date.parse(`${declared}T00:00:00Z`)
    : Number.NaN;
  return Number.isFinite(declaredTime)
    && new Date(declaredTime).toISOString().slice(0, 10) === declared ? declared! : null;
}

/**
 * The trading day a quote describes: the session its change is declared
 * against, otherwise the exchange-local date it was observed on. Null when
 * neither is known.
 */
export function quoteTradingDay(quote: Quote): string | null {
  const declared = declaredSessionDate(quote);
  if (declared) return declared;
  const zone = resolveExchangeTimeZone(quote.listingExchangeName ?? quote.exchangeName);
  if (!zone || !Number.isFinite(quote.lastUpdated) || quote.lastUpdated <= 0) return null;
  return zoneDate(zone, quote.lastUpdated);
}

function sessionDate(quote: Quote): string | null {
  const declaredDate = declaredSessionDate(quote);
  const zone = resolveExchangeTimeZone(quote.listingExchangeName ?? quote.exchangeName);
  if (!zone) return declaredDate;
  if (!Number.isFinite(quote.lastUpdated) || quote.lastUpdated <= 0) return null;
  const observedDate = zoneDate(zone, quote.lastUpdated);
  if (observedDate === null) return null;
  return declaredDate && declaredDate !== observedDate ? null : observedDate;
}

function sameUnits(left: Quote, right: Quote): boolean {
  const a = resolveCurrencyUnit(left.currency);
  const b = resolveCurrencyUnit(right.currency);
  const basis = resolvePriceBasis(left.priceBasis, left.instrumentType);
  return basis !== null && !!a.currency && a.currency === b.currency && a.divisor === b.divisor
    && basis === resolvePriceBasis(right.priceBasis, right.instrumentType)
    && !hasLikelyQuoteUnitMismatch(left, right);
}

function positive(value: number | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

/** Daily bars can lag trades; retain observed extrema only within one regular session. */
export function reconcileQuoteDayRange<T extends Quote>(next: T, current?: Quote): T {
  const compatibleUnits = !current || sameUnits(current, next);
  const nextDate = sessionDate(next);
  let high = next.high;
  let low = next.low;
  if (current && compatibleUnits) {
    const sameRegularSession = current.marketState === "REGULAR"
      && next.marketState === "REGULAR"
      && current.symbol === next.symbol
      && canonicalExchange(current.listingExchangeName ?? current.exchangeName)
        === canonicalExchange(next.listingExchangeName ?? next.exchangeName)
      && nextDate != null
      && sessionDate(current) === nextDate;
    if (sameRegularSession) {
      if (positive(current.high)) high = positive(high) ? Math.max(high, current.high) : current.high;
      if (positive(current.low)) low = positive(low) ? Math.min(low, current.low) : current.low;
    } else if (next.marketState !== "REGULAR") {
      // Extended-hours trades are not part of the regular-session range.
      high ??= current.high;
      low ??= current.low;
    }
  }
  if (next.marketState === "REGULAR" && next.sessionConfidence !== "unknown"
    && !next.stale && positive(next.price) && nextDate) {
    // Do not fabricate a full-day range from a stream that supplies only last.
    if (positive(high) && !hasLikelyQuoteUnitMismatch(next, { currency: next.currency, price: high })) {
      high = Math.max(high, next.price);
    }
    if (positive(low) && !hasLikelyQuoteUnitMismatch(next, { currency: next.currency, price: low })) {
      low = Math.min(low, next.price);
    }
  }
  return { ...next, high, low };
}
