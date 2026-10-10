import type { PaneSettingOption, PaneSettingsDef, PaneTemplateContext } from "../../../types/plugin";
import { DEFAULT_COLUMNS, DEFAULT_PORTFOLIO_COLUMN_IDS, type AppConfig, type ColumnConfig } from "../../../types/config";
import { PRICE_SPARKLINE_COLUMN_ID, PRICE_SPARKLINE_PERIOD_LABEL } from "../../../components/price-sparkline/view";
import { t } from "../../../i18n";

type CollectionScope = "all" | "portfolios" | "watchlists" | "custom";
export type PortfolioViewMode = "table" | "grid";

export interface PortfolioPaneSettings {
  columnIds: string[];
  collectionScope: CollectionScope;
  visibleCollectionIds: string[];
  viewMode: PortfolioViewMode;
  hideHeader: boolean;
  hideCash: boolean;
}

export interface CollectionEntry {
  id: string;
  name: string;
  kind: "portfolio" | "watchlist";
}

const PORTFOLIO_COLUMN_DEFS: ColumnConfig[] = [
  ...DEFAULT_COLUMNS,
  { id: PRICE_SPARKLINE_COLUMN_ID, label: PRICE_SPARKLINE_PERIOD_LABEL, width: 6, align: "left" },
  { id: "name", label: "NAME", width: 16, align: "left" },
  { id: "asset_type", label: "TYPE", width: 5, align: "left" },
  { id: "exchange", label: "EXCH", width: 8, align: "left" },
  { id: "currency", label: "CCY", width: 4, align: "left" },
  { id: "sector", label: "SECTOR", width: 14, align: "left" },
  { id: "industry", label: "INDUSTRY", width: 16, align: "left" },
  { id: "tags", label: "TAGS", width: 14, align: "left" },
  { id: "volume", label: "VOL", width: 8, align: "right", format: "compact" },
  { id: "dollar_volume", label: "$VOL", width: 9, align: "right", format: "compact" },
  { id: "range_52w", label: "52W%", width: 7, align: "right", format: "percent" },
  { id: "bid", label: "BID", width: 10, align: "right", format: "currency" },
  { id: "ask", label: "ASK", width: 10, align: "right", format: "currency" },
  { id: "spread", label: "SPREAD", width: 10, align: "right", format: "currency" },
  { id: "spread_pct", label: "SPR%", width: 7, align: "right", format: "percent" },
  { id: "bid_ask_size", label: "B/A SZ", width: 9, align: "right", format: "compact" },
  { id: "change", label: "CHG", width: 9, align: "right", format: "currency" },
  { id: "ext_hours", label: "EXT%", width: 8, align: "right", format: "percent" },
  { id: "dividend_yield", label: "DIV%", width: 7, align: "right", format: "percent" },
  { id: "target", label: "TARGET", width: 10, align: "right", format: "currency" },
  { id: "target_pct", label: "TARGET%", width: 8, align: "right", format: "percent" },
  { id: "rating", label: "RATING", width: 7, align: "right", format: "number" },
  { id: "ex_div", label: "EX-DIV", width: 7, align: "right" },
  { id: "next_earn", label: "ERN", width: 7, align: "right" },
  { id: "side", label: "SIDE", width: 5, align: "left" },
  { id: "shares", label: "SHARES", width: 9, align: "right", format: "number" },
  { id: "avg_cost", label: "AVG COST", width: 10, align: "right", format: "currency" },
  { id: "cost_basis", label: "COST", width: 10, align: "right", format: "compact" },
  { id: "mkt_value", label: "MKT VAL", width: 10, align: "right", format: "compact" },
  { id: "weight", label: "WEIGHT", width: 8, align: "right", format: "percent" },
  // TARGET is the analyst price target; these are the portfolio's own target weights.
  { id: "target_weight", label: "TGT WT", width: 7, align: "right", format: "percent" },
  { id: "drift", label: "DRIFT", width: 8, align: "right", format: "percent" },
  { id: "trade", label: "TRADE", width: 9, align: "right", format: "number" },
  { id: "trade_value", label: "TRADE VAL", width: 10, align: "right", format: "compact" },
  { id: "day_pnl", label: "DAY", width: 10, align: "right", format: "compact" },
  { id: "pnl", label: "P&L", width: 10, align: "right", format: "compact" },
  { id: "pnl_pct", label: "P&L%", width: 8, align: "right", format: "percent" },
  { id: "mark_delta", label: "MARK%", width: 8, align: "right", format: "percent" },
  { id: "acq_date", label: "ACQ", width: 7, align: "right" },
  { id: "held", label: "HELD", width: 6, align: "right" },
];

