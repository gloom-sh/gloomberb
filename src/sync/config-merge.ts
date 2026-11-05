import { normalizeStoredBaseCurrency } from "../utils/base-currency";
import { stableStringify } from "../utils/hash";
import type { AppConfig, BrokerInstanceConfig } from "../types/config";
import type { Portfolio } from "../types/ticker";
import {
  addLegacyBuiltinDisabledPluginAliases,
  addLegacyBuiltinPluginOwnerAliases,
  decodeBuiltinDisabledPluginIds,
  encodeBuiltinDisabledPluginIds,
  normalizeBuiltinPluginStateMap,
} from "../plugins/ownership";
import { isRecord } from "../utils/guards";
import {
  isLocalOnlyInstance,
  isLocalOnlyPortfolio,
  publicConfig,
  withLocalOnlyEntries,
  type LocalOnlyScope,
} from "./local-only";
import { mergeLocalBrokerPortfolioIdentity } from "./broker-identity";
import { idsOf, mergeBrokerInstances, withoutRemovedBrokerPortfolios } from "./broker-instances";
import {
  collectLayoutPayload,
  layoutIntent,
  pulledLayoutEditedAt,
  readLayoutMemo,
  shouldAdoptPulledLayout,
  withLocalSessionLayoutState,
  type LayoutMergeContext,
} from "./layout-merge";
import {
  sanitizeBrokerInstance,
  sanitizePortfolio,
  sanitizeUnknown,
  sanitizeWatchlist,
  withLocalPluginSecrets,
} from "./sanitize";

export function collectCoreConfigPayload(config: AppConfig) {
  return sanitizeUnknown({
    configVersion: config.configVersion,
    baseCurrency: config.baseCurrency,
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    portfolios: config.portfolios.map(sanitizePortfolio),
    watchlists: config.watchlists.map(sanitizeWatchlist),
    ...collectLayoutPayload(config),
    brokerInstances: config.brokerInstances.map(sanitizeBrokerInstance),
    // This build merges profiles one by one before it pushes, so a profile
    // missing from its list was removed, not one it never pulled.
    brokerInstancesMergedById: true,
    disabledPlugins: addLegacyBuiltinDisabledPluginAliases(encodeBuiltinDisabledPluginIds(config.disabledPlugins)),
    disabledSources: config.disabledSources,
    pluginConfig: addLegacyBuiltinPluginOwnerAliases(config.pluginConfig),
    theme: config.theme,
    chartPreferences: config.chartPreferences,
    valueFlashingEnabled: config.valueFlashingEnabled,
    recentTickers: config.recentTickers,
    recentCommands: config.recentCommands,
    // Completion is monotonic in synced state. A device only advertises the
    // completed state, while resumable progress and incomplete state stay local.
    onboardingComplete: config.onboardingComplete === true ? true : undefined,
    // Only whether Attention Counts is off: see mergedAttentionTelemetry.
    attentionOff: config.telemetry?.attention === false,
  });
}

/**
 * Attention Counts off belongs to the signed-in account, not to one device:
 * an off made on another device turns it off here, and an explicit on made
 * there afterwards turns it back on. The default never overrides either. An
 * edit made here since the last sync wins, like any setting. No synced copy,
 * or one from before `attentionOff` existed, reads as not off: a device's
 * first sync takes an off already on the account, and keeps its own off
 * instead of taking an on.
 */
