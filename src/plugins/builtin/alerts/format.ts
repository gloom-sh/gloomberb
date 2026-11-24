import { MISSING_VALUE, formatSignificant } from "../../../utils/format";
import { closeBasis, metricName, metricReadingText, rotationQuadrant, type AlertMetric, type MetricReading } from "./metric-model";
import { moveBasisText, movePercentText, moveTargetText, moveTriggerLabel } from "./move";
import { formatMarketPrice } from "../../../market-data/market/format";
import { EXTENDED_PRINT_WORDS } from "../../../market-data/market/change-basis";
import { EXTENDED_SESSION_MARKS } from "../../../market-data/market/status";
import { formatShortDate } from "../../../utils/datetime-format";
import { alertListingKey, alertPriceText } from "./price-text";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { isRoundTheClockCoin } from "../../../utils/crypto-pair";
import type { AlertCondition, AlertRule } from "./types";
import { quoteSourceWords } from "./fired-log";

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

export function formatMetricReading(metric: AlertMetric, reading: Pick<MetricReading, "value" | "target">): string {
  return metric.kind === "rs_ratio" ? formatSignificant(reading.value) : metricReadingText(metric, reading);
}

export function formatAlertHistoryValue(value: number | null, kind: string, unit: string): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const figure = kind === "rs_ratio" ? formatSignificant(value) : String(Number(value.toFixed(4)));
  return `${figure}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`;
}

/**
 * The current reading in a cell: an after-hours, pre-market or overnight
 * print marked before it as the portfolio marks a price (AH 158.78), or in
 * words after it where there is room to say it (`words`: 158.78 after hours).
 */
export function formatCurrentPrice(alert: AlertRule, maxWidth = 9, { words = false }: { words?: boolean } = {}): string {
  if (alert.lastCheckError) return !alert.metric ? "No quote"
    : /US listing|US equities|calendar/.test(alert.lastCheckError) ? "US only"
    : /missing|bars|history|weekly closes/i.test(alert.lastCheckError) ? "Bar gap" : "No data";
  // The quadrant the latest weekly strength and momentum place it in.
  if (alert.metric?.kind === "rrg") return rotationQuadrant(alert.lastCheckedPrice, alert.lastCheckedTarget) ?? MISSING_VALUE;
  if (alert.metric?.kind === "rs_ratio") return formatSignificant(alert.lastCheckedPrice);
  if (alert.lastCheckedPrice == null) return MISSING_VALUE;
  const session = alert.metric ? undefined : alert.lastQuoteSession;
  const mark = session && !words ? `${EXTENDED_SESSION_MARKS[session]} ` : "";
  // A move rule reads the day's move: -0.38%. A price at its instrument's precision (1.34032 on GBP/USD, 117.35p
  // on a London line), as `quote` prints it.
  const figure = alert.move ? movePercentText(alert.lastCheckedPrice)
    : alert.metric ? formatMarketPrice(alert.lastCheckedPrice, { maxWidth, minimumFractionDigits: 2 })
    : alertPriceText(alert, alert.lastCheckedPrice, Math.max(1, maxWidth - mark.length));
  return session && words ? `${figure} ${EXTENDED_PRINT_WORDS[session]}` : `${mark}${figure}`;
}

/** " after hours" after a reading that is an extended session's print; nothing for the regular session's. */
export function readingSessionWords(alert: Pick<AlertRule, "lastQuoteSession" | "metric">): string {
  return alert.lastQuoteSession && !alert.metric ? ` ${EXTENDED_PRINT_WORDS[alert.lastQuoteSession]}` : "";
}

export function formatAlertTargetPrice(alert: AlertRule, maxWidth = 9): string {
  if (alert.metric?.kind === "ma_cross") return `${alert.metric.slowPeriod}-day MA`;
  if (alert.metric?.kind === "close_ma") return `${alert.metric.period}-day MA`;
  if (alert.metric?.kind === "rrg") return `${alert.metric.quadrant[0]!.toUpperCase()}${alert.metric.quadrant.slice(1)}`;
  if (alert.metric?.kind === "rs_ratio") return formatSignificant(alert.targetPrice);
  if (alert.move) return moveTargetText(alert);
  return alert.metric ? formatMarketPrice(alert.targetPrice, { maxWidth, minimumFractionDigits: 2 }) : alertPriceText(alert, alert.targetPrice, maxWidth);
}

