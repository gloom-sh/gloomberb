import type { AlertCondition, AlertRule } from "./types";
import { logFailure } from "../../../utils/log-failure";

export type { AlertRule };

export function createAlert(
  symbol: string,
  condition: AlertCondition,
  targetPrice: number,
  exchange?: string,
): AlertRule {
  return {
    id: `alert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    symbol: symbol.toUpperCase(),
    exchange: exchange?.trim() || undefined,
    condition,
    targetPrice,
    createdAt: Date.now(),
    status: "active",
  };
}

/**
 * Rebuilt from a whitelist rather than spread so every trigger/quote lifecycle
 * field is dropped: a re-armed `crosses` alert must start from a fresh baseline.
 * armedAt marks a new arming, so the cloud can email this rule's trigger again.
 */
export function editAlert(
  alert: AlertRule,
  symbol: string,
  condition: AlertCondition,
  targetPrice: number,
): AlertRule {
  const nextSymbol = symbol.trim().toUpperCase();
  return {
    id: alert.id,
    symbol: nextSymbol,
    exchange: nextSymbol === alert.symbol.trim().toUpperCase() ? alert.exchange : undefined,
    condition,
    targetPrice,
    createdAt: alert.createdAt,
    armedAt: Date.now(),
    status: "active",
    message: alert.message,
  };
}

export function rearmAlert(alert: AlertRule): AlertRule {
  return editAlert(alert, alert.symbol, alert.condition, alert.targetPrice);
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

/** Keep readable rows for display, but never let a write discard an unreadable member. */
function readAlerts(json: unknown): { alerts: AlertRule[]; error: string | null } {
  if (json == null || (typeof json === "string" && !json.trim())) return { alerts: [], error: null };
  const failed = (detail: string) => ({ alerts: [], error: `Saved price alerts could not be read: ${detail}` });
  if (typeof json !== "string") return failed("expected saved JSON text.");
  try {
    const parsed: unknown = JSON.parse(json, (_key, value: unknown) => {
      // JSON numbers can overflow while parsing; serializing Infinity would silently replace it with null.
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("a saved number is not finite.");
      return value;
    });
    if (!Array.isArray(parsed)) return failed("expected a list.");
    const alerts = parsed.filter((a): a is AlertRule => (
      a != null && typeof a.id === "string" && !!a.id && typeof a.symbol === "string" && !!a.symbol
      && typeof a.condition === "string" && !!a.condition && typeof a.targetPrice === "number"
      && (a.exchange == null || typeof a.exchange === "string")
    ));
    return {
      alerts,
      error: alerts.length === parsed.length ? null : "Saved price alerts contain an unreadable entry. Original data has been kept.",
    };
  } catch (error) {
    return failed(error instanceof Error ? error.message : "invalid JSON.");
  }
}

export function readAlertsStoreError(json: unknown): string | null {
  return readAlerts(json).error;
}

export function deserializeAlerts(json: unknown): AlertRule[] {
  const { alerts, error } = readAlerts(json);
  if (error) logFailure("alerts.alert-engine", "Read saved price alerts failed")(new Error(error));
  return alerts;
}
