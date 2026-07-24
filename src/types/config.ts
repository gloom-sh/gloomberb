import type { Portfolio, Watchlist } from "./ticker";
import type { LanguagePreference } from "../i18n/languages";

export const CURRENT_CONFIG_VERSION = 20;

type DefaultChartRenderMode = "area" | "line" | "candles" | "ohlc" | "hlc";
type ChartRendererPreference = "auto" | "kitty" | "braille";

export interface ChartPreferences {
  defaultRenderMode: DefaultChartRenderMode;
  renderer: ChartRendererPreference;
}

export interface BrokerInstanceConfig {
  id: string;
  brokerType: string;
  label: string;
  connectionMode?: string;
  config: Record<string, unknown>;
  enabled?: boolean;
  lastSyncedAt?: number;
}

export interface ColumnConfig {
  id: string;
  label: string;
  width: number;
  align: "left" | "right";
  format?: "currency" | "percent" | "number" | "compact";
}

export type PaneBinding =
  | { kind: "none" }
  | { kind: "fixed"; symbol: string }
  | { kind: "follow"; sourceInstanceId: string };

export interface DockedPlacementMemory {
  path?: Array<0 | 1>;
  anchorInstanceId?: string;
  position?: "left" | "right" | "above" | "below";
}

export interface FloatingPlacementMemory {
  x: number;
  y: number;
  width: number;
  height: number;
  fixedGeometry?: boolean;
}