function mergedAttentionTelemetry(
  config: AppConfig,
  baselineConfig: AppConfig,
  payload: Record<string, unknown>,
  lastSynced: Record<string, unknown> | null,
): AppConfig["telemetry"] {
  // A copy pushed by an older build says nothing either way.
  if (typeof payload.attentionOff !== "boolean") return config.telemetry;
  const localOff = config.telemetry?.attention === false;
  if (payload.attentionOff === localOff) return config.telemetry;
  const editedHere = localOff !== (baselineConfig.telemetry?.attention === false)
    || localOff !== (lastSynced?.attentionOff === true);
  if (editedHere) return config.telemetry;
  return { ...config.telemetry, attention: !payload.attentionOff };
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function isPluginStateMap(value: unknown): value is Record<string, Record<string, unknown>> {
  return isRecord(value) && Object.values(value).every(isRecord);
}

/** A pulled config without profiles and portfolios that are local-only here (an older build may have pushed them). */
function publicConfigPayload(payload: Record<string, unknown>, scope: LocalOnlyScope): Record<string, unknown> {
  const without = (entries: unknown, isLocal: (entry: Record<string, unknown>) => boolean) => (
    Array.isArray(entries) ? entries.filter((entry) => !isRecord(entry) || !isLocal(entry)) : entries
  );
  return {
    ...payload,
    ...("brokerInstances" in payload ? { brokerInstances: without(payload.brokerInstances, (entry) => isLocalOnlyInstance({ id: String(entry.id) }, scope)) } : {}),
    ...("portfolios" in payload ? { portfolios: without(payload.portfolios, (entry) => isLocalOnlyPortfolio(entry as unknown as Portfolio, scope)) } : {}),
  };
}

export function mergeConfigPayload(
  config: AppConfig,
  payload: unknown,
  baselineConfig: AppConfig = config,
  lastSyncedPayload?: unknown,
  layoutContext: LayoutMergeContext = {},
  scope: LocalOnlyScope | null = null,
): AppConfig | null {
  if (!isRecord(payload)) return null;
  if (scope) {
    // Merged as if the local-only profiles and portfolios were not here, then put back as they were.
    const local = publicConfig(config, scope);
    const merged = mergeConfigPayload(local, publicConfigPayload(payload, scope), baselineConfig === config ? local : publicConfig(baselineConfig, scope),
      lastSyncedPayload, layoutContext);
    return merged && {
      ...merged,
      brokerInstances: withLocalOnlyEntries(merged.brokerInstances, config.brokerInstances, (instance) => isLocalOnlyInstance(instance, scope)),
      portfolios: withLocalOnlyEntries(merged.portfolios, config.portfolios, (portfolio) => isLocalOnlyPortfolio(portfolio, scope)),
    };
  }
  const next: AppConfig = { ...config };
  // Two guards, both needed. baselineConfig catches edits made while this pull
  // was in flight; lastSyncedPayload catches edits made while the app was not
  // running at all (CLI writes, offline edits), which otherwise look pristine.
  const lastSynced = isRecord(lastSyncedPayload) ? lastSyncedPayload : null;
  const localPayload = collectCoreConfigPayload(config) as Record<string, unknown>;
  const matchesLastSynced = (key: string) => (
    !lastSynced || valuesEqual(localPayload[key], lastSynced[key])
  );
  const canApply = <K extends keyof AppConfig>(key: K) => (
    valuesEqual(config[key], baselineConfig[key]) && matchesLastSynced(key as string)
  );
  const assign = <K extends keyof AppConfig>(key: K) => {
    if (key in payload && canApply(key)) {
      next[key] = payload[key as string] as AppConfig[K];
    }
  };

  assign("baseCurrency");
  // A device on an older version may still send a name or sign (Canadian dollar, CA$): it applies as its code, as a saved one loads.
  if (typeof next.baseCurrency === "string" && next.baseCurrency.trim()) next.baseCurrency = normalizeStoredBaseCurrency(next.baseCurrency);
  assign("refreshIntervalMinutes");
  // Profiles before portfolios: the profiles that stay tell an account linked
  // on another device from what a removed profile left behind.
  const syncedIds = Array.isArray(lastSynced?.brokerInstances) ? idsOf(lastSynced.brokerInstances) : null;
  if (Array.isArray(payload.brokerInstances)) {
    next.brokerInstances = mergeBrokerInstances(
      config.brokerInstances,
      payload.brokerInstances as Array<Partial<BrokerInstanceConfig>>,
      canApply("brokerInstances"),
      syncedIds,
      payload.brokerInstancesMergedById === true,
    );
  }
  if ("portfolios" in payload && canApply("portfolios")) {
    const syncedPortfolios = payload.portfolios;
    next.portfolios = Array.isArray(syncedPortfolios)
      ? mergeLocalBrokerPortfolioIdentity(config.portfolios, syncedPortfolios as Portfolio[], next.brokerInstances)
      : syncedPortfolios as AppConfig["portfolios"];
  }
  assign("watchlists");
  assign("disabledSources");
  assign("theme");
  assign("chartPreferences");
  assign("valueFlashingEnabled");
  assign("recentTickers");
  assign("recentCommands");
  const telemetry = mergedAttentionTelemetry(config, baselineConfig, payload, lastSynced);
  if (telemetry !== config.telemetry) next.telemetry = telemetry;
  // Sync can complete onboarding on another device, but never reopen it.
  // Resumable progress remains local until this installation completes it.
  if (
    !config.onboardingProgress
    && config.onboardingComplete !== true
    && payload.onboardingComplete === true
    && canApply("onboardingComplete")
  ) {
    next.onboardingComplete = true;
  }

  if (
    canApply("disabledPlugins")
    && Array.isArray(payload.disabledPlugins)
    && payload.disabledPlugins.every((pluginId) => typeof pluginId === "string")
  ) {
    next.disabledPlugins = decodeBuiltinDisabledPluginIds(payload.disabledPlugins);
  }
  if (canApply("pluginConfig") && isPluginStateMap(payload.pluginConfig)) {
    next.pluginConfig = withLocalPluginSecrets(
      normalizeBuiltinPluginStateMap(payload.pluginConfig),
      config.pluginConfig,
    );
  }

  // Compared by content, not identity: the active layout mirrors pane state,
  // so a cursor settling at launch replaced it mid-pull, the pulled workspace
  // was refused, and the push that followed wrote this device's older one
  // over it on every other device.
  const localIntent = layoutIntent(localPayload);
  const adoptLayout = shouldAdoptPulledLayout({
    local: localIntent,
    atPullStart: baselineConfig === config ? localIntent : layoutIntent(collectLayoutPayload(baselineConfig)),
    lastSynced: layoutIntent(lastSynced),
    pulled: layoutIntent(payload),
    memo: readLayoutMemo(layoutContext.memo),
    pulledEditedAt: pulledLayoutEditedAt(payload, layoutContext.pushedAt),
  });
  if (adoptLayout) {
    next.layout = payload.layout as unknown as AppConfig["layout"];
    next.layouts = withLocalSessionLayoutState(payload.layouts as AppConfig["layouts"], config.layouts);
    next.activeLayoutIndex = payload.activeLayoutIndex as number;
  }

  if (Array.isArray(payload.brokerInstances) && syncedIds) {
    next.portfolios = withoutRemovedBrokerPortfolios(config, next, syncedIds, payload.portfolios);
  }
  return next;
}
