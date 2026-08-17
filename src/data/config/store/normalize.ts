import type {
  AppConfig,
  BrokerInstanceConfig,
  ChartPreferences,
  LayoutConfig,
  OnboardingProgress,
  SavedLayout,
} from "../../../types/config";
import {
  cloneLayout,
  createDefaultConfig,
  CURRENT_CONFIG_VERSION,
} from "../../../types/config";
import type { Portfolio, Watchlist } from "../../../types/ticker";
import { isLanguagePreference } from "../../../i18n/languages";
import { isLayoutConfig, sanitizeLayout } from "../layout";
import { migrateSavedConfig } from "./migrations";

const CURRENT_CHART_SANITIZATION = { migrateLegacy: false } as const;

export function normalizeLoadedConfig(saved: Record<string, unknown>, dataDir: string): { config: AppConfig; needsSave: boolean } {
  const defaults = createDefaultConfig(dataDir);
  const migration = migrateSavedConfig(saved, dataDir);
  const candidate = migration.config;
  const directLayout = sanitizeLayout(candidate.layout, defaults.layout, CURRENT_CHART_SANITIZATION);
  const layouts = sanitizeSavedLayouts(candidate.layouts, directLayout);
  const activeLayoutIndex = sanitizeActiveLayoutIndex(candidate.activeLayoutIndex, layouts.length);
  const layout = cloneLayout(layouts[activeLayoutIndex]?.layout ?? directLayout);
  const syncedLayouts = layouts.map((entry, index) => (
    index === activeLayoutIndex
      ? { ...entry, layout: cloneLayout(layout), paneState: sanitizeSavedPaneState(entry.paneState, layout) }
      : entry
  ));

  const disabledPlugins = sanitizeUniqueStringList(candidate.disabledPlugins ?? defaults.disabledPlugins);
  const onboardingProgress = sanitizeOnboardingProgress(candidate.onboardingProgress);
  const onboardingComplete = onboardingProgress
    ? false
    : typeof candidate.onboardingComplete === "boolean"
      ? candidate.onboardingComplete
      : defaults.onboardingComplete;

  const config: AppConfig = {
    dataDir,
    configVersion: CURRENT_CONFIG_VERSION,
    baseCurrency: typeof candidate.baseCurrency === "string" ? candidate.baseCurrency : defaults.baseCurrency,
    refreshIntervalMinutes: typeof candidate.refreshIntervalMinutes === "number" ? candidate.refreshIntervalMinutes : defaults.refreshIntervalMinutes,
    portfolios: sanitizePortfolios(candidate.portfolios, defaults.portfolios),
    watchlists: sanitizeWatchlists(candidate.watchlists, defaults.watchlists),
    layout,
    layouts: syncedLayouts,
    activeLayoutIndex,
    brokerInstances: sanitizeBrokerInstances(candidate.brokerInstances),
    disabledPlugins,
    disabledSources: sanitizeUniqueStringList(candidate.disabledSources ?? defaults.disabledSources),
    pluginConfig: sanitizePluginConfig(candidate.pluginConfig),
    theme: typeof candidate.theme === "string" ? candidate.theme : defaults.theme,
    chartPreferences: sanitizeChartPreferences(candidate.chartPreferences, defaults.chartPreferences),
    valueFlashingEnabled: typeof candidate.valueFlashingEnabled === "boolean" ? candidate.valueFlashingEnabled : defaults.valueFlashingEnabled,
    recentTickers: sanitizeStringArray(candidate.recentTickers, defaults.recentTickers),
    language: isLanguagePreference(candidate.language) ? candidate.language : undefined,
    onboardingComplete,
    onboardingProgress,
  };

  const needsSave =
    migration.migrated
    || candidate.configVersion !== CURRENT_CONFIG_VERSION
    || !isLayoutConfig(candidate.layout)
    || !Array.isArray((candidate.layout as { instances?: unknown })?.instances)
    || !Array.isArray(candidate.layouts)
    || !Array.isArray(candidate.brokerInstances)
    || !Array.isArray(candidate.disabledSources)
    || !isPluginConfigMap(candidate.pluginConfig)
    || !isChartPreferences(candidate.chartPreferences)
    || (candidate.language !== undefined && !isLanguagePreference(candidate.language))
    || (candidate.onboardingProgress !== undefined && !sanitizeOnboardingProgress(candidate.onboardingProgress))
    || (isPlainRecord(candidate.onboardingProgress) && candidate.onboardingProgress.stage === "open-security")
    || (!!onboardingProgress && candidate.onboardingComplete !== false)
    || typeof candidate.valueFlashingEnabled !== "boolean"
    || typeof candidate.activeLayoutIndex !== "number";

  return { config, needsSave };
}