export interface DetachedPlacementMemory {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanePlacementMemory {
  docked?: DockedPlacementMemory;
  floating?: FloatingPlacementMemory;
  detached?: DetachedPlacementMemory;
}

export interface PaneInstanceConfig {
  instanceId: string;
  paneId: string;
  title?: string;
  binding?: PaneBinding;
  params?: Record<string, string>;
  settings?: Record<string, unknown>;
  placementMemory?: PanePlacementMemory;
}

interface DockPaneNode {
  kind: "pane";
  instanceId: string;
}

export interface DockSplitNode {
  kind: "split";
  axis: "horizontal" | "vertical";
  ratio: number;
  first: DockLayoutNode;
  second: DockLayoutNode;
}

export type DockLayoutNode = DockPaneNode | DockSplitNode;

export interface FloatingPaneEntry {
  instanceId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex?: number;
  fixedGeometry?: boolean;
}

interface DetachedPaneEntry {
  instanceId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutConfig {
  dockRoot: DockLayoutNode | null;
  instances: PaneInstanceConfig[];
  floating: FloatingPaneEntry[];
  detached: DetachedPaneEntry[];
}

export interface SavedLayout {
  id?: string;
  name: string;
  layout: LayoutConfig;
  paneState?: Record<string, Record<string, unknown>>;
  focusedPaneId?: string | null;
  activePanel?: "left" | "right";
}

export interface AppConfig {
  dataDir: string;
  configVersion: number;
  baseCurrency: string;
  refreshIntervalMinutes: number;
  portfolios: Portfolio[];
  watchlists: Watchlist[];
  layout: LayoutConfig;
  layouts: SavedLayout[];
  activeLayoutIndex: number;
  brokerInstances: BrokerInstanceConfig[];
  disabledPlugins: string[];
  disabledSources: string[];
  pluginConfig: Record<string, Record<string, unknown>>;
  theme: string;
  chartPreferences: ChartPreferences;
  valueFlashingEnabled: boolean;
  recentTickers: string[];
  language?: LanguagePreference;
  onboardingComplete?: boolean;
}

export const TICKER_RESEARCH_PANE_ID = "ticker-research";
export const LEGACY_TICKER_DETAIL_PANE_ID = "ticker-detail";

export function normalizePaneId(paneId: string): string {
  return paneId === LEGACY_TICKER_DETAIL_PANE_ID ? TICKER_RESEARCH_PANE_ID : paneId;
}

const TICKER_PANE_IDS = new Set([
  TICKER_RESEARCH_PANE_ID,
  LEGACY_TICKER_DETAIL_PANE_ID,
  "financial-analysis",
  "ticker-chart",
  "quote-monitor",
  "ticker-news",
  "notes",
  "options",
  "holders",
  "sec",
  "insider",
  "analyst-research",
  "corporate-actions",
  "earnings-estimates",
  "historical-prices",
  "fundamental-graph",
  "ibkr-trading",
]);

export const DEFAULT_COLUMNS: ColumnConfig[] = [
  { id: "ticker", label: "TICKER", width: 8, align: "left" },
  { id: "price", label: "LAST", width: 10, align: "right", format: "currency" },
  { id: "change_pct", label: "CHG%", width: 8, align: "right", format: "percent" },
  { id: "market_cap", label: "MCAP", width: 10, align: "right", format: "compact" },
  { id: "pe", label: "P/E", width: 7, align: "right", format: "number" },
  { id: "forward_pe", label: "FWD P/E", width: 8, align: "right", format: "number" },
  { id: "latency", label: "AGE", width: 6, align: "right" },
];

export const DEFAULT_PORTFOLIO_COLUMN_IDS = [
  ...DEFAULT_COLUMNS.map((column) => column.id),
  "sparkline",
  "shares",
  "avg_cost",
  "cost_basis",
  "mkt_value",
  "day_pnl",
  "pnl",
  "pnl_pct",
];

const DEFAULT_HOME_LAYOUT: LayoutConfig = {
  dockRoot: {
    kind: "split",
    axis: "horizontal",
    ratio: 0.34,
    first: {
      kind: "split",
      axis: "vertical",
      ratio: 0.5,
      first: { kind: "pane", instanceId: "portfolio-list:main" },
      second: { kind: "pane", instanceId: "chat:main" },
    },
    second: {
      kind: "split",
      axis: "vertical",
      ratio: 0.46,
      first: { kind: "pane", instanceId: "ticker-detail:main" },
      second: { kind: "pane", instanceId: "ticker-detail:nvda" },
    },
  },
  instances: [
    {
      instanceId: "portfolio-list:main",
      paneId: "portfolio-list",
      params: { collectionId: "main" },
      settings: {
        columnIds: [...DEFAULT_PORTFOLIO_COLUMN_IDS],
        collectionScope: "all",
        visibleCollectionIds: [],
        viewMode: "table",
      },
      binding: { kind: "none" },
    },
    {
      instanceId: "ticker-detail:main",
      paneId: TICKER_RESEARCH_PANE_ID,
      settings: {
        hideTabs: false,
        lockedTabId: "overview",
        chartRangePreset: "5Y",
        chartResolution: "auto",
      },
      binding: { kind: "follow", sourceInstanceId: "portfolio-list:main" },
    },
    {
      instanceId: "ticker-detail:nvda",
      paneId: TICKER_RESEARCH_PANE_ID,
      title: "NVDA",
      settings: {
        hideTabs: false,
        lockedTabId: "overview",
        chartRangePreset: "5Y",
        chartResolution: "auto",
      },
      binding: { kind: "fixed", symbol: "NVDA" },
    },
    {
      instanceId: "chat:main",
      paneId: "chat",
      settings: {
        hideTabs: false,
      },
      binding: { kind: "none" },
    },
    {
      instanceId: "help:main",
      paneId: "help",
      binding: { kind: "none" },
    },
  ],
  floating: [
    { instanceId: "help:main", x: 12, y: 4, width: 88, height: 32, zIndex: 90 },
  ],
  detached: [],
};

const DEFAULT_MONITOR_LAYOUT: LayoutConfig = {
  dockRoot: {
    kind: "split",
    axis: "vertical",
    ratio: 0.48,
    first: {
      kind: "split",
      axis: "horizontal",
      ratio: 0.42,
      first: { kind: "pane", instanceId: "news-top:main" },
      second: { kind: "pane", instanceId: "prediction-markets:main" },
    },
    second: {
      kind: "split",
      axis: "horizontal",
      ratio: 0.42,
      first: { kind: "pane", instanceId: "world-indices:main" },
      second: { kind: "pane", instanceId: "econ-calendar:main" },
    },
  },
  instances: [
    {
      instanceId: "news-top:main",
      paneId: "news-top",
      binding: { kind: "none" },
    },
    {
      instanceId: "prediction-markets:main",
      paneId: "prediction-markets",
      binding: { kind: "none" },
    },
    {
      instanceId: "world-indices:main",
      paneId: "world-indices",
      binding: { kind: "none" },
    },
    {
      instanceId: "econ-calendar:main",
      paneId: "econ-calendar",
      binding: { kind: "none" },
    },
  ],
  floating: [],
  detached: [],
};

export const DEFAULT_LAYOUT = DEFAULT_HOME_LAYOUT;
const BLANK_LAYOUT: LayoutConfig = {
  dockRoot: null,
  instances: [],
  floating: [],
  detached: [],
};

let nextPaneInstanceSeq = 0;

function clampDockRatio(ratio: number | undefined): number {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return 0.5;
  return Math.max(0.1, Math.min(0.9, ratio));
}

function isDockAxis(value: unknown): value is DockSplitNode["axis"] {
  return value === "horizontal" || value === "vertical";
}

function cloneDockNode(node: DockLayoutNode): DockLayoutNode {
  if (node.kind === "pane") {
    return { kind: "pane", instanceId: node.instanceId };
  }
  return {
    kind: "split",
    axis: node.axis,
    ratio: node.ratio,
    first: cloneDockNode(node.first),
    second: cloneDockNode(node.second),
  };
}

function normalizeDockNode(
  node: DockLayoutNode | null | undefined,
  validInstanceIds: Set<string>,
  seenPaneIds: Set<string>,
): DockLayoutNode | null {
  if (!node || typeof node !== "object") return null;

  if ((node as DockPaneNode).kind === "pane") {
    const instanceId = (node as DockPaneNode).instanceId;
    if (typeof instanceId !== "string" || !validInstanceIds.has(instanceId) || seenPaneIds.has(instanceId)) {
      return null;
    }
    seenPaneIds.add(instanceId);
    return { kind: "pane", instanceId };
  }

  if ((node as DockSplitNode).kind !== "split") return null;
  const split = node as DockSplitNode;
  const first = normalizeDockNode(split.first, validInstanceIds, seenPaneIds);
  const second = normalizeDockNode(split.second, validInstanceIds, seenPaneIds);
  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;
  return {
    kind: "split",
    axis: isDockAxis(split.axis) ? split.axis : "horizontal",
    ratio: clampDockRatio(split.ratio),
    first,
    second,
  };
}

function getDockedPaneIdsFromNode(node: DockLayoutNode | null, result: string[] = []): string[] {
  if (!node) return result;
  if (node.kind === "pane") {
    result.push(node.instanceId);
    return result;
  }
  getDockedPaneIdsFromNode(node.first, result);
  getDockedPaneIdsFromNode(node.second, result);
  return result;
}

export function createPaneInstanceId(paneId: string): string {
  nextPaneInstanceSeq += 1;
  return `${paneId}:${Date.now().toString(36)}${nextPaneInstanceSeq.toString(36)}`;
}

function clonePaneBinding(binding: PaneBinding | undefined): PaneBinding | undefined {
  if (!binding) return undefined;
  return { ...binding };
}

export function clonePlacementMemory(memory: PanePlacementMemory | undefined): PanePlacementMemory | undefined {
  if (!memory) return undefined;
  return {
    docked: memory.docked ? {
      path: memory.docked.path ? [...memory.docked.path] : undefined,
      anchorInstanceId: memory.docked.anchorInstanceId,
      position: memory.docked.position,
    } : undefined,
    floating: memory.floating ? { ...memory.floating } : undefined,
    detached: memory.detached ? { ...memory.detached } : undefined,
  };
}

function cloneUnknownValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneUnknownValue(entry)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, cloneUnknownValue(entry)]),
    ) as T;
  }
  return value;
}