const PORTFOLIO_COLUMNS_BY_ID = new Map(PORTFOLIO_COLUMN_DEFS.map((column) => [column.id, column]));
const PORTFOLIO_ONLY_COLUMN_IDS = new Set([
  "side",
  "shares",
  "avg_cost",
  "cost_basis",
  "mkt_value",
  "weight",
  "target_weight",
  "drift",
  "trade",
  "trade_value",
  "day_pnl",
  "pnl",
  "pnl_pct",
  "mark_delta",
  "acq_date",
  "held",
]);
const COLLECTION_SCOPE_OPTIONS: PaneSettingOption[] = [
  {
    value: "all",
    label: "All Collections",
    description: "Show portfolios and watchlists in this pane.",
  },
  {
    value: "portfolios",
    label: "Portfolios Only",
    description: "Limit the pane to portfolios.",
  },
  {
    value: "watchlists",
    label: "Watchlists Only",
    description: "Limit the pane to watchlists.",
  },
  {
    value: "custom",
    label: "Custom Selection",
    description: "Choose exactly which collections this pane should show.",
  },
];
const VIEW_MODE_OPTIONS: PaneSettingOption[] = [
  {
    value: "table",
    label: "Table",
    description: "Show positions in the portfolio table.",
  },
  {
    value: "grid",
    label: "Grid",
    description: "Show positions in the portfolio grid.",
  },
];

function isCollectionScope(value: unknown): value is CollectionScope {
  return value === "all" || value === "portfolios" || value === "watchlists" || value === "custom";
}

function isPortfolioViewMode(value: unknown): value is PortfolioViewMode {
  return value === "table" || value === "grid";
}

function filterCollectionEntries(entries: CollectionEntry[], settings: PortfolioPaneSettings): CollectionEntry[] {
  switch (settings.collectionScope) {
    case "portfolios":
      return entries.filter((entry) => entry.kind === "portfolio");
    case "watchlists":
      return entries.filter((entry) => entry.kind === "watchlist");
    case "custom": {
      const selectedIds = new Set(settings.visibleCollectionIds);
      return entries.filter((entry) => selectedIds.has(entry.id));
    }
    default:
      return entries;
  }
}

function resolveCollectionOptions(entries: CollectionEntry[]): PaneSettingOption[] {
  return entries.map((entry) => ({
    value: entry.id,
    label: entry.name,
    description: t(entry.kind === "portfolio" ? "Portfolio" : "Watchlist"),
  }));
}

/** Columns that read a portfolio's target weights. */
const TARGET_COLUMN_IDS = new Set(["target_weight", "drift", "trade", "trade_value"]);
/** What a portfolio with targets shows when the pane's columns name none of them. */
const REBALANCE_COLUMN_IDS = ["weight", "target_weight", "drift", "trade"];

/**
 * A portfolio with target weights shows WEIGHT, TGT WT, DRIFT and TRADE beside
 * its market value, unless the pane's columns already pick target columns.
 */
function withTargetColumns(columnIds: string[]): string[] {
  if (columnIds.some((id) => TARGET_COLUMN_IDS.has(id))) return columnIds;
  const missing = REBALANCE_COLUMN_IDS.filter((id) => !columnIds.includes(id));
  const anchor = columnIds.includes("weight") ? columnIds.indexOf("weight") : columnIds.indexOf("mkt_value");
  const at = anchor >= 0 ? anchor + 1 : columnIds.length;
  return [...columnIds.slice(0, at), ...missing, ...columnIds.slice(at)];
}

function describeColumnOption(column: ColumnConfig): string {
  if (column.id === PRICE_SPARKLINE_COLUMN_ID) return "One-month price sparkline.";
  if (TARGET_COLUMN_IDS.has(column.id)) return "Shown by default once the portfolio has target weights.";
  return PORTFOLIO_ONLY_COLUMN_IDS.has(column.id)
    ? "Visible only when this pane is showing a portfolio."
    : "Visible for watchlists and portfolios.";
}

export function getPortfolioPaneSettings(settings: Record<string, unknown> | undefined): PortfolioPaneSettings {
  const columnIds = Array.isArray(settings?.columnIds)
    ? settings.columnIds.filter((value): value is string => typeof value === "string")
    : DEFAULT_PORTFOLIO_COLUMN_IDS;
  const visibleCollectionIds = Array.isArray(settings?.visibleCollectionIds)
    ? settings.visibleCollectionIds.filter((value): value is string => typeof value === "string")
    : [];

  return {
    columnIds: columnIds.length > 0 ? columnIds : DEFAULT_PORTFOLIO_COLUMN_IDS,
    collectionScope: isCollectionScope(settings?.collectionScope) ? settings.collectionScope : "all",
    visibleCollectionIds,
    viewMode: isPortfolioViewMode(settings?.viewMode) ? settings.viewMode : "table",
    hideHeader: settings?.hideHeader === true,
    hideCash: settings?.hideCash === true,
  };
}

export function cleanPortfolioPaneSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const nextSettings = { ...settings };
  delete nextSettings.hideTabs;
  delete nextSettings.lockedCollectionId;
  delete nextSettings.showSparklines;
  if (nextSettings.collectionScope !== "custom") {
    delete nextSettings.visibleCollectionIds;
  }
  return nextSettings;
}

