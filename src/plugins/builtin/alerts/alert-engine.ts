import type { AlertCondition, AlertRule } from "./types";

export type { AlertRule };

export function createAlert(symbol: string, condition: AlertCondition, targetPrice: number): AlertRule {
  return {
    id: `alert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    symbol: symbol.toUpperCase(),
    condition,
    targetPrice,
    createdAt: Date.now(),
    status: "active",
  };
}

export function evaluateAlert(alert: AlertRule, currentPrice: number): boolean {
  if (alert.status !== "active") return false;

  switch (alert.condition) {
    case "above":
      return currentPrice > alert.targetPrice;
    case "below":
      return currentPrice < alert.targetPrice;
    case "crosses": {
      if (alert.lastCheckedPrice == null) return false;
      const wasBelowOrAt = alert.lastCheckedPrice <= alert.targetPrice;
      const wasAboveOrAt = alert.lastCheckedPrice >= alert.targetPrice;
      const isAbove = currentPrice > alert.targetPrice;
      const isBelow = currentPrice < alert.targetPrice;
      return (wasBelowOrAt && isAbove) || (wasAboveOrAt && isBelow);
    }
  }
}

export function formatAlertDescription(alert: AlertRule): string {
  const prefix = alert.condition === "above" ? ">"
    : alert.condition === "below" ? "<" : "↕";
  return `${alert.symbol} ${prefix} ${alert.targetPrice}`;
}

export function serializeAlerts(alerts: AlertRule[]): string {
  return JSON.stringify(alerts);
}

/**
 * Non-null when the stored blob is not valid alert JSON. Without this a corrupt
 * store deserializes to `[]` and the pane claims the user has no alerts.
 */
export function readAlertsStoreError(json: string): string | null {
  if (!json.trim()) return null;
  try {
    return Array.isArray(JSON.parse(json)) ? null : "Saved alerts are not a list.";
  } catch (error) {
    return error instanceof Error ? error.message : "Saved alerts could not be read.";
  }
}

export function deserializeAlerts(json: string): AlertRule[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((a: any) =>
      a?.id && a?.symbol && a?.condition && typeof a?.targetPrice === "number"
    );
  } catch {
    return [];
  }
}