export function formatAlertDistance(alert: AlertRule): string {
  const currentPrice = alert.lastCheckedPrice;
  // A move is not a distance from a price: its reading and target say how far it has to go.
  if (alert.lastCheckError || alert.metric?.kind === "rrg" || alert.move) return MISSING_VALUE;
  if (currentPrice == null || !Number.isFinite(currentPrice) || currentPrice === 0) {
    return MISSING_VALUE;
  }
  const percent = (((alert.lastCheckedTarget ?? alert.targetPrice) - currentPrice) / currentPrice) * 100;
  if (!Number.isFinite(percent)) return MISSING_VALUE;
  // One decimal at any distance, so the column holds still as the price moves;
  // a distance that rounds to zero is unsigned (0.0%, never -0.0%).
  const fixed = Math.abs(percent).toFixed(1);
  return `${/[1-9]/.test(fixed) ? (percent > 0 ? "+" : "-") : ""}${fixed}%`;
}

/**
 * An instant in a cell, to the minute in UTC as the History tab writes its
 * times under a "(UTC)" heading: `2026-11-20 23:20`.
 */
export function alertMinuteUtc(time: number | null | undefined): string {
  const iso = isoUtc(time);
  return iso ? iso.slice(0, 16).replace("T", " ") : MISSING_VALUE;
}

/**
 * The Quote cell: when the quote it was checked on is from, to the minute in
 * UTC and marked ◷ when the feed was delayed (◷2026-11-20 23:20), a settled
 * close by its session, or, on the row of an alert that got none, why (a
 * stale quote, or none).
 */
export function formatQuoteChecked(alert: AlertRule): string {
  const basis = alert.metric ? closeBasis(alert.metric) : null;
  // A settled close reads as the session it is from: Oct 26 close, Oct 23 weekly.
  if (basis && alert.lastDailyClose && !alert.lastCheckError) {
    return `${formatShortDate(alert.lastDailyClose, { year: false, utc: true })} ${basis === "weekly close" ? "weekly" : "close"}`;
  }
  if (basis) return `on ${basis}`;
  if (alert.lastCheckError) return /\bstale\b/i.test(alert.lastCheckError) ? "Stale" : "No quote";
  // The quote's own time, never its age: a compliance record reads the instant the level was judged on.
  if (alert.lastQuoteUpdatedAt) return `${alert.lastQuoteSource === "delayed" ? "◷" : ""}${alertMinuteUtc(alert.lastQuoteUpdatedAt)}`;
  if (alert.lastCheckedAt) return relativeTime(alert.lastCheckedAt);
  return NOT_CHECKED_YET;
}

/**
 * The detail's Quote line: the quote's own instant to the second with its feed
 * (2026-11-20T23:20:59Z · delayed), or the close a daily rule read
 * (2026-11-20 close); the row's cell otherwise.
 */
export function quoteAsOfText(alert: AlertRule): string {
  const basis = alert.metric ? closeBasis(alert.metric) : null;
  if (alert.lastCheckError) return formatQuoteChecked(alert);
  if (basis && alert.lastDailyClose) return `${alert.lastDailyClose} ${basis === "weekly close" ? "weekly close" : "close"}`;
  if (!basis && alert.lastQuoteUpdatedAt) {
    const feed = quoteSourceWords(alert.lastQuoteSource);
    return `${isoUtc(alert.lastQuoteUpdatedAt)}${feed ? ` · ${feed}` : ""}`;
  }
  return formatQuoteChecked(alert);
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
  // A pair written with its `=X` suffix names itself: GBPUSD=X, never GBPUSD=X:CCY.
  if (/=X$/i.test(alert.symbol)) return alert.symbol;
  // So does a coin pair, as `quote` prints it: BTC-USD however its venue was kept, never BTC-USD:CCC.
  const coin = parsePublicTickerKey(alert.symbol);
  if (/^[A-Z0-9]+-[A-Z0-9]+$/.test(coin.symbol) && isRoundTheClockCoin(coin.symbol, coin.exchange || alert.exchange || alert.lastQuoteExchange)) return coin.symbol;
  // One key however the listing was typed: 7203.T, `7203 JP` and 7203:JPX are all 7203:JPX.
  return alertListingKey(alert);
}

/** A listing with the currency its prices are in: `EWG:ARCA (USD)`; the listing alone until a quote has said it. */
export function listingWithCurrency(listing: string, currency: string | null | undefined): string {
  return currency ? `${listing} (${currency})` : listing;
}

/** The unit of an alert's reading: the listing's currency for a price or an average, `x` for a multiple, none for RSI. */
function readingUnit(alert: AlertRule): string {
  const kind = alert.metric?.kind;
  if (kind === "pe" || kind === "ps") return "x";
  if (kind === "rsi" || kind === "rs_ratio" || kind === "rrg") return "";
  return alert.lastQuoteCurrency ?? "";
}