export function clonePaneSettings(settings: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!settings) return undefined;
  return cloneUnknownValue(settings);
}

export function isTickerPaneId(paneId: string): boolean {
  return TICKER_PANE_IDS.has(paneId);
}

function isTickerPaneInstance(instance: PaneInstanceConfig): boolean {
  return isTickerPaneId(instance.paneId);
}

export function isFixedTickerPane(instance: PaneInstanceConfig): boolean {
  return isTickerPaneInstance(instance) && instance.binding?.kind === "fixed";
}

export function findPrimaryPaneInstance(layout: LayoutConfig, paneId: string): PaneInstanceConfig | undefined {
  const normalizedPaneId = normalizePaneId(paneId);
  const instances = layout.instances.filter((instance) => instance.paneId === normalizedPaneId);
  if (instances.length === 0) return undefined;
  if (!isTickerPaneId(normalizedPaneId)) return instances[0];
  return instances.find((instance) => instance.instanceId === `${paneId}:main` && instance.binding?.kind !== "fixed")
    ?? instances.find((instance) => instance.instanceId === `${normalizedPaneId}:main` && instance.binding?.kind !== "fixed")
    ?? instances.find((instance) => instance.binding?.kind !== "fixed");
}

export function resolvePaneInstance(layout: LayoutConfig, paneIdOrInstanceId: string): PaneInstanceConfig | undefined {
  return findPaneInstance(layout, paneIdOrInstanceId) ?? findPrimaryPaneInstance(layout, paneIdOrInstanceId);
}

