import { formatMarketPrice } from "../../../market-data/market/format";
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

export function formatCurrentPrice(alert: AlertRule, maxWidth = 9): string {
  if (alert.lastCheckError) return "No quote";
  return alert.lastCheckedPrice == null
    ? "-"
    : formatMarketPrice(alert.lastCheckedPrice, {
        maxWidth,
        minimumFractionDigits: 2,
      });
}

export function formatAlertTargetPrice(alert: AlertRule, maxWidth = 9): string {
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
  const percent = ((alert.targetPrice - currentPrice) / currentPrice) * 100;
  if (!Number.isFinite(percent)) return "-";
  // One decimal at any distance, so the column holds still as the price moves;
  // a distance that rounds to zero is unsigned (0.0%, never -0.0%).
  const fixed = Math.abs(percent).toFixed(1);
  return `${/[1-9]/.test(fixed) ? (percent > 0 ? "+" : "-") : ""}${fixed}%`;
}

export function formatQuoteChecked(alert: AlertRule): string {
  if (alert.lastCheckError) return "No quote";
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
