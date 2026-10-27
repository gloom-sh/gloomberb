import { isDailyMetric } from "./metric-model";
import { formatMarketPrice } from "../../../market-data/market/format";
import { formatQuoteAgeWithSource } from "../../../market-data/quotes/time";
import type { AlertCondition, AlertRule } from "./types";

/** What a list says of an alert no check has read yet. */
export const NOT_CHECKED_YET = "not checked yet";

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatCurrentPrice(alert: AlertRule, maxWidth = 9): string {
  if (alert.lastCheckError) return !alert.metric ? "No quote"
    : /US listing|US equities|calendar/.test(alert.lastCheckError) ? "US only"
    : /missing|bars|history/i.test(alert.lastCheckError) ? "Bar gap" : "No data";
  return alert.lastCheckedPrice == null
    ? "-"
    : formatMarketPrice(alert.lastCheckedPrice, {
        maxWidth,
        minimumFractionDigits: 2,
      });
}

export function formatAlertTargetPrice(alert: AlertRule, maxWidth = 9): string {
  if (alert.metric?.kind === "ma_cross") return `${alert.metric.slowPeriod}-day MA`;
  if (alert.metric?.kind === "close_ma") return `${alert.metric.period}-day MA`;
  return formatMarketPrice(alert.targetPrice, {
    maxWidth,
    minimumFractionDigits: 2,
  });
}

export function formatAlertDistance(alert: AlertRule): string {
  const currentPrice = alert.lastCheckedPrice;
  if (alert.lastCheckError) return "-";
  if (currentPrice == null || !Number.isFinite(currentPrice) || currentPrice === 0) {
    return "-";
  }
  const percent = (((alert.lastCheckedTarget ?? alert.targetPrice) - currentPrice) / currentPrice) * 100;
  if (!Number.isFinite(percent)) return "-";
  // One decimal at any distance, so the column holds still as the price moves;
  // a distance that rounds to zero is unsigned (0.0%, never -0.0%).
  const fixed = Math.abs(percent).toFixed(1);
  return `${/[1-9]/.test(fixed) ? (percent > 0 ? "+" : "-") : ""}${fixed}%`;
}

/** The Quote cell: the quote's age and feed, or, on the row of an alert that got none, why (a stale quote, or none). */
export function formatQuoteChecked(alert: AlertRule): string {
  if (alert.metric && isDailyMetric(alert.metric)) return "on daily close";
  if (alert.lastCheckError) return /\bstale\b/i.test(alert.lastCheckError) ? "Stale" : "No quote";
  if (alert.lastQuoteUpdatedAt) {
    return formatQuoteAgeWithSource({
      lastUpdated: alert.lastQuoteUpdatedAt,
      dataSource: alert.lastQuoteSource,
    });
  }
  if (alert.lastCheckedAt) return relativeTime(alert.lastCheckedAt);
  return NOT_CHECKED_YET;
}

/** A time as lists and exports give it: ISO 8601 in UTC, to the second (2026-10-27T06:35:12Z); empty for none. */
export function isoUtc(value: number | null | undefined): string {
  return value != null && Number.isFinite(value) && value > 0 ? new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z") : "";
}

/**
 * The listing an alert is checked on: `EWG:ARCA`, its own exchange, or the
 * venue its last quote came from for a rule set by symbol alone; the symbol
 * until it has been checked.
 */
export function alertListing(alert: Pick<AlertRule, "symbol" | "exchange" | "lastQuoteExchange">): string {
  const venue = alert.exchange || alert.lastQuoteExchange;
  return venue && !alert.symbol.includes(":") ? `${alert.symbol}:${venue}` : alert.symbol;
}

/** A listing with the currency its prices are in: `EWG:ARCA (USD)`; the listing alone until a quote has said it. */
export function listingWithCurrency(listing: string, currency: string | null | undefined): string {
  return currency ? `${listing} (${currency})` : listing;
}

/** The unit of an alert's reading: the listing's currency for a price or an average, `x` for a multiple, none for RSI. */
function readingUnit(alert: AlertRule): string {
  const kind = alert.metric?.kind;
  if (kind === "pe" || kind === "ps") return "x";
  if (kind === "rsi") return "";
  return alert.lastQuoteCurrency ?? "";
}

/** When the last reading is from: the quote's own time, or the daily close's; null with none. */
export function alertReadingAt(alert: AlertRule): number | null {
  if (alert.lastCheckError || alert.lastCheckedPrice == null) return null;
  return alert.lastQuoteUpdatedAt ?? alert.lastCheckedAt ?? null;
}

/**
 * The last reading an alert was checked on, with its unit and when it is
 * from: `37.12 USD as of 2026-10-27T14:31Z`, `61.23 on the 2026-10-26 close`
 * for a daily rule, why the last check read nothing, or `not checked yet`.
 */
export function alertReadingText(alert: AlertRule): string {
  if (alert.lastCheckError) return `no reading: ${alert.lastCheckError.replace(/\.$/, "")}`;
  const value = alert.lastCheckedPrice;
  if (value == null || !Number.isFinite(value)) return NOT_CHECKED_YET;
  const unit = readingUnit(alert);
  const figure = `${alert.metric ? value.toFixed(2) : String(value)}${unit === "x" ? "x" : unit ? ` ${unit}` : ""}`;
  if (alert.metric && isDailyMetric(alert.metric) && alert.lastDailyClose) return `${figure} on the ${alert.lastDailyClose} close`;
  const at = alertReadingAt(alert);
  return at ? `${figure} as of ${isoUtc(at).replace(/:\d{2}Z$/, "Z")}` : figure;
}

export function conditionLabel(condition: AlertCondition): string {
  switch (condition) {
    case "above":
      return "Above";
    case "below":
      return "Below";
    case "crosses":
      return "Cross";
  }
}