export function resolveFollowBindingInstance(
  layout: LayoutConfig,
  paneIdOrInstanceId: string | null | undefined,
  matcher: (instance: PaneInstanceConfig) => boolean,
  seen = new Set<string>(),
): PaneInstanceConfig | undefined {
  if (!paneIdOrInstanceId) return undefined;
  const instance = resolvePaneInstance(layout, paneIdOrInstanceId);
  if (!instance || seen.has(instance.instanceId)) return undefined;
  seen.add(instance.instanceId);
  if (matcher(instance)) return instance;
  if (instance.binding?.kind === "follow") {
    return resolveFollowBindingInstance(layout, instance.binding.sourceInstanceId, matcher, seen);
  }
  return undefined;
}

export function createPaneInstance(
  paneId: string,
  options: Partial<PaneInstanceConfig> = {},
): PaneInstanceConfig {
  const normalizedPaneId = normalizePaneId(paneId);
  return {
    instanceId: options.instanceId ?? createPaneInstanceId(normalizedPaneId),
    paneId: normalizedPaneId,
    title: options.title,
    binding: clonePaneBinding(options.binding) ?? { kind: "none" },
    params: options.params ? { ...options.params } : undefined,
    settings: clonePaneSettings(options.settings),
    placementMemory: clonePlacementMemory(options.placementMemory),
  };
}

export function removePaneInstances(layout: LayoutConfig, instanceIds: Iterable<string>): LayoutConfig {
  const removedIds = new Set(instanceIds);
  if (removedIds.size === 0) return layout;

  const instances = layout.instances.filter((instance) => !removedIds.has(instance.instanceId));
  const validInstanceIds = new Set(instances.map((instance) => instance.instanceId));
  const dockRoot = normalizeDockNode(layout.dockRoot, validInstanceIds, new Set<string>());
  const dockedPaneIds = new Set(getDockedPaneIdsFromNode(dockRoot));
  const detached = layout.detached ?? [];
  return {
    ...layout,
    instances,
    dockRoot,
    floating: layout.floating.filter((entry) => !removedIds.has(entry.instanceId) && !dockedPaneIds.has(entry.instanceId)),
    detached: detached.filter((entry) => !removedIds.has(entry.instanceId) && !dockedPaneIds.has(entry.instanceId)),
  };
}

