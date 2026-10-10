import type {
  AppConfig,
  BrokerInstanceConfig,
  ChartPreferences,
  KeybindingsConfig,
  LayoutConfig,
  OnboardingProgress,
  LayoutOrigin,
  RecentCommand,
  SavedLayout,
  TelemetryConfig,
} from "../../../types/config";
import {
  cloneLayout,
  createDefaultConfig,
  CURRENT_CONFIG_VERSION,
  getPlacedPaneInstanceIds,
} from "../../../types/config";
import type { Portfolio, Watchlist } from "../../../types/ticker";
import { isLanguagePreference } from "../../../i18n/languages";
import { clampFontSize } from "../../../theme/font-scale";
import { isLayoutConfig, sanitizeLayout } from "../layout";
import { migrateSavedConfig, type ConfigMigrationHost } from "./migrations";
import { encodeBuiltinDisabledPluginIds, expandBuiltinPluginGroups } from "../../../plugins/ownership";
import { sanitizeSavedPaneState } from "./pane-state";
import { isRecord } from "../../../utils/guards";
import { debugLog } from "../../../utils/debug-log";
import { DEFAULT_THEME, themes } from "../../../theme/themes";
import { sanitizeStarPrompt } from "../../../app/star-prompt/model";

const configLog = debugLog.createLogger("config");
const reportedUnknownThemes = new Set<string>();

/**
 * A theme id this build does not know is kept, not replaced: a newer build on
 * another device may have saved it, and writing the default back would undo
 * that choice everywhere through sync. The app draws the default meanwhile,
 * and says so once.
 */
function sanitizeTheme(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  if (!themes[value] && !reportedUnknownThemes.has(value)) {
    reportedUnknownThemes.add(value);
    configLog.warn(`Unknown theme "${value}" in config; showing ${DEFAULT_THEME}. gloomberb config themes lists the ids.`);
  }
  return value;
}

export function normalizeLoadedConfig(
  saved: Record<string, unknown>,
  dataDir: string,
  host?: ConfigMigrationHost,
): { config: AppConfig; needsSave: boolean } {
  const defaults = createDefaultConfig(dataDir);
  const migration = migrateSavedConfig(saved, dataDir, host);
  const candidate = migration.config;
  const directLayout = sanitizeLayout(candidate.layout, defaults.layout);
  const layouts = sanitizeSavedLayouts(candidate.layouts, directLayout);
  const activeLayoutIndex = sanitizeActiveLayoutIndex(candidate.activeLayoutIndex, layouts.length);
  const layout = cloneLayout(layouts[activeLayoutIndex]?.layout ?? directLayout);
  const syncedLayouts = layouts.map((entry, index) => (
    index === activeLayoutIndex
      ? { ...entry, layout: cloneLayout(layout), paneState: sanitizeSavedPaneState(entry.paneState, layout) }
      : entry
  ));

  // After the migrations, which read retired group ids as they were saved.
  const disabledPlugins = expandBuiltinPluginGroups(
    sanitizeUniqueStringList(candidate.disabledPlugins ?? defaults.disabledPlugins),
  );
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
    seededPlugins: sanitizeUniqueStringList(candidate.seededPlugins),
    ...(candidate.portfolioCurrenciesAdopted === true ? { portfolioCurrenciesAdopted: true } : {}),
    disabledSources: sanitizeUniqueStringList(candidate.disabledSources ?? defaults.disabledSources),
    pluginConfig: sanitizePluginConfig(candidate.pluginConfig),
    theme: sanitizeTheme(candidate.theme, defaults.theme),
    chartPreferences: sanitizeChartPreferences(candidate.chartPreferences, defaults.chartPreferences),
    valueFlashingEnabled: typeof candidate.valueFlashingEnabled === "boolean" ? candidate.valueFlashingEnabled : defaults.valueFlashingEnabled,
    fontSize: sanitizeFontSize(candidate.fontSize, defaults.fontSize),
    recentTickers: sanitizeStringArray(candidate.recentTickers, defaults.recentTickers),
    recentCommands: sanitizeRecentCommands(candidate.recentCommands, defaults.recentCommands),
    language: isLanguagePreference(candidate.language) ? candidate.language : undefined,
    onboardingComplete,
    onboardingProgress,
    lastLaunchedVersion: typeof candidate.lastLaunchedVersion === "string" ? candidate.lastLaunchedVersion : undefined,
    ...withKeybindings(sanitizeKeybindings(candidate.keybindings)),
    ...withTelemetry(sanitizeTelemetry(candidate.telemetry)),
    ...withStarPrompt(sanitizeStarPrompt(candidate.starPrompt)),
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
    || (isRecord(candidate.onboardingProgress) && candidate.onboardingProgress.stage === "open-security")
    || (!!onboardingProgress && candidate.onboardingComplete !== false)
    || typeof candidate.valueFlashingEnabled !== "boolean"
    || typeof candidate.activeLayoutIndex !== "number";

  return { config, needsSave };
}

