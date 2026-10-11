/** @jsxImportSource react */
/**
 * The page the pane chrome checks drive: the real desktop shell (dock,
 * floating panes, pane headers, title-bar tabs, dividers) in the real DOM
 * host with the desktop app's own UI and renderer hosts, over a fixed layout
 * of stand-in panes. Nothing here fetches: the Electrobun backend is the CLI
 * screenshot stub, and the native window bridge is a recorder the page
 * script sets up before this runs (see page.ts). The window caption buttons
 * would go to the Bun process, so their actions are recorded here instead.
 *
 * The scenario comes from the query string: `?scenario=docked`, `floating`,
 * `detached` (a popped-out window; `&platform=win32` adds Windows caption
 * buttons), `perf` (a denser layout for the frame budget), `screenshot`
 * (chart panes for the copy screenshot check) or `resize` (a news table, a
 * chart, and a table in a sidebar beside a second table, docked, with a news
 * table floating over them; `&float=chart`, `&float=heat` or `&float=fear`
 * floats a chart, a heat map or the Fear & Greed pane instead).
 */
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { CompositeChart } from "../../src/components/chart/composite";
import { StaticChartSurface } from "../../src/components/chart/static/chart-surface";
import { DataTableView } from "../../src/components/data-table/view";
import { buildHeatTreemapScene, heatTreemapCanvas, HeatTreemapSurface } from "../../src/components/metric-treemap/heat-surface";
import type { MetricTreemapItem } from "../../src/components/metric-treemap/layout";
import { PaneSidebar } from "../../src/components/layout/pane/sidebar";
import { DetachedPaneShell } from "../../src/components/layout/detached-pane-shell";
import { usePaneTabs } from "../../src/components/layout/pane/pane-tabs";
import { Shell } from "../../src/components/layout/shell";
import type { NewsArticle } from "../../src/news/types";
import { NewsArticleStackView, type NewsSortPreference } from "../../src/plugins/builtin/news/wire/news/table";
import type { PluginRegistry } from "../../src/plugins/registry";
import { DomHostProviders } from "../../src/renderers/dom/dom-host-providers";
import { createWebUiHost, webRendererHost } from "../../src/renderers/electrobun/view/ui-host";
import { AppProvider } from "../../src/state/app/context";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../src/theme/font-scale";
import type { ResolvedSeries } from "../../src/time-series/types";
import { cloneLayout, createDefaultConfig, type DockLayoutNode, type LayoutConfig } from "../../src/types/config";
import type { DesktopWindowBridge } from "../../src/types/desktop-window";
import type { PaneProps } from "../../src/types/plugin";
import type { RendererHost } from "../../src/ui/host";
import { Box, Text, useUiCapabilities } from "../../src/ui";
import { FearGreedPane } from "../../src/plugins/builtin/fear-greed/pane";
import { loadFearGreed } from "../../src/plugins/builtin/fear-greed/cache";
import type { FearGreedData } from "../../src/plugins/builtin/fear-greed/data";
import { PriceSparkline } from "../../src/components/price-sparkline/view";
// A namespace import: the frame budget builds this file against the base branch's
// sources too, which may not have every capture yet.
import * as domScreenshot from "../../src/utils/dom-screenshot";

declare global {
  interface Window {
    __paneChrome: {
      ready: boolean;
      cell: { width: number; height: number };
      registry: PluginRegistry;
      /** Caption button actions (minimize, toggle-maximize, close), in order. */
      windowControls: string[];
      /** The pane's Copy Screenshot image, as a PNG data URL. */
      capturePane(paneId: string): Promise<string>;
      /** pane.screenshot's image painted at `scale`, under `maxBytes`, or why it could not be. */
      captureForAssistant(paneId: string, scale: number, maxBytes: number, minWidth: number): Promise<
        { width: number; height: number; bytes: number; reduced: boolean; screen: { width: number; height: number } } | { error: string }
      >;
      /** Panes whose `?` asked for their docs, in order. */
      docs: string[];
    };
  }
}

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "docked";
const platform = params.get("platform") ?? "darwin";

function PlainPane({ paneId }: PaneProps) {
  return <Text>{`Body of ${paneId}`}</Text>;
}

const TAB_LABELS: Record<string, string> = { one: "First", two: "Second", three: "Third" };

