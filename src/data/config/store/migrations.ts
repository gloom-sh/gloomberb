import {
  cloneLayout,
  createDefaultConfig,
  CURRENT_CONFIG_VERSION,
  getPlacedPaneInstanceIds,
  type LayoutConfig,
} from "../../../types/config";
import {
  normalizeBuiltinDisabledPluginIds,
  normalizeBuiltinPaneStatePluginOwners,
  normalizeBuiltinPluginStateMap,
} from "../../../plugins/ownership";
import {
  extractLegacyChartIndicatorSelection,
  migrateLegacyChartSavedPaneState,
  stripLegacyChartPluginConfig,
  type LegacyChartMigrationContext,
} from "../chart-settings";
import { sanitizeLayout } from "../layout";
import { sanitizeSavedPaneState } from "./pane-state";
import { isRecord } from "../../../utils/guards";

const CLOUD_DEFAULT_CONFIG_VERSION = 13;
const BUILTIN_OWNERSHIP_AND_CHART_CONFIG_VERSION = 20;
const ONBOARDING_BACKFILL_CONFIG_VERSION = 21;
const UNREACHABLE_PANE_CLEANUP_CONFIG_VERSION = 22;

interface ConfigMigration {
  name: string;
  toVersion: number;
  migrate(saved: Record<string, unknown>, dataDir: string): Record<string, unknown>;
}

export interface ConfigMigrationResult {
  config: Record<string, unknown>;
  migrated: boolean;
  applied: string[];
}

const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [
  {
    name: "enable-cloud-by-default",
    toVersion: CLOUD_DEFAULT_CONFIG_VERSION,
    migrate: migrateCloudDefault,
  },
  {
    name: "consolidate-builtins-and-chart-state",
    toVersion: BUILTIN_OWNERSHIP_AND_CHART_CONFIG_VERSION,
    migrate: migrateBuiltinOwnershipAndChartState,
  },
  {
    name: "backfill-onboarding-complete",
    toVersion: ONBOARDING_BACKFILL_CONFIG_VERSION,
    migrate: migrateOnboardingComplete,
  },
  {
    name: "prune-unreachable-pane-instances",
    toVersion: UNREACHABLE_PANE_CLEANUP_CONFIG_VERSION,
    migrate: migrateUnreachablePaneInstances,
  },
];

export function migrateSavedConfig(saved: Record<string, unknown>, dataDir: string): ConfigMigrationResult {
  let version = savedConfigVersion(saved.configVersion);
  let config = { ...saved };
  const applied: string[] = [];

  for (const migration of CONFIG_MIGRATIONS) {
    if (migration.toVersion > CURRENT_CONFIG_VERSION || version >= migration.toVersion) continue;
    config = {
      ...migration.migrate(config, dataDir),
      configVersion: migration.toVersion,
    };
    version = migration.toVersion;
    applied.push(migration.name);
  }

  return { config, migrated: applied.length > 0, applied };
}

function savedConfigVersion(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string"))]
    : [];
}

function pluginConfigMap(value: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(value) || !Object.values(value).every(isRecord)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([pluginId, state]) => [
      pluginId,
      { ...(state as Record<string, unknown>) },
    ]),
  );
}

// Any config on disk predates this version, so the user already had a workspace and
// should never be sent back through the wizard, whatever half-finished state it holds.
function migrateOnboardingComplete(saved: Record<string, unknown>): Record<string, unknown> {
  return {
    ...saved,
    onboardingComplete: true,
    onboardingProgress: undefined,
  };
}

function migrateUnreachablePaneInstances(
  saved: Record<string, unknown>,
  dataDir: string,
): Record<string, unknown> {
  const defaults = createDefaultConfig(dataDir);
  const layout = sanitizeLayout(saved.layout, defaults.layout);
  const layouts = Array.isArray(saved.layouts)
    ? saved.layouts.map((entry) => {
      if (!isRecord(entry) || typeof entry.name !== "string") return entry;
      const entryLayout = sanitizeLayout(entry.layout, layout);
      const instanceIds = new Set(entryLayout.instances.map((instance) => instance.instanceId));
      const placedIds = new Set(getPlacedPaneInstanceIds(entryLayout));
      const paneState = isRecord(entry.paneState)
        ? Object.fromEntries(Object.entries(entry.paneState).filter(([instanceId]) => instanceIds.has(instanceId)))
        : entry.paneState;
      const focusedPaneId = typeof entry.focusedPaneId === "string" && !placedIds.has(entry.focusedPaneId)
        ? null
        : entry.focusedPaneId;
      return {
        ...entry,
        layout: entryLayout,
        paneState,
        focusedPaneId,
      };
    })
    : saved.layouts;

  return {
    ...saved,
    layout,
    layouts,
  };
}

// v0.5 shipped with Gloom Cloud in disabledPlugins by default, so without this
// those installs would upgrade onto the delayed fallback with Cloud switched off.
function migrateCloudDefault(saved: Record<string, unknown>): Record<string, unknown> {
  return {
    ...saved,
    disabledPlugins: stringList(saved.disabledPlugins)
      .filter((pluginId) => pluginId !== "gloomberb-cloud"),
  };
}

function legacyRenderMode(value: unknown): LegacyChartMigrationContext["defaultRenderMode"] {
  return value === "area"
    || value === "line"
    || value === "candles"
    || value === "ohlc"
    || value === "hlc"
    ? value
    : "area";
}

function migrateSavedLayouts(
  value: unknown,
  fallbackLayout: LayoutConfig,
  chartMigration: LegacyChartMigrationContext,
): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string") return entry;
    const layout = sanitizeLayout(entry.layout, fallbackLayout, chartMigration);
    const sanitized = sanitizeSavedPaneState(entry.paneState, layout);
    const paneState = sanitized && normalizeBuiltinPaneStatePluginOwners(sanitized);
    const migrated = migrateLegacyChartSavedPaneState(layout, paneState, entry.layout);
    return {
      ...entry,
      layout: migrated.layout,
      paneState: migrated.paneState,
    };
  });
}

function migrateBuiltinOwnershipAndChartState(
  saved: Record<string, unknown>,
  dataDir: string,
): Record<string, unknown> {
  const defaults = createDefaultConfig(dataDir);
  const normalizedPluginConfig = normalizeBuiltinPluginStateMap(pluginConfigMap(saved.pluginConfig));
  const chartPreferences = isRecord(saved.chartPreferences) ? saved.chartPreferences : {};
  const chartMigration: LegacyChartMigrationContext = {
    migrateLegacy: true,
    defaultRenderMode: legacyRenderMode(chartPreferences.defaultRenderMode),
    indicatorSelection: extractLegacyChartIndicatorSelection(normalizedPluginConfig, true),
  };
  const layout = sanitizeLayout(saved.layout, defaults.layout, chartMigration);

  return {
    ...saved,
    layout: cloneLayout(layout),
    layouts: migrateSavedLayouts(saved.layouts, layout, chartMigration),
    disabledPlugins: normalizeBuiltinDisabledPluginIds(stringList(saved.disabledPlugins)),
    pluginConfig: stripLegacyChartPluginConfig(normalizedPluginConfig),
  };
}