export function normalizeConfigForSave(config: AppConfig): AppConfig {
  const defaults = createDefaultConfig(config.dataDir);
  const directLayout = sanitizeLayout(config.layout, defaults.layout);
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
    // Older apps read the retired group ids, so a group that is all off is saved as one.
    disabledPlugins: encodeBuiltinDisabledPluginIds(sanitizeUniqueStringList(config.disabledPlugins)),
    seededPlugins: sanitizeUniqueStringList(config.seededPlugins),
    disabledSources: sanitizeUniqueStringList(config.disabledSources),
    pluginConfig: sanitizePluginConfig(config.pluginConfig),
    chartPreferences: sanitizeChartPreferences(config.chartPreferences, defaults.chartPreferences),
    valueFlashingEnabled: config.valueFlashingEnabled !== false,
    fontSize: sanitizeFontSize(config.fontSize, defaults.fontSize),
    recentTickers: sanitizeStringArray(config.recentTickers, []),
    recentCommands: sanitizeRecentCommands(config.recentCommands, []),
    onboardingComplete: onboardingProgress ? false : config.onboardingComplete,
    onboardingProgress,
  };
  delete persisted.keybindings;
  Object.assign(persisted, withKeybindings(sanitizeKeybindings(config.keybindings)));
  delete persisted.telemetry;
  Object.assign(persisted, withTelemetry(sanitizeTelemetry(config.telemetry)));
  delete persisted.starPrompt;
  Object.assign(persisted, withStarPrompt(sanitizeStarPrompt(config.starPrompt)));

  return persisted;
}

function withKeybindings(keybindings: KeybindingsConfig | undefined): Pick<AppConfig, "keybindings"> {
  return keybindings ? { keybindings } : {};
}

function withTelemetry(telemetry: TelemetryConfig | undefined): Pick<AppConfig, "telemetry"> {
  return telemetry ? { telemetry } : {};
}

function withStarPrompt(starPrompt: AppConfig["starPrompt"]): Pick<AppConfig, "starPrompt"> {
  return starPrompt ? { starPrompt } : {};
}

/** Only the switches that are set survive; an empty object is the same as none. */
function sanitizeTelemetry(value: unknown): TelemetryConfig | undefined {
  if (!isRecord(value)) return undefined;
  const telemetry: TelemetryConfig = {
    ...(typeof value.crashReports === "boolean" ? { crashReports: value.crashReports } : {}),
    ...(typeof value.usage === "boolean" ? { usage: value.usage } : {}),
    ...(typeof value.attention === "boolean" ? { attention: value.attention } : {}),
  };
  return Object.keys(telemetry).length > 0 ? telemetry : undefined;
}

/**
 * Keeps the shape honest without judging the contents: a chord that does not
 * parse stays in the file and is reported when the table resolves, so a typo
 * is something the user can see and fix rather than something that vanishes.
 */
function sanitizeKeybindings(value: unknown): KeybindingsConfig | undefined {
  if (!isRecord(value)) return undefined;
  const actions: Record<string, string | string[] | null> = {};
  if (isRecord(value.actions)) {
    for (const [actionId, binding] of Object.entries(value.actions)) {
      if (!actionId.trim()) continue;
      if (binding === null || typeof binding === "string") {
        actions[actionId] = binding;
      } else if (Array.isArray(binding)) {
        actions[actionId] = binding.filter((entry): entry is string => typeof entry === "string");
      }
    }
  }
  const commands: Record<string, string> = {};
  if (isRecord(value.commands)) {
    for (const [chord, query] of Object.entries(value.commands)) {
      if (chord.trim() && typeof query === "string" && query.trim()) commands[chord] = query;
    }
  }
  const hasActions = Object.keys(actions).length > 0;
  const hasCommands = Object.keys(commands).length > 0;
  if (!hasActions && !hasCommands) return undefined;
  return {
    ...(hasActions ? { actions } : {}),
    ...(hasCommands ? { commands } : {}),
  };
}

function sanitizeFontSize(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clampFontSize(value);
}

const ONBOARDING_STAGES = new Set<OnboardingProgress["stage"]>([
  "welcome",
  "portfolio",
  "add-ticker",
  "desks",
  "research",
  "verify",
  "account",
  "upgrade",
  "ready",
]);

function sanitizeOnboardingProgress(value: unknown): OnboardingProgress | undefined {
  if (!isRecord(value) || value.version !== 1) {
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
    desks: Array.isArray(value.desks) ? sanitizeUniqueStringList(value.desks) : undefined,
  };
}

function sanitizeStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : fallback;
}