/** Three title-bar tabs that select and reorder, like a research pane's. */
function TabsPane(_props: PaneProps) {
  const [order, setOrder] = useState(["one", "two", "three"]);
  const [active, setActive] = useState("one");
  const { strip } = usePaneTabs({
    tabs: order.map((value) => ({ value, label: TAB_LABELS[value]! })),
    activeValue: active,
    onSelect: setActive,
    onReorder: (from, to) => setOrder((current) => {
      const next = current.filter((value) => value !== from);
      next.splice(current.indexOf(to), 0, from);
      return next;
    }),
  });
  return (
    <Box flexDirection="column">
      {strip}
      <Text>{`Showing ${TAB_LABELS[active]}`}</Text>
    </Box>
  );
}

/** Throws on every render, so the chrome shows the pane's failure card. */
function BrokenPane(_props: PaneProps): never {
  throw new Error("fixture pane failed to render");
}

const TABLE_COLUMNS = ["Symbol", "Last", "Chg", "Chg %", "Volume", "Mkt cap"].map((label, index) => ({
  id: `c${index}`, label, width: index === 0 ? 10 : 9, align: index === 0 ? "left" as const : "right" as const,
}));
const TABLE_ROWS = Array.from({ length: 120 }, (_, row) => row);

/**
 * The kit's table over 120 rows, as most panes draw: a scrolling, virtualized
 * body under a header. Enough DOM that a page-wide restyle, relayout or
 * relayering shows up in the frame budget.
 */
function TablePane({ paneId, focused }: PaneProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <DataTableView<number>
      focused={focused}
      selection={{ kind: "id", selectedId, getId: String, onChange: setSelectedId }}
      columns={TABLE_COLUMNS}
      items={TABLE_ROWS}
      sortColumnId={null}
      sortDirection="asc"
      getItemKey={String}
      emptyStateTitle="No rows"
      renderCell={(row, column) => {
        const value = ((row * 7919 + Number(column.id.slice(1)) * 104729 + paneId.length) % 99991) / 100;
        return { text: column.id === "c0" ? `T${row}` : value.toFixed(2) };
      }}
    />
  );
}

/** A made-up daily series: a slow wave with some wobble, never real market data. */
function inventedSeries(count: number, base: number, swing: number) {
  const start = Date.UTC(2026, 0, 2);
  return Array.from({ length: count }, (_, index) => {
    const close = base + swing * Math.sin(index / 9) + (swing / 4) * Math.sin(index * 1.7);
    return { date: new Date(start + index * 86_400_000), open: close, high: close + 1, low: close - 1, close, volume: 0 };
  });
}

const INVENTED_FEAR_GREED: FearGreedData = {
  overall: {
    score: 63, rating: "greed", updatedAt: new Date(Date.UTC(2026, 2, 6, 21)),
    previousClose: 58, previousWeek: 41, previousMonth: 35, previousYear: 52,
    history: inventedSeries(90, 50, 22),
  },
  indicators: [],
};

const PEN_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2.4 13.6 4 9.9 10.6 3.3a1.6 1.6 0 0 1 2.3 0a1.6 1.6 0 0 1 0 2.3L6.2 12Z" fill="none" stroke="#000" stroke-width="1.5"/></svg>`;

/**
 * A canvas chart (the composite chart's bitmap) over an SVG one (a sparkline),
 * on invented data, with a toolbar laid over the canvas by z-index, then the
 * CSS image layers charts draw: a dashed legend cue (a repeating gradient), a
 * colour scale (a gradient) and a toolbar icon (a colour box cut by an SVG mask).
 */
function ChartsPane({ width }: PaneProps) {
  const points = inventedSeries(120, 100, 18);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box data-shot-region="canvas-chart" height={14} marginTop={1} position="relative">
        {/* Before the canvas in the document and above it by z-index, as a chart's drawing toolbar sits. */}
        <Box
          data-shot-region="canvas-overlay"
          position="absolute"
          left={2}
          top={1}
          zIndex={5}
          style={{ backgroundColor: "#be123c", width: 120, height: 28, padding: 8 }}
        >
          <Box style={{ backgroundColor: "#fde68a", width: 64, height: 12 }} />
        </Box>
        <StaticChartSurface
          points={points}
          width={Math.max(24, width - 2)}
          height={14}
          colors={{ lineColor: "#4fb3ff", gridColor: "#2a2f3a", crosshairColor: "#9aa3b2", bgColor: "#101218", axisColor: "#9aa3b2" }}
        />
      </Box>
      <Box data-shot-region="svg-chart" height={6} marginTop={1}>
        <PriceSparkline priceHistory={points} width={Math.max(24, width - 2)} height={6} period="all" />
      </Box>
      <Box flexDirection="row" alignItems="center" marginTop={1} style={{ gap: 24 }}>
        <Box
          data-shot-region="dashed-cue"
          style={{ width: 160, height: 6, background: "repeating-linear-gradient(to right, #f5a524 0px 7px, transparent 7px 13px)" }}
        />
        <Box
          data-shot-region="colour-scale"
          style={{ width: 160, height: 24, background: "linear-gradient(to right, #1d4ed8, #22c55e 60%, #facc15)" }}
        />
        <Box
          data-shot-region="masked-icon"
          style={{
            width: 48,
            height: 48,
            backgroundColor: "#e5e7eb",
            maskImage: `url("data:image/svg+xml,${encodeURIComponent(PEN_ICON)}")`,
            maskSize: "contain",
            maskRepeat: "no-repeat",
            maskPosition: "center",
          }}
        />
      </Box>
    </Box>
  );
}

