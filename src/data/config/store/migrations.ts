import {
  cloneLayout,
  createDefaultConfig,
  CURRENT_CONFIG_VERSION,
  DEFAULT_COLUMNS,
  DEFAULT_PORTFOLIO_COLUMN_IDS,
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

const CLOUD_DEFAULT_CONFIG_VERSION = 13;
const CLOUD_MACRO_SPLIT_CONFIG_VERSION = 15;
const PORTFOLIO_DEFAULT_COLUMNS_CONFIG_VERSION = 17;
const BUILTIN_OWNERSHIP_AND_CHART_CONFIG_VERSION = 20;
const ONBOARDING_BACKFILL_CONFIG_VERSION = 21;
const UNREACHABLE_PANE_CLEANUP_CONFIG_VERSION = 22;

const LEGACY_MAIN_PORTFOLIO_COLUMN_IDS = DEFAULT_COLUMNS.map((column) => column.id);
const PRE_SPARKLINE_PORTFOLIO_COLUMN_IDS = [
  ...DEFAULT_COLUMNS.map((column) => column.id),
  "shares",
  "avg_cost",
  "cost_basis",
  "mkt_value",
  "pnl",
  "pnl_pct",
];
const PRE_DAY_PNL_PORTFOLIO_COLUMN_IDS = [
  ...DEFAULT_COLUMNS.map((column) => column.id),
  "sparkline",
  "shares",
  "avg_cost",
  "cost_basis",
  "mkt_value",
  "pnl",
  "pnl_pct",
];
const BUILTIN_SOURCE_IDS = new Set(["yahoo", "gloomberb-cloud"]);

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
    name: "split-cloud-macro-and-data-sources",
    toVersion: CLOUD_MACRO_SPLIT_CONFIG_VERSION,
    migrate: migrateCloudMacroAndSources,
  },
  {
    name: "refresh-portfolio-default-columns",
    toVersion: PORTFOLIO_DEFAULT_COLUMNS_CONFIG_VERSION,
    migrate: migratePortfolioDefaultColumns,
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string"))]
    : [];
}

function pluginConfigMap(value: unknown): Record<string, Record<string, unknown>> {
  if (!isPlainRecord(value) || !Object.values(value).every(isPlainRecord)) return {};
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
      if (!isPlainRecord(entry) || typeof entry.name !== "string") return entry;
      const entryLayout = sanitizeLayout(entry.layout, layout);
      const instanceIds = new Set(entryLayout.instances.map((instance) => instance.instanceId));
      const placedIds = new Set(getPlacedPaneInstanceIds(entryLayout));
      const paneState = isPlainRecord(entry.paneState)
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

function migrateCloudDefault(saved: Record<string, unknown>): Record<string, unknown> {
  return {
    ...saved,
    disabledPlugins: stringList(saved.disabledPlugins)
      .filter((pluginId) => pluginId !== "gloomberb-cloud"),
  };
}

function migrateCloudMacroAndSources(saved: Record<string, unknown>): Record<string, unknown> {
  const disabledPlugins = stringList(saved.disabledPlugins);
  if (disabledPlugins.includes("gloomberb-cloud") && !disabledPlugins.includes("macro")) {
    disabledPlugins.push("macro");
  }
  const disabledSources = new Set(stringList(saved.disabledSources));
  for (const pluginId of disabledPlugins) {
    if (BUILTIN_SOURCE_IDS.has(pluginId)) disabledSources.add(pluginId);
  }
  return {
    ...saved,
    disabledPlugins,
    disabledSources: [...disabledSources],
  };
}

function hasExactColumnIds(value: unknown, expected: string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function shouldMigratePortfolioColumnIds(value: unknown): boolean {
  return hasExactColumnIds(value, LEGACY_MAIN_PORTFOLIO_COLUMN_IDS)
    || hasExactColumnIds(value, PRE_SPARKLINE_PORTFOLIO_COLUMN_IDS)
    || hasExactColumnIds(value, PRE_DAY_PNL_PORTFOLIO_COLUMN_IDS);
}

function migratePortfolioColumnsInLayout(value: unknown): unknown {
  if (!isPlainRecord(value) || !Array.isArray(value.instances)) return value;
  let changed = false;
  const instances = value.instances.map((instance) => {
    if (!isPlainRecord(instance) || instance.paneId !== "portfolio-list" || !isPlainRecord(instance.settings)) {
      return instance;
    }
    if (!shouldMigratePortfolioColumnIds(instance.settings.columnIds)) return instance;
    changed = true;
    return {
      ...instance,
      settings: {
        ...instance.settings,
        columnIds: [...DEFAULT_PORTFOLIO_COLUMN_IDS],
      },
    };
  });
  return changed ? { ...value, instances } : value;
}

function migratePortfolioDefaultColumns(saved: Record<string, unknown>): Record<string, unknown> {
  return {
    ...saved,
    layout: migratePortfolioColumnsInLayout(saved.layout),
    layouts: Array.isArray(saved.layouts)
      ? saved.layouts.map((entry) => isPlainRecord(entry)
        ? { ...entry, layout: migratePortfolioColumnsInLayout(entry.layout) }
        : entry)
      : saved.layouts,
  };
}

function sanitizeSerializableValue(value: unknown): unknown {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
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

function migrationPaneState(
  value: unknown,
  layout: LayoutConfig,
): Record<string, Record<string, unknown>> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const validPaneIds = new Set(layout.instances.map((instance) => instance.instanceId));
  const paneState = Object.fromEntries(
    Object.entries(value)
      .filter(([paneId, entry]) => validPaneIds.has(paneId) && isPlainRecord(entry))
      .map(([paneId, entry]) => [paneId, sanitizeSerializableValue(entry)])
      .filter((entry): entry is [string, Record<string, unknown>] => isPlainRecord(entry[1])),
  );
  return normalizeBuiltinPaneStatePluginOwners(paneState);
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
    if (!isPlainRecord(entry) || typeof entry.name !== "string") return entry;
    const layout = sanitizeLayout(entry.layout, fallbackLayout, chartMigration);
    const paneState = migrationPaneState(entry.paneState, layout);
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
  const chartPreferences = isPlainRecord(saved.chartPreferences) ? saved.chartPreferences : {};
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
