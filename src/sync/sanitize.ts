import type { AppConfig, BrokerInstanceConfig } from "../types/config";
import type { Portfolio, TickerPosition, Watchlist } from "../types/ticker";
import { isRecord } from "../utils/guards";

const SENSITIVE_KEY_PATTERN = /(token|secret|password|credential|private|api[_-]?key|access[_-]?key|refresh[_-]?key|session|cookie|dataDir|path|directory|localPath)/i;

export function sanitizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeUnknown).filter((entry) => entry !== undefined);
  }
  if (!isRecord(value)) return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    const sanitized = sanitizeUnknown(child);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

/**
 * Puts back what `sanitizeUnknown` keeps off the wire. A pulled config never
 * carries a token, password, key or local path, so taking it as-is deleted
 * them on this device: any plugin setting changed elsewhere (an alert, a
 * price level) wiped every plugin's saved credentials, and the user had to
 * paste them again. Those values belong to this device, so they always win.
 */
function withLocalSensitiveValues(
  pulled: Record<string, unknown>,
  local: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...pulled };
  for (const [key, localChild] of Object.entries(local)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = localChild;
    } else if (isRecord(output[key]) && isRecord(localChild)) {
      output[key] = withLocalSensitiveValues(output[key] as Record<string, unknown>, localChild);
    }
  }
  return output;
}

export function withLocalPluginSecrets(
  pulled: AppConfig["pluginConfig"],
  local: AppConfig["pluginConfig"],
): AppConfig["pluginConfig"] {
  const next = { ...pulled };
  for (const [pluginId, localState] of Object.entries(local)) {
    if (!isRecord(localState)) continue;
    // A plugin the other device has no settings for still keeps its secrets here.
    const merged = withLocalSensitiveValues(next[pluginId] ?? {}, localState);
    if (pluginId in next || Object.keys(merged).length > 0) next[pluginId] = merged;
  }
  return next;
}

export function sanitizePortfolio(portfolio: Portfolio): Portfolio {
  return {
    id: portfolio.id,
    name: portfolio.name,
    description: portfolio.description,
    currency: portfolio.currency,
    ...(portfolio.fixedCurrency ? { fixedCurrency: true } : {}),
    brokerId: portfolio.brokerId,
    lastSyncedAt: portfolio.lastSyncedAt,
    // Cash and targets are the user's own entries: a pulled portfolio without
    // them would erase them on this device.
    ...(portfolio.cash ? { cash: { ...portfolio.cash } } : {}),
    ...(portfolio.targetWeights ? { targetWeights: { ...portfolio.targetWeights } } : {}),
    ...(portfolio.importedFrom ? {
      importedFrom: {
        ...portfolio.importedFrom,
        ...(portfolio.importedFrom.weights ? { weights: { ...portfolio.importedFrom.weights } } : {}),
      },
    } : {}),
  };
}

export function sanitizeWatchlist(watchlist: Watchlist): Watchlist {
  return {
    id: watchlist.id,
    name: watchlist.name,
    description: watchlist.description,
  };
}

export function sanitizeBrokerInstance(instance: BrokerInstanceConfig): Omit<BrokerInstanceConfig, "config"> {
  return {
    id: instance.id,
    brokerType: instance.brokerType,
    label: instance.label,
    connectionMode: instance.connectionMode,
    enabled: instance.enabled,
    lastSyncedAt: instance.lastSyncedAt,
  };
}

export function sanitizePosition(position: TickerPosition): TickerPosition {
  return {
    portfolio: position.portfolio,
    shares: position.shares,
    avgCost: position.avgCost,
    currency: position.currency,
    dateAcquired: position.dateAcquired,
    ...(position.costFxRate != null && position.costFxCurrency ? { costFxRate: position.costFxRate, costFxCurrency: position.costFxCurrency } : {}),
    broker: position.broker,
    side: position.side,
    marketValue: position.marketValue,
    unrealizedPnl: position.unrealizedPnl,
    multiplier: position.multiplier,
    markPrice: position.markPrice,
  };
}