const NEWS_WORDS = ["Rates", "futures", "slip", "as", "traders", "weigh", "jobs", "data", "ahead", "of", "the", "open", "while", "chip", "makers", "rally", "on", "guidance"];
const NEWS_ARTICLES: NewsArticle[] = Array.from({ length: 160 }, (_, index) => ({
  id: `story-${index}`,
  title: Array.from({ length: 8 + (index % 7) }, (_, word) => NEWS_WORDS[(index * 5 + word * 3) % NEWS_WORDS.length]).join(" "),
  url: `https://example.invalid/${index}`,
  source: `Desk ${index % 4}`,
  publishedAt: new Date(Date.UTC(2026, 0, 2, 14, 0) - index * 7 * 60_000),
  topic: "markets",
  topics: ["markets"],
  sectors: [],
  categories: [index % 3 === 0 ? "earnings" : "macro"],
  // No tickers: their badges resolve symbols through services the fixture does not have.
  tickers: [],
  scores: { importance: 90 - (index % 50), urgency: 0, marketImpact: 50, novelty: 0, confidence: 0 },
  importance: 90 - (index % 50),
  isBreaking: false,
  isDeveloping: false,
}));
const NEWS_COLUMNS: Array<"rank" | "time" | "title" | "tickers" | "categories"> = ["rank", "time", "title", "tickers", "categories"];
const ignore = () => {};

/** The Top News table, as the news panes draw it, over invented stories. */
function NewsPane({ focused, width }: PaneProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sort, setSort] = useState<NewsSortPreference>({ columnId: "rank", direction: "desc" });
  return (
    <NewsArticleStackView
      articles={NEWS_ARTICLES}
      focused={focused}
      width={width}
      selectedArticleId={selectedId}
      setSelectedArticleId={setSelectedId}
      sortPreference={sort}
      setSortPreference={setSort}
      onOpenArticle={ignore}
      columns={NEWS_COLUMNS}
      emptyStateTitle="No stories"
      detailOpen={false}
      onBack={ignore}
      detailContent={null}
    />
  );
}

const CHART_SERIES: ResolvedSeries[] = [{
  id: "close",
  label: "Close",
  color: "#4fc3f7",
  unit: "USD",
  unitGroup: "currency",
  nativeFrequency: "daily",
  dataShape: "scalar",
  style: "line",
  transform: "raw",
  axis: "left",
  panelId: "main",
  interpolation: "none",
  points: Array.from({ length: 500 }, (_, day) => {
    const date = new Date(Date.UTC(2024, 0, 1) + day * 86_400_000);
    return { date, observedAt: date, value: 100 + Math.sin(day / 17) * 12 + Math.sin(day / 3.1) * 3 + day * 0.04 };
  }),
}];
const CHART_PANELS = [{ id: "main" }];

/** A line chart over invented daily closes, drawn the way the chart panes draw. */
function ChartPane({ focused, width, height }: PaneProps) {
  return <CompositeChart series={CHART_SERIES} panels={CHART_PANELS} width={width} height={height} focused={focused} />;
}

/**
 * A table in a resizable sidebar, like the venue map's list, beside a second
 * table that takes the rest of the pane. The second one's box sizes to its
 * content, as a plugin's often does: a table whose width followed its own
 * horizontal scrolling rendered there about 90 times a second, at rest.
 */
function SidebarPane({ paneId, focused, width, height }: PaneProps) {
  const [sidebarWidth, setSidebarWidth] = useState(Math.round(width * 0.45));
  const resize = useMemo(() => ({ min: 16, max: Math.max(17, Math.floor(width) - 16), onResize: setSidebarWidth }), [width]);
  return (
    <Box flexDirection="row" width={width} height={height}>
      <PaneSidebar width={sidebarWidth} height={height} focused={focused} resize={resize}>
        <TablePane paneId={paneId} paneType="table" focused={focused} width={sidebarWidth} height={height} />
      </PaneSidebar>
      <Box flexGrow={1} flexDirection="column">
        <TablePane paneId={`${paneId}:detail`} paneType="table" focused={focused} width={width - sidebarWidth} height={height} />
      </Box>
    </Box>
  );
}