export function normalizeConfigForSave(config: AppConfig): AppConfig {
  const defaults = createDefaultConfig(config.dataDir);
  const directLayout = sanitizeLayout(config.layout, defaults.layout, CURRENT_CHART_SANITIZATION);
  const sanitizedLayouts = sanitizeSavedLayouts(config.layouts, directLayout);
  const activeLayoutIndex = sanitizeActiveLayoutIndex(config.activeLayoutIndex, sanitizedLayouts.length || 1);
  const layout = cloneLayout(sanitizedLayouts[activeLayoutIndex]?.layout ?? directLayout);
  const layouts = sanitizedLayouts.map((entry, index) => (
    index === activeLayoutIndex
      ? { ...entry, layout: cloneLayout(layout), paneState: sanitizeSavedPaneState(entry.paneState, layout) }
      : entry
  ));

  const onboardingProgress = sanitizeOnboardingProgress(config.onboardingProgress);
  const persisted: AppConfig = {
    ...config,
    configVersion: CURRENT_CONFIG_VERSION,
    portfolios: sanitizePortfolios(config.portfolios, []),
    watchlists: sanitizeWatchlists(config.watchlists, []),
    layout,
    layouts,
    activeLayoutIndex,
    brokerInstances: sanitizeBrokerInstances(config.brokerInstances),
    disabledPlugins: sanitizeUniqueStringList(config.disabledPlugins),
    disabledSources: sanitizeUniqueStringList(config.disabledSources),
    pluginConfig: sanitizePluginConfig(config.pluginConfig),
    chartPreferences: sanitizeChartPreferences(config.chartPreferences, defaults.chartPreferences),
    valueFlashingEnabled: config.valueFlashingEnabled !== false,
    recentTickers: sanitizeStringArray(config.recentTickers, []),
    onboardingComplete: onboardingProgress ? false : config.onboardingComplete,
    onboardingProgress,
  };

  return persisted;
}

const ONBOARDING_STAGES = new Set<OnboardingProgress["stage"]>([
  "welcome",
  "portfolio",
  "add-ticker",
  "account",
  "upgrade",
  "ready",
]);

function sanitizeOnboardingProgress(value: unknown): OnboardingProgress | undefined {
  if (!isPlainRecord(value) || value.version !== 1) {
    return undefined;
  }
  const stage = value.stage === "open-security" ? "account" : value.stage;
  if (!ONBOARDING_STAGES.has(stage as OnboardingProgress["stage"])) return undefined;

  const path = value.path === "manual" || value.path === "broker" ? value.path : undefined;
  const accountStatus = value.accountStatus === "signed-in" || value.accountStatus === "skipped"
    ? value.accountStatus
    : undefined;
  return {
    version: 1,
    stage: stage as OnboardingProgress["stage"],
    path,
    portfolioId: typeof value.portfolioId === "string" ? value.portfolioId : undefined,
    tickerSymbol: typeof value.tickerSymbol === "string" ? value.tickerSymbol : undefined,
    brokerName: typeof value.brokerName === "string" ? value.brokerName : undefined,
    positionsImported: typeof value.positionsImported === "number" && Number.isFinite(value.positionsImported)
      ? Math.max(0, Math.floor(value.positionsImported))
      : undefined,
    accountStatus,
    checkoutOpenedAt: typeof value.checkoutOpenedAt === "string" ? value.checkoutOpenedAt : undefined,
  };
}

function sanitizeStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : fallback;
}

function sanitizeUniqueStringList(value: unknown): string[] {
  return [...new Set(sanitizeStringArray(value, []))];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeSerializableValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeSerializableValue(entry))
      .filter((entry) => entry !== undefined);
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, sanitizeSerializableValue(entry)])
        .filter(([, entry]) => entry !== undefined),
    );
  }
  return undefined;
}

