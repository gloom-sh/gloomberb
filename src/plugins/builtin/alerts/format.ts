import { closeBasis, rotationQuadrant } from "./metric-model";
import { formatMarketPrice } from "../../../market-data/market/format";
import { formatShortDate } from "../../../utils/datetime-format";
import { formatQuoteAgeWithSource } from "../../../market-data/quotes/time";
import type { AlertCondition, AlertRule } from "./types";

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

/** A price ratio to four decimals, as GR states the latest ratio. */
const formatRatio = (value: number) => value.toFixed(Math.abs(value) >= 100 ? 2 : 4);

export function formatCurrentPrice(alert: AlertRule, maxWidth = 9): string {
  if (alert.lastCheckError) return !alert.metric ? "No quote"
    : /US listing|US equities|calendar/.test(alert.lastCheckError) ? "US only"
    : /missing|bars|history|weekly closes/i.test(alert.lastCheckError) ? "Bar gap" : "No data";
  // The quadrant the latest weekly strength and momentum place it in.
  if (alert.metric?.kind === "rrg") return rotationQuadrant(alert.lastCheckedPrice, alert.lastCheckedTarget) ?? "-";
  if (alert.metric?.kind === "rs_ratio" && alert.lastCheckedPrice != null) return formatRatio(alert.lastCheckedPrice);
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
  if (alert.metric?.kind === "rrg") return `${alert.metric.quadrant[0]!.toUpperCase()}${alert.metric.quadrant.slice(1)}`;
  if (alert.metric?.kind === "rs_ratio") return formatRatio(alert.targetPrice);
  return formatMarketPrice(alert.targetPrice, {
    maxWidth,
    minimumFractionDigits: 2,
  });
}

export function formatAlertDistance(alert: AlertRule): string {
  const currentPrice = alert.lastCheckedPrice;
  if (alert.lastCheckError || alert.metric?.kind === "rrg") return "-";
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
  const basis = alert.metric ? closeBasis(alert.metric) : null;
  // A settled close reads as the session it is from: Oct 26 close, Oct 23 weekly.
  if (basis && alert.lastDailyClose && !alert.lastCheckError) {
    return `${formatShortDate(alert.lastDailyClose, { year: false, utc: true })} ${basis === "weekly close" ? "weekly" : "close"}`;
  }
  if (basis) return `on ${basis}`;
  if (alert.lastCheckError) return /\bstale\b/i.test(alert.lastCheckError) ? "Stale" : "No quote";
  if (alert.lastQuoteUpdatedAt) {
    return formatQuoteAgeWithSource({
      lastUpdated: alert.lastQuoteUpdatedAt,
      dataSource: alert.lastQuoteSource,
    });
  }
  if (alert.lastCheckedAt) return relativeTime(alert.lastCheckedAt);
  return "-";
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