const HEAT_GROUPS = ["Technology", "Financials", "Health Care", "Energy", "Industrials"];
/** Invented tiles in five groups, with made-up moves: never real market data. */
const HEAT_ITEMS: MetricTreemapItem<null>[] = Array.from({ length: 60 }, (_, index) => {
  const move = Math.sin(index * 1.3) * 3.2;
  return {
    id: `tile-${index}`,
    label: `T${index}`,
    weight: 40 + ((index * 37) % 23) * 12,
    colorValue: move,
    primaryText: `${move >= 0 ? "+" : ""}${move.toFixed(2)}%`,
    group: HEAT_GROUPS[index % HEAT_GROUPS.length],
    data: null,
  };
});
const ignoreTile = () => {};

/** A heat map over invented tiles, laid out the way the market heat map lays out its board. */
function HeatPane({ width, height }: PaneProps) {
  const capabilities = useUiCapabilities();
  const scene = useMemo(
    () => buildHeatTreemapScene(HEAT_ITEMS, heatTreemapCanvas(width, height, capabilities)),
    [capabilities, height, width],
  );
  return <HeatTreemapSurface scene={scene} items={HEAT_ITEMS} width={width} height={height} selectedId={null} onSelect={ignoreTile} />;
}

const PANES = {
  plain: { name: "Plain", component: PlainPane },
  tabs: { name: "Tabbed", component: TabsPane },
  broken: { name: "Broken", component: BrokenPane },
  table: { name: "Table", component: TablePane },
  "fear-greed": { name: "Fear & Greed", component: FearGreedPane },
  charts: { name: "Charts", component: ChartsPane },
  news: { name: "Top News", component: NewsPane },
  chart: { name: "Chart", component: ChartPane },
  sidebar: { name: "Sidebar", component: SidebarPane },
  heat: { name: "Heat map", component: HeatPane },
};

function registry(): PluginRegistry {
  return {
    panes: new Map(Object.entries(PANES).map(([id, pane]) => [id, { id, defaultPosition: "right", ...pane }])),
    paneTemplates: new Map(),
    commands: new Map(),
    tickerActions: new Map(),
    brokers: new Map(),
    allPlugins: new Map(),
    getEnabledTickerActions: () => [],
    getPluginPaneIds: () => [],
    getPluginPaneTemplateIds: () => [],
    getContextMenuItems: () => [],
    resolvePaneQuickSettings: () => [],
    hasPaneSettings: () => false,
    notify: () => {},
    openPaneSettings: () => {},
    openCommandBar: () => {},
    showPane: () => {},
    hidePane: () => {},
    openWindowMode: () => {},
    updateLayout: () => {},
    // A pane's `?` opens its docs through this; the page only records which pane asked.
    createPaneFromTemplate: (templateId: string, options?: { values?: Record<string, string> }) => {
      if (templateId === "docs-pane" && options?.values?.pane) window.__paneChrome.docs.push(options.values.pane);
    },
    // The shell binds its actions here as it mounts (togglePaneFullscreen among them).
    bindHost(actions: object) {
      Object.assign(this, actions);
      return () => {};
    },
  } as unknown as PluginRegistry;
}

const leaf = (instanceId: string): DockLayoutNode => ({ kind: "pane", instanceId });
/** Side by side, equal widths. */
const row = (ids: string[]): DockLayoutNode => ids.length === 1 ? leaf(ids[0]!) : {
  kind: "split", axis: "horizontal", ratio: 1 / ids.length, first: leaf(ids[0]!), second: row(ids.slice(1)),
};
const instance = (instanceId: string) => ({ instanceId, paneId: instanceId.split(":")[0]!, binding: { kind: "none" as const } });

/**
 * Docked: plain:a | tabs:a | plain:b over broken:a | plain:c. `floating` adds
 * plain:float over the lower right; `detached` pops tabs:a out instead.
 */
function chromeLayout(): LayoutConfig {
  const ids = ["plain:a", "tabs:a", "plain:b", "broken:a", "plain:c"];
  const layout: LayoutConfig = {
    dockRoot: { kind: "split", axis: "vertical", ratio: 0.5, first: row(ids.slice(0, 3)), second: row(ids.slice(3)) },
    instances: ids.map(instance),
    floating: [],
    detached: [],
  };
  if (scenario === "floating") {
    layout.instances.push(instance("plain:float"));
    layout.floating.push({ instanceId: "plain:float", x: 100, y: 30, width: 56, height: 12, zIndex: 60 });
  }
  if (scenario === "detached") {
    layout.detached.push({ instanceId: "tabs:a", x: 0, y: 0, width: 80, height: 24 });
  }
  return layout;
}