/**
 * The currency an alert's readings are in: the listing's for a price, a move
 * or a moving average; none for a multiple, RSI, a ratio of two listings or an
 * RRG quadrant, which carry no currency.
 */
export function alertReadingCurrency(alert: AlertRule): string | null {
  const unit = readingUnit(alert);
  return unit && unit !== "x" ? unit : null;
}

/**
 * The reading a daily rule is measured against, as the last reading is
 * written: the slow average of an MA crossover or the average a close is held
 * to (`59.73 USD on the 2026-11-20 close`). Empty for a rule judged against a
 * fixed level, and before a check has read one.
 */
export function alertComparatorReadingText(alert: AlertRule): string {
  const kind = alert.metric?.kind;
  if (kind !== "ma_cross" && kind !== "close_ma") return "";
  const value = alert.lastCheckedTarget;
  if (alert.lastCheckError || value == null || !Number.isFinite(value)) return "";
  const unit = readingUnit(alert);
  const figure = `${value.toFixed(2)}${unit ? ` ${unit}` : ""}`;
  return alert.lastDailyClose ? `${figure} on the ${alert.lastDailyClose} close` : figure;
}

/** The listing a ratio or RRG rule divides by, as it was confirmed (`ACWI:NASDAQ`); empty for any other rule. */
export function alertBenchmarkListing(alert: Pick<AlertRule, "metric">): string {
  const metric = alert.metric;
  if (metric?.kind !== "rs_ratio" && metric?.kind !== "rrg") return "";
  return metric.benchmarkExchange ? `${metric.benchmark}:${metric.benchmarkExchange}` : metric.benchmark;
}

/** When the last reading is from: the quote's own time, or the daily close's; null with none. */
export function alertReadingAt(alert: AlertRule): number | null {
  if (alert.lastCheckError || alert.lastCheckedPrice == null) return null;
  return alert.lastQuoteUpdatedAt ?? alert.lastCheckedAt ?? null;
}

export function alertReadingFeed(alert: AlertRule): string | null {
  if (alert.lastCheckError || !Number.isFinite(alert.lastCheckedPrice)) return null;
  return (alert.metric && closeBasis(alert.metric)) || quoteSourceWords(alert.lastQuoteSource) || "feed not recorded";
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
  // A move, with the close it is measured from: `-0.38% vs Thu 5 Nov close as of 2026-11-06T08:47Z`.
  if (alert.move) {
    const at = alertReadingAt(alert);
    const figure = `${movePercentText(value)}${readingSessionWords(alert)} ${moveBasisText(alert.lastMoveBasis)}`;
    return at ? `${figure} as of ${isoUtc(at).replace(/:\d{2}Z$/, "Z")}` : figure;
  }
  const unit = readingUnit(alert);
  // A price at its instrument's precision and with thousands separators, as the Trigger beside it (74,481.45 USD);
  // a London line's in pence, which says its unit itself.
  const price = !alert.metric ? alertPriceText(alert, value) : null;
  const figure = alert.metric?.kind === "rrg" || alert.metric?.kind === "rs_ratio"
    ? formatMetricReading(alert.metric, { value, target: alert.lastCheckedTarget ?? Number.NaN })
    : price?.endsWith("p") ? `${price}${readingSessionWords(alert)}`
    : `${price ?? value.toFixed(2)}${unit === "x" ? "x" : unit ? ` ${unit}` : ""}${readingSessionWords(alert)}`;
  const basis = alert.metric ? closeBasis(alert.metric) : null;
  if (basis && alert.lastDailyClose) return `${figure} on the ${alert.lastDailyClose} ${basis === "weekly close" ? "weekly close" : "close"}`;
  const at = alertReadingAt(alert);
  return at ? `${figure} as of ${isoUtc(at).replace(/:\d{2}Z$/, "Z")}` : figure;
}

/** The Trigger cell of a level rule: Above, Below, Cross; a move rule's Moves, Up or Down. */
export function triggerLabel(alert: Pick<AlertRule, "condition" | "move" | "metric">): string {
  if (alert.move) return moveTriggerLabel(alert.condition);
  if (alert.metric?.kind === "ma_cross") return `Cross ${alert.metric.direction}`;
  if (alert.metric?.kind === "rrg") return "Enters";
  return conditionLabel(alert.condition);
}

/** The Measure cell: Price, Move, or the measure's name. */
export function measureLabel(alert: Pick<AlertRule, "move" | "metric">): string {
  return alert.metric ? metricName(alert.metric) : alert.move ? "Move" : "Price";
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