export function normalizePaneLayout(
  layout: LayoutConfig,
  options?: { defaultFollowSourceInstanceId?: string | null },
): LayoutConfig {
  const fallbackSourceId = options?.defaultFollowSourceInstanceId ?? null;
  const fallbackAvailable = !!fallbackSourceId && layout.instances.some((instance) => instance.instanceId === fallbackSourceId);

  let nextLayout = layout;
  if (fallbackAvailable) {
    const nextInstances: PaneInstanceConfig[] = layout.instances.map((instance) => {
      if (!isTickerPaneInstance(instance)) return instance;
      if (instance.binding?.kind === "fixed" || instance.binding?.kind === "follow") return instance;
      return {
        ...instance,
        binding: { kind: "follow", sourceInstanceId: fallbackSourceId! },
      };
    });
    if (nextInstances.some((instance, index) => instance !== layout.instances[index])) {
      nextLayout = {
        ...layout,
        instances: nextInstances,
      };
    }
  }

  for (;;) {
    const validInstanceIds = new Set(nextLayout.instances.map((instance) => instance.instanceId));
    const removedIds = new Set<string>();

    for (const instance of nextLayout.instances) {
      if (instance.binding?.kind === "follow" && !validInstanceIds.has(instance.binding.sourceInstanceId)) {
        removedIds.add(instance.instanceId);
        continue;
      }

      if (isTickerPaneInstance(instance) && instance.binding?.kind !== "follow" && instance.binding?.kind !== "fixed") {
        removedIds.add(instance.instanceId);
        continue;
      }

      if (instance.binding?.kind === "fixed" && instance.binding.symbol.trim().length === 0) {
        removedIds.add(instance.instanceId);
      }
    }

    if (removedIds.size === 0) break;
    nextLayout = removePaneInstances(nextLayout, removedIds);
  }

  const validInstanceIds = new Set(nextLayout.instances.map((instance) => instance.instanceId));
  const dockRoot = normalizeDockNode(nextLayout.dockRoot, validInstanceIds, new Set<string>());
  const dockedPaneIds = new Set(getDockedPaneIdsFromNode(dockRoot));
  const detached = (nextLayout.detached ?? [])
    .filter((entry) => validInstanceIds.has(entry.instanceId) && !dockedPaneIds.has(entry.instanceId))
    .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.instanceId === entry.instanceId) === index)
    .map((entry) => ({
      instanceId: entry.instanceId,
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height,
    }));
  const detachedPaneIds = new Set(detached.map((entry) => entry.instanceId));

  return {
    dockRoot,
    instances: nextLayout.instances.map((instance) => ({
      ...instance,
      binding: clonePaneBinding(instance.binding),
      params: instance.params ? { ...instance.params } : undefined,
      settings: clonePaneSettings(instance.settings),
      placementMemory: clonePlacementMemory(instance.placementMemory),
    })),
    floating: nextLayout.floating
      .filter((entry) => (
        validInstanceIds.has(entry.instanceId)
        && !dockedPaneIds.has(entry.instanceId)
        && !detachedPaneIds.has(entry.instanceId)
      ))
      .map((entry) => ({ ...entry })),
    detached,
  };
}

export function cloneLayout(layout: LayoutConfig): LayoutConfig {
  const detached = layout.detached ?? [];
  return {
    dockRoot: layout.dockRoot ? cloneDockNode(layout.dockRoot) : null,
    instances: layout.instances.map((instance) => ({
      ...instance,
      binding: clonePaneBinding(instance.binding),
      params: instance.params ? { ...instance.params } : undefined,
      settings: clonePaneSettings(instance.settings),
      placementMemory: clonePlacementMemory(instance.placementMemory),
    })),
    floating: layout.floating.map((entry) => ({ ...entry })),
    detached: detached.map((entry) => ({ ...entry })),
  };
}

export function createBlankLayout(): LayoutConfig {
  return cloneLayout(BLANK_LAYOUT);
}

export function findPaneInstance(layout: LayoutConfig, instanceId: string): PaneInstanceConfig | undefined {
  return layout.instances.find((instance) => instance.instanceId === instanceId);
}

export function createDefaultConfig(dataDir: string): AppConfig {
  const layout = cloneLayout(DEFAULT_HOME_LAYOUT);
  return {
    dataDir,
    configVersion: CURRENT_CONFIG_VERSION,
    baseCurrency: "USD",
    refreshIntervalMinutes: 30,
    portfolios: [{ id: "main", name: "Main Portfolio", currency: "USD" }],
    watchlists: [{ id: "watchlist", name: "Watchlist" }],
    layout,
    layouts: [
      { name: "Home", layout: cloneLayout(layout), paneState: {} },
      { name: "Monitor", layout: cloneLayout(DEFAULT_MONITOR_LAYOUT), paneState: {} },
    ],
    activeLayoutIndex: 0,
    brokerInstances: [],
    disabledPlugins: [],
    disabledSources: [],
    pluginConfig: {},
    theme: "amber",
    chartPreferences: {
      defaultRenderMode: "area",
      renderer: "auto",
    },
    valueFlashingEnabled: true,
    recentTickers: [],
  };
}

export function materializeDetachedPanesAsFloating(layout: LayoutConfig): LayoutConfig {
  const detached = layout.detached ?? [];
  if (detached.length === 0) return cloneLayout(layout);

  return normalizePaneLayout({
    ...cloneLayout(layout),
    floating: [
      ...layout.floating.map((entry) => ({ ...entry })),
      ...detached.map((entry) => ({
        instanceId: entry.instanceId,
        x: entry.x,
        y: entry.y,
        width: entry.width,
        height: entry.height,
      })),
    ],
    detached: [],
  });
}