/** Three rows of three table panes, with a floating table over the middle. */
function perfLayout(): LayoutConfig {
  const ids = Array.from({ length: 9 }, (_, index) => `table:${index + 1}`);
  return {
    dockRoot: {
      kind: "split", axis: "vertical", ratio: 1 / 3, first: row(ids.slice(0, 3)),
      second: { kind: "split", axis: "vertical", ratio: 0.5, first: row(ids.slice(3, 6)), second: row(ids.slice(6)) },
    },
    instances: [...ids, "table:float"].map(instance),
    // Clear of the docked grips next to it, which its resize edges would take.
    floating: [{ instanceId: "table:float", x: 62, y: 14, width: 70, height: 20, zIndex: 60 }],
    detached: [],
  };
}

const FLOATING_RESIZE: Record<string, string> = { chart: "chart", heat: "heat", fear: "fear-greed" };

/**
 * news:dock | chart:dock over sidebar:dock | table:dock, with news:float (or
 * chart:float, heat:float, fear-greed:float) over the middle.
 */
function resizeLayout(): LayoutConfig {
  const floating = `${FLOATING_RESIZE[params.get("float") ?? ""] ?? "news"}:float`;
  return {
    dockRoot: {
      kind: "split", axis: "vertical", ratio: 0.55,
      first: row(["news:dock", "chart:dock"]),
      second: row(["sidebar:dock", "table:dock"]),
    },
    instances: ["news:dock", "chart:dock", "sidebar:dock", "table:dock", floating].map(instance),
    floating: [{ instanceId: floating, x: 50, y: 8, width: 72, height: 22, zIndex: 60 }],
    detached: [],
  };
}

/** The Fear & Greed pane beside the charts pane, both tall enough to show their charts. */
function screenshotLayout(): LayoutConfig {
  const ids = ["fear-greed:a", "charts:a"];
  return { dockRoot: row(ids), instances: ids.map(instance), floating: [], detached: [] };
}

function config() {
  const base = createDefaultConfig("/pane-chrome-fixture");
  const layout = scenario === "perf" ? perfLayout() : scenario === "screenshot" ? screenshotLayout() : scenario === "resize" ? resizeLayout() : chromeLayout();
  return { ...base, layout, layouts: [{ name: "Fixture", layout: cloneLayout(layout) }], activeLayoutIndex: 0 };
}

const paneRegistry = registry();
const detachedBridge: DesktopWindowBridge & { kind: "detached"; paneId: string } = {
  kind: "detached",
  paneId: "tabs:a",
  subscribeState: () => () => {},
  closeDetachedPane: async () => {},
};

function Ready() {
  // Two frames after the first commit: the shell has measured and laid out.
  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => { window.__paneChrome.ready = true; }));
  }, []);
  return null;
}

window.__paneChrome = {
  ready: false,
  cell: { width: WEB_CELL_WIDTH, height: WEB_CELL_HEIGHT },
  registry: paneRegistry,
  windowControls: [],
  docs: [],
  capturePane: async (paneId) => `data:image/png;base64,${(await domScreenshot.capturePaneScreenshotPngBase64(paneId)).pngBase64}`,
  captureForAssistant: async (paneId, scale, maxBytes, minWidth) => {
    try {
      const { pngBase64: _png, ...shot } = await domScreenshot.capturePaneImage({
        instanceId: paneId,
        scaleFor: () => scale,
        maxBytes,
        minWidth,
      });
      return shot;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
};
// The pane reads its data from the cache on mount, so it renders with the invented data at once.
if (scenario === "screenshot" || params.get("float") === "fear") await loadFearGreed(true, async () => INVENTED_FEAR_GREED);
const rendererHost: RendererHost = {
  ...webRendererHost,
  controlWindow: (action) => { window.__paneChrome.windowControls.push(action); },
};

const root = document.getElementById("root")!;
root.tabIndex = -1;
createRoot(root).render(
  <DomHostProviders ui={createWebUiHost(platform)} renderer={rendererHost}>
    <AppProvider config={config()} desktopBridge={scenario === "detached" ? detachedBridge : undefined}>
      {scenario === "detached"
        ? <DetachedPaneShell pluginRegistry={paneRegistry} desktopWindowBridge={detachedBridge} />
        : <Shell pluginRegistry={paneRegistry} />}
      <Ready />
    </AppProvider>
  </DomHostProviders>,
);