export function getCollectionEntries(config: AppConfig): CollectionEntry[] {
  return [
    ...config.portfolios.map((portfolio) => ({
      id: portfolio.id,
      name: portfolio.name,
      kind: "portfolio" as const,
    })),
    ...config.watchlists.map((watchlist) => ({
      id: watchlist.id,
      name: watchlist.name,
      kind: "watchlist" as const,
    })),
  ];
}

export function resolveScopedCollectionEntries(entries: CollectionEntry[], settings: PortfolioPaneSettings): CollectionEntry[] {
  const filtered = filterCollectionEntries(entries, settings);
  if (settings.collectionScope === "custom" && filtered.length === 0 && entries[0]) {
    return [entries[0]];
  }
  return filtered;
}

export function resolveActiveCollectionId(
  currentCollectionId: string,
  visibleCollections: CollectionEntry[],
): string {
  if (visibleCollections.length === 0) return "";
  if (visibleCollections.some((entry) => entry.id === currentCollectionId)) {
    return currentCollectionId;
  }
  return visibleCollections[0]?.id ?? "";
}

export function resolvePortfolioPaneCollectionId(
  config: AppConfig,
  rawSettings: Record<string, unknown> | undefined,
  currentCollectionId: string,
): string {
  const settings = getPortfolioPaneSettings(rawSettings);
  const visibleCollections = resolveScopedCollectionEntries(getCollectionEntries(config), settings);
  return resolveActiveCollectionId(currentCollectionId, visibleCollections);
}

export function resolveVisibleColumns(
  columnIds: string[],
  isPortfolioTab: boolean,
  { targetWeights = false }: { targetWeights?: boolean } = {},
): ColumnConfig[] {
  const resolved = (isPortfolioTab && targetWeights ? withTargetColumns(columnIds) : columnIds)
    .map((columnId) => PORTFOLIO_COLUMNS_BY_ID.get(columnId))
    .filter((column): column is ColumnConfig => column != null)
    .filter((column) => isPortfolioTab || !PORTFOLIO_ONLY_COLUMN_IDS.has(column.id));

  if (resolved.length > 0) {
    return resolved.map((column) => ({ ...column, label: t(column.label) }));
  }

  return DEFAULT_PORTFOLIO_COLUMN_IDS
    .map((columnId) => PORTFOLIO_COLUMNS_BY_ID.get(columnId))
    .filter((column): column is ColumnConfig => column != null)
    .filter((column) => isPortfolioTab || !PORTFOLIO_ONLY_COLUMN_IDS.has(column.id))
    .map((column) => ({ ...column, label: t(column.label) }));
}

export function buildPortfolioPaneSettingsDef(
  config: AppConfig,
  settings: PortfolioPaneSettings,
  activeCollectionId?: string | null,
): PaneSettingsDef {
  const collectionEntries = getCollectionEntries(config);
  const allCollectionOptions = resolveCollectionOptions(collectionEntries);
  const activeCollectionIsPortfolio = !!activeCollectionId
    && config.portfolios.some((portfolio) => portfolio.id === activeCollectionId);

  const fields: PaneSettingsDef["fields"] = [
    {
      key: "columnIds",
      label: "Columns",
      type: "ordered-multi-select",
      options: PORTFOLIO_COLUMN_DEFS.map((column) => ({
        value: column.id,
        label: column.label,
        description: describeColumnOption(column),
      })),
    },
    {
      key: "collectionScope",
      label: "Collections",
      type: "select",
      options: COLLECTION_SCOPE_OPTIONS,
    },
  ];

  if (activeCollectionIsPortfolio) {
    fields.push({
      key: "viewMode",
      label: "View",
      type: "select",
      options: VIEW_MODE_OPTIONS,
    });
  }

  if (settings.collectionScope === "custom") {
    fields.push({
      key: "visibleCollectionIds",
      label: "Visible Collections",
      type: "multi-select",
      options: allCollectionOptions,
    });
  }

  fields.push({
    key: "hideHeader",
    label: "Hide Header Bar",
    type: "toggle",
  });
  fields.push({
    key: "hideCash",
    label: "Hide Cash Positions",
    type: "toggle",
  });
  return {
    title: "Portfolio Pane Settings",
    values: {
      ...settings,
      columnIds: [...settings.columnIds],
      visibleCollectionIds: [...settings.visibleCollectionIds],
      viewMode: settings.viewMode,
    },
    fields,
  };
}

export function resolveCollectionPaneId(context: PaneTemplateContext): string | null {
  if (context.activeCollectionId) {
    const isPortfolio = context.config.portfolios.some((portfolio) => portfolio.id === context.activeCollectionId);
    const isWatchlist = context.config.watchlists.some((watchlist) => watchlist.id === context.activeCollectionId);
    if (isPortfolio || isWatchlist) {
      return context.activeCollectionId;
    }
  }

  return context.config.portfolios[0]?.id ?? context.config.watchlists[0]?.id ?? null;
}
