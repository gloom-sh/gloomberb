import type { AppConfig, BrokerInstanceConfig } from "../types/config";
import type { Portfolio, TickerPosition, Watchlist } from "../types/ticker";
import { isRecord } from "../utils/guards";
import { normalizeWatchlistGroups } from "../portfolio/watchlist-groups";
import { portfolioCashBalances, withKeptOtherCash } from "../portfolio/cash-balances";

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
  const [cash, ...otherCash] = portfolioCashBalances(portfolio);
  return {
    id: portfolio.id,
    name: portfolio.name,
    description: portfolio.description,
    currency: portfolio.currency,
    ...(portfolio.fixedCurrency ? { fixedCurrency: true } : {}),
    brokerId: portfolio.brokerId,
    lastSyncedAt: portfolio.lastSyncedAt,
    // Cash and targets are the user's own entries: a pulled portfolio without
    // them would erase them on this device. `cash` is the first balance, as an
    // older build reads it, and `otherCash` the other currencies'.
    ...(cash ? { cash } : {}),
    ...(otherCash.length > 0 ? { otherCash } : {}),
    ...(portfolio.targetWeights ? { targetWeights: { ...portfolio.targetWeights } } : {}),
    ...(portfolio.importedFrom ? {
      importedFrom: {
        ...portfolio.importedFrom,
        ...(portfolio.importedFrom.weights ? { weights: { ...portfolio.importedFrom.weights } } : {}),
      },
    } : {}),
  };
}

/**
 * Set on every payload this build pushes with portfolios: they carry their
 * cash in other currencies (`otherCash`), so one without it holds cash in one
 * currency at most. An older build strips `otherCash` from every push, and
 * its portfolios taken as they came would erase those balances here and then
 * everywhere this device pushes to.
 */
export const PORTFOLIOS_CARRY_OTHER_CASH = "portfoliosCarryOtherCash";

/**
 * Pulled portfolios, each one an older build pushed (no
 * `PORTFOLIOS_CARRY_OTHER_CASH`) keeping the other currencies' cash it holds
 * here (`withKeptOtherCash`); a build that sends them is taken as it came, so
 * a balance cleared there is cleared here.
 */
export function withLocalOtherCash(pulled: unknown[], local: readonly Portfolio[], carriesOtherCash: boolean): Portfolio[] {
  if (carriesOtherCash) return pulled as Portfolio[];
  return pulled.map((entry) => withKeptOtherCash(entry, isRecord(entry) ? local.find((portfolio) => portfolio.id === entry.id) : null) as Portfolio);
}

/**
 * Set on every payload this build pushes with watchlists: its lists carry their
 * groups, so one without `groups` has none. An older build's lists never carry
 * them, and taken as they came they would erase the groups here and then
 * everywhere this device pushes to.
 */
export const WATCHLISTS_CARRY_GROUPS = "watchlistsCarryGroups";

/**
 * Pulled watchlists, each list an older build pushed (no `WATCHLISTS_CARRY_GROUPS`)
 * keeping the groups it has here; a build that sends groups is taken as it
 * came, so a group removed there is removed here.
 */
export function withLocalWatchlistGroups(pulled: unknown[], local: readonly Watchlist[], carriesGroups: boolean): Watchlist[] {
  if (carriesGroups) return pulled as Watchlist[];
  return pulled.map((entry) => {
    if (!isRecord(entry) || entry.groups !== undefined) return entry as unknown as Watchlist;
    const groups = local.find((watchlist) => watchlist.id === entry.id)?.groups;
    return (groups ? { ...entry, groups } : entry) as unknown as Watchlist;
  });
}

export function sanitizeWatchlist(watchlist: Watchlist): Watchlist {
  // The user's own sections: a pulled list without them would erase them on this device. A list
  // without groups goes as before. They are an array, never keyed by a name or symbol, which
  // `sanitizeUnknown` would drop for reading like a secret (a Private group, the PATH ticker).
  const groups = normalizeWatchlistGroups(watchlist.groups);
  return {
    id: watchlist.id,
    name: watchlist.name,
    description: watchlist.description,
    ...(groups ? { groups } : {}),
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
    // Which accounts the user keeps follows the profile to every device.
    excludedAccounts: instance.excludedAccounts,
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