function sanitizeRecentCommands(value: unknown, fallback: RecentCommand[]): RecentCommand[] {
  if (!Array.isArray(value)) return fallback;
  return value
    .filter((entry): entry is RecentCommand => (
      !!entry
      && typeof entry === "object"
      && typeof (entry as RecentCommand).id === "string"
      && (entry as RecentCommand).id.length > 0
      && typeof (entry as RecentCommand).label === "string"
    ))
    .map((entry) => {
      const arg = typeof entry.arg === "string" && entry.arg.length > 0 ? entry.arg : undefined;
      return {
        id: entry.id,
        label: entry.label,
        ...(arg ? { arg } : {}),
      };
    });
}

function sanitizeUniqueStringList(value: unknown): string[] {
  return [...new Set(sanitizeStringArray(value, []))];
}

function isPluginConfigMap(value: unknown): value is Record<string, Record<string, unknown>> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => isRecord(entry));
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
    .map(sanitizePortfolioAllocation);
}

/** Cash and target weights the portfolio commands write; anything else is dropped. */
function sanitizePortfolioAllocation(entry: Portfolio): Portfolio {
  const { cash, targetWeights, ...portfolio } = entry;
  const next: Portfolio = { ...portfolio };
  if (isRecord(cash) && typeof cash.amount === "number" && Number.isFinite(cash.amount)
    && typeof cash.currency === "string" && /^[A-Z]{3}$/.test(cash.currency)) {
    next.cash = { amount: cash.amount, currency: cash.currency };
  }
  if (isRecord(targetWeights)) {
    const weights = Object.entries(targetWeights).filter((weight): weight is [string, number] =>
      !!weight[0].trim() && typeof weight[1] === "number" && Number.isFinite(weight[1]) && weight[1] >= 0 && weight[1] <= 100);
    if (weights.length > 0) next.targetWeights = Object.fromEntries(weights);
  }
  return next;
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

function sanitizeLayoutOrigin(value: unknown): LayoutOrigin | undefined {
  if (!value || typeof value !== "object") return undefined;
  const origin = value as Partial<LayoutOrigin>;
  if (
    origin.kind !== "team"
    || typeof origin.teamId !== "string" || !origin.teamId
    || typeof origin.layoutId !== "string" || !origin.layoutId
    || typeof origin.revision !== "number" || !Number.isInteger(origin.revision) || origin.revision < 1
    || typeof origin.contentHash !== "string"
    || typeof origin.syncedAt !== "string"
  ) return undefined;
  return {
    kind: "team",
    teamId: origin.teamId,
    layoutId: origin.layoutId,
    revision: origin.revision,
    contentHash: origin.contentHash,
    syncedAt: origin.syncedAt,
  };
}

// Saved layouts are sanitized on every config write. A layout object that
// has not been replaced since the last write sanitizes to the same result.
const sanitizedLayouts = new WeakMap<object, LayoutConfig>();
const sanitizedPaneStates = new WeakMap<object, { layout: LayoutConfig; result: ReturnType<typeof sanitizeSavedPaneState> }>();

function sanitizeSavedLayoutOnce(value: unknown, fallbackLayout: LayoutConfig): LayoutConfig {
  // An invalid value sanitizes to a copy of the fallback, which is not a
  // function of the value alone.
  if (!isLayoutConfig(value)) return sanitizeLayout(value, fallbackLayout);
  const cached = sanitizedLayouts.get(value);
  if (cached) return cached;
  const layout = sanitizeLayout(value, fallbackLayout);
  sanitizedLayouts.set(value, layout);
  return layout;
}

function sanitizeSavedPaneStateOnce(value: unknown, layout: LayoutConfig): ReturnType<typeof sanitizeSavedPaneState> {
  if (!value || typeof value !== "object") return sanitizeSavedPaneState(value, layout);
  const cached = sanitizedPaneStates.get(value);
  if (cached && cached.layout === layout) return cached.result;
  const result = sanitizeSavedPaneState(value, layout);
  sanitizedPaneStates.set(value, { layout, result });
  return result;
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
      const layout = sanitizeSavedLayoutOnce(entry.layout, fallbackLayout);
      const placedPaneIds = new Set(getPlacedPaneInstanceIds(layout));
      const paneState = sanitizeSavedPaneStateOnce((entry as { paneState?: unknown }).paneState, layout);
      return {
        id: typeof entry.id === "string" ? entry.id : undefined,
        name: entry.name,
        layout,
        paneState,
        focusedPaneId: typeof entry.focusedPaneId === "string"
          ? placedPaneIds.has(entry.focusedPaneId) ? entry.focusedPaneId : null
          : entry.focusedPaneId === null ? null : undefined,
        ...(sanitizeLayoutOrigin(entry.origin) ? { origin: sanitizeLayoutOrigin(entry.origin) } : {}),
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
