import type { Quote } from "../../types/financials";
import { hasLikelyQuoteUnitMismatch, resolveCurrencyUnit } from "../../utils/currency-units";
import { canonicalExchange, resolveExchangeTimeZone } from "../../utils/exchanges";

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function sessionDate(quote: Quote): string | null {
  const declared = quote.changeSessionDate;
  const declaredTime = typeof declared === "string" && /^\d{4}-\d{2}-\d{2}$/.test(declared)
    ? Date.parse(`${declared}T00:00:00Z`)
    : Number.NaN;
  const declaredDate = Number.isFinite(declaredTime)
    && new Date(declaredTime).toISOString().slice(0, 10) === declared ? declared! : null;
  const zone = resolveExchangeTimeZone(quote.listingExchangeName ?? quote.exchangeName);
  if (!zone) return declaredDate;
  if (!Number.isFinite(quote.lastUpdated) || quote.lastUpdated <= 0) return null;
  const observedAt = new Date(quote.lastUpdated);
  if (!Number.isFinite(observedAt.getTime())) return null;
  let formatter = dateFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatters.set(zone, formatter);
  }
  const observedDate = formatter.format(observedAt);
  return declaredDate && declaredDate !== observedDate ? null : observedDate;
}

function sameUnits(left: Quote, right: Quote): boolean {
  const a = resolveCurrencyUnit(left.currency);
  const b = resolveCurrencyUnit(right.currency);
  return !!a.currency && a.currency === b.currency && a.divisor === b.divisor
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