function sanitizeSavedPaneState(
  value: unknown,
  layout: LayoutConfig,
): Record<string, Record<string, unknown>> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const validPaneIds = new Set(layout.instances.map((instance) => instance.instanceId));
  const paneState = Object.fromEntries(
    Object.entries(value)
      .filter(([paneId, entry]) => validPaneIds.has(paneId) && isPlainRecord(entry))
      .map(([paneId, entry]) => {
        const sanitized = sanitizeSerializableValue(entry);
        return [paneId, sanitized];
      })
      .filter((entry): entry is [string, Record<string, unknown>] => isPlainRecord(entry[1])),
  );
  return paneState;
}

function isPluginConfigMap(value: unknown): value is Record<string, Record<string, unknown>> {
  if (!isPlainRecord(value)) return false;
  return Object.values(value).every((entry) => isPlainRecord(entry));
}

function sanitizePluginConfig(value: unknown): Record<string, Record<string, unknown>> {
  if (!isPluginConfigMap(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([pluginId, state]) => [pluginId, { ...state }]),
  );
}

function isChartPreferences(value: unknown): value is ChartPreferences {
  if (!value || typeof value !== "object") return false;
  const renderer = (value as ChartPreferences).renderer;
  return renderer === "auto" || renderer === "kitty" || renderer === "braille";
}

function sanitizeChartPreferences(value: unknown, fallback: ChartPreferences): ChartPreferences {
  if (!value || typeof value !== "object") return { ...fallback };

  const candidate = value as Partial<ChartPreferences>;
  const renderer = candidate.renderer === "auto"
    || candidate.renderer === "kitty"
    || candidate.renderer === "braille"
    ? candidate.renderer
    : fallback.renderer;

  return {
    renderer,
  };
}

function sanitizePortfolios(value: unknown, fallback: Portfolio[]): Portfolio[] {
  if (!Array.isArray(value)) return fallback.map((portfolio) => ({ ...portfolio }));
  return value
    .filter((entry): entry is Portfolio =>
      !!entry
      && typeof entry === "object"
      && typeof (entry as Portfolio).id === "string"
      && typeof (entry as Portfolio).name === "string"
      && typeof (entry as Portfolio).currency === "string",
    )
    .map((entry) => ({ ...entry }));
}

function sanitizeWatchlists(value: unknown, fallback: Watchlist[]): Watchlist[] {
  if (!Array.isArray(value)) return fallback.map((watchlist) => ({ ...watchlist }));
  return value
    .filter((entry): entry is Watchlist =>
      !!entry
      && typeof entry === "object"
      && typeof (entry as Watchlist).id === "string"
      && typeof (entry as Watchlist).name === "string",
    )
    .map((entry) => ({ ...entry }));
}

function sanitizeBrokerInstances(value: unknown): BrokerInstanceConfig[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is BrokerInstanceConfig =>
      !!entry
      && typeof entry === "object"
      && typeof (entry as BrokerInstanceConfig).id === "string"
      && typeof (entry as BrokerInstanceConfig).brokerType === "string"
      && typeof (entry as BrokerInstanceConfig).label === "string"
      && typeof (entry as BrokerInstanceConfig).config === "object"
      && (entry as BrokerInstanceConfig).config !== null,
    )
    .map((entry) => ({
      ...entry,
      enabled: entry.enabled ?? true,
      config: { ...entry.config },
    }));
}

function sanitizeSavedLayouts(
  value: unknown,
  fallbackLayout: LayoutConfig,
): SavedLayout[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [{ name: "Default", layout: cloneLayout(fallbackLayout) }];
  }

  const layouts = value
    .filter((entry): entry is SavedLayout =>
      !!entry
      && typeof entry === "object"
      && typeof (entry as SavedLayout).name === "string",
    )
    .map((entry) => {
      const layout = sanitizeLayout(entry.layout, fallbackLayout, CURRENT_CHART_SANITIZATION);
      const paneState = sanitizeSavedPaneState((entry as { paneState?: unknown }).paneState, layout);
      return {
        id: typeof entry.id === "string" ? entry.id : undefined,
        name: entry.name,
        layout,
        paneState,
        focusedPaneId: typeof entry.focusedPaneId === "string" || entry.focusedPaneId === null
          ? entry.focusedPaneId
          : undefined,
        activePanel: entry.activePanel === "right" || entry.activePanel === "left"
          ? entry.activePanel
          : undefined,
      };
    });

  return layouts.length > 0 ? layouts : [{ name: "Default", layout: cloneLayout(fallbackLayout) }];
}

function sanitizeActiveLayoutIndex(value: unknown, layoutCount: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= layoutCount) {
    return 0;
  }
  return value;
}
