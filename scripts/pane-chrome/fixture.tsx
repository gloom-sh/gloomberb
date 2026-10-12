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
 * floats a chart, a heat map or the Fear & Greed pane instead, and `&float=g`,
 * `&float=board`, `&float=beside`, `&float=overlay` or `&float=under` one of
 * the charts that sit inside a pane's own layout), `nested` (the first four
 * docked), `stacked` (the chart under a table docked beside a chart),
 * `narrow` (floating panes either side of the width a header keeps Ask Gloom
 * at) or `chat` (the chat view over an invented channel, see chat-fixture.tsx).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThemePicker, type ThemePickerHandle } from "../../src/components/command-bar/theme-picker";
import { useCommandBarThemePreview } from "../../src/components/command-bar/theme-preview";
import { OverviewTab } from "../../src/plugins/builtin/ticker-detail/overview-tab";
import { createTestTicker } from "../../src/test-support/ticker";
import { createTestFinancials, createTestQuote } from "../../src/test-support/data-provider";
import { useAppDispatch, useAppSelector } from "../../src/state/app/context";
import { getThemeIds } from "../../src/theme/themes";
import { matchThemeOptions } from "../../src/components/command-bar/theme-picker";
import { Surface3DChart } from "../../src/components/chart/surface3d/chart";
import { DEFAULT_SURFACE3D_CAMERA, type Surface3DInput } from "../../src/components/chart/surface3d/model";
import { getThemeColors } from "../../src/theme/colors";
import { createRoot } from "react-dom/client";
import { CompositeChart } from "../../src/components/chart/composite";
import { StaticChartSurface } from "../../src/components/chart/static/chart-surface";
import { DataTableView } from "../../src/components/data-table/view";
import { ChartTableHeader } from "../../src/components/chart-table/header";
import { QueryBar } from "../../src/components/ui/query-bar";
import { buildHeatTreemapScene, heatTreemapCanvas, HeatTreemapSurface } from "../../src/components/metric-treemap/heat-surface";
import type { MetricTreemapItem } from "../../src/components/metric-treemap/layout";
import { PaneSidebar } from "../../src/components/layout/pane/sidebar";
import { DetachedPaneShell } from "../../src/components/layout/detached-pane-shell";
import { usePaneTabs } from "../../src/components/layout/pane/pane-tabs";
import { Shell } from "../../src/components/layout/shell";
import { Header } from "../../src/components/layout/header";
import { StatusBar } from "../../src/components/layout/status-bar";
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
import { AsciiText, Box, Text, useUiCapabilities } from "../../src/ui";
import { FearGreedPane } from "../../src/plugins/builtin/fear-greed/pane";
import { loadFearGreed } from "../../src/plugins/builtin/fear-greed/cache";
import type { FearGreedData } from "../../src/plugins/builtin/fear-greed/data";
import { PriceSparkline } from "../../src/components/price-sparkline/view";
import { registerAskGloomPaneHandler } from "../../src/ask-gloom/pane-request";
import { PANE_HEADER_ASK_MIN_WIDTH } from "../../src/components/layout/pane/header";
import { ChatFixturePane, chatLayout } from "./chat-fixture";
// A namespace import: the frame budget builds this file against the base branch's
// sources too, which may not have every capture yet.
import * as domScreenshot from "../../src/utils/dom-screenshot";

declare global {
  interface Window {
    __paneChrome: {
      ready: boolean;
      themes: Record<string, ReturnType<typeof getThemeColors>>;
      themeOrder: string[];
      resetTheme(): void;
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
      /** Panes handed to Ask Gloom (its button, menu entry or key), in order. */
      asks: string[];
      /** What each of those handed over: its text as drawn and its arguments. */
      attachments: Array<{ paneId: string; visibleText: string | null; args: Readonly<Record<string, string>> }>;
      /** Sizes of the PNG images Copy Screenshot put on the clipboard, in order. */
      clipboardImages: number[];
      /** Times the popped-out window was asked to close. */
      detachedCloses: number;
    };
  }
}

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "docked";
const platform = params.get("platform") ?? "darwin";
const detached = scenario === "detached" || scenario === "theme-detached";

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

const RANGE_FILTER_OPTIONS = ["1M", "3M", "1Y", "5Y"].map((range, index) => ({ label: range, value: range, hint: String(index + 1) }));

/**
 * The G chart pane's layout over the same invented closes: a query bar, then
 * the chart in the rest of the pane, given the pane's cells less the bar's row.
 */
function ChartUnderBarPane({ focused, width, height }: PaneProps) {
  const [range, setRange] = useState("1Y");
  return (
    <Box flexDirection="column" width={width} height={height}>
      <QueryBar
        width={width}
        filters={[{ id: "range", label: "Range", inline: true, value: range, options: RANGE_FILTER_OPTIONS, onChange: setRange }]}
      />
      <Box flexGrow={1} minHeight={4}>
        <CompositeChart series={CHART_SERIES} panels={CHART_PANELS} width={Math.max(1, width)} height={Math.max(4, height - 1)} focused={focused} />
      </Box>
    </Box>
  );
}

const BOARD_TABS = [{ value: "one", label: "Stocks" }, { value: "two", label: "Rates" }];
const BOARD_ROWS = TABLE_ROWS.slice(0, 12);

/**
 * A board as the chart-table kit lays it out (inventories, money markets):
 * the pane's tabs, a query bar, the kit's chart band and a table under it.
 */
function ChartBoardPane({ paneId, focused, width, height }: PaneProps) {
  const [tab, setTab] = useState("one");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { strip, rows: tabRows } = usePaneTabs({ tabs: BOARD_TABS, activeValue: tab, onSelect: setTab, focused, dense: true });
  const bodyHeight = Math.max(3, height - tabRows);
  return (
    <Box width={width} height={height} flexDirection="column">
      {strip}
      <DataTableView<number>
        focused={focused}
        rootWidth={width}
        rootHeight={bodyHeight}
        rootBefore={(
          <ChartTableHeader
            width={width}
            height={bodyHeight}
            tableRows={BOARD_ROWS.length}
            tableColumns={TABLE_COLUMNS}
            query={<QueryBar width={width} meta="Invented closes" />}
            chart={{ series: CHART_SERIES, minRows: 8 }}
          />
        )}
        selection={{ kind: "id", selectedId, getId: String, onChange: setSelectedId }}
        columns={TABLE_COLUMNS}
        items={BOARD_ROWS}
        sortColumnId={null}
        sortDirection="asc"
        getItemKey={String}
        emptyStateTitle="No rows"
        renderCell={(row, column) => {
          const value = ((row * 7919 + Number(column.id.slice(1)) * 104729 + paneId.length) % 99991) / 100;
          return { text: column.id === "c0" ? `T${row}` : value.toFixed(2) };
        }}
      />
    </Box>
  );
}

const BESIDE_TABLE_WIDTH = 34;

/** A table of a fixed width with the chart taking the rest of the row, as a board with its history beside it. */
function ChartBesideTablePane({ paneId, focused, width, height }: PaneProps) {
  const tableWidth = Math.min(BESIDE_TABLE_WIDTH, Math.floor(width / 2));
  return (
    <Box flexDirection="row" width={width} height={height}>
      <Box width={tableWidth} height={height} flexShrink={0}>
        <TablePane paneId={paneId} paneType="table" focused={focused} width={tableWidth} height={height} />
      </Box>
      <CompositeChart series={CHART_SERIES} panels={CHART_PANELS} width={Math.max(1, width - tableWidth)} height={height} focused={focused} />
    </Box>
  );
}

/** A header row, then the chart with a toolbar laid over its top right by z-index, as a board's controls sit on its chart. */
function ChartOverlayPane({ focused, width, height }: PaneProps) {
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1} paddingX={1}>
        <Text>Invented closes</Text>
      </Box>
      <Box flexGrow={1} position="relative">
        <Box
          position="absolute"
          top={1}
          right={2}
          zIndex={5}
          data-shot-region="chart-overlay-toolbar"
          style={{ backgroundColor: "#1d4ed8", width: 96, height: 18, borderRadius: 4 }}
        />
        <CompositeChart series={CHART_SERIES} panels={CHART_PANELS} width={Math.max(1, width)} height={Math.max(4, height - 1)} focused={focused} />
      </Box>
    </Box>
  );
}

const UNDER_POINTS = inventedSeries(200, 20, 6);

/**
 * A table on top that takes most of the pane and grows into what is left,
 * a caption row, then a static chart of the selected row in the rest, given
 * the fraction of a row the pane's cells leave, as the volatility board lays
 * out its index history under its board.
 */
function ChartUnderTablePane({ paneId, focused, width, height }: PaneProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const tableHeight = Math.max(5, Math.min(BOARD_ROWS.length + 2, Math.floor(height * 0.62)));
  return (
    <Box width={width} height={height} flexDirection="column" overflow="hidden">
      <DataTableView<number>
        focused={focused}
        rootWidth={width}
        rootHeight={tableHeight}
        selection={{ kind: "id", selectedId, getId: String, onChange: setSelectedId }}
        columns={TABLE_COLUMNS}
        items={BOARD_ROWS}
        sortColumnId={null}
        sortDirection="asc"
        getItemKey={String}
        emptyStateTitle="No rows"
        renderCell={(row, column) => {
          const value = ((row * 7919 + Number(column.id.slice(1)) * 104729 + paneId.length) % 99991) / 100;
          return { text: column.id === "c0" ? `T${row}` : value.toFixed(2) };
        }}
      />
      <Box height={1} paddingX={1}><Text>Invented index</Text></Box>
      <StaticChartSurface
        points={UNDER_POINTS}
        calendarSpaced
        showTimeAxis
        width={width}
        height={Math.max(3, height - tableHeight - 1)}
        colors={{ lineColor: "#d4d4d8", gridColor: "#2a2f3a", crosshairColor: "#9aa3b2", bgColor: "#101218", axisColor: "#9aa3b2" }}
        focused={focused}
      />
    </Box>
  );
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

const OVERVIEW_TICKER = createTestTicker("EXMPL", "Example Industries", { exchange: "", assetCategory: "STK" });
const OVERVIEW_FINANCIALS = createTestFinancials({
  quote: createTestQuote({ symbol: "EXMPL", price: 108, change: 2, changePercent: 1.89, lastUpdated: Date.UTC(2026, 0, 2) }),
  priceHistory: inventedSeries(120, 100, 18),
});
function OverviewPane({ width, height, focused }: PaneProps) {
  return <OverviewTab ticker={OVERVIEW_TICKER} financials={OVERVIEW_FINANCIALS} width={width} height={height} focused={focused} />;
}

/** Real title-bar tabs mount each chart just as opening a research tab does. */
function PaintPane(props: PaneProps) {
  const [active, setActive] = useState("empty");
  const { strip } = usePaneTabs({
    tabs: ["empty", "chart", "overview"].map((value) => ({ value, label: value })),
    activeValue: active, onSelect: setActive,
  });
  return <Box flexDirection="column" flexGrow={1}>
    {strip}
    {active === "chart" ? <ChartPane {...props} /> : active === "overview" ? <OverviewPane {...props} /> : null}
  </Box>;
}

/** The product picker and its preview/commit/cancel path, without network search. */
function ThemeControls() {
  const dispatch = useAppDispatch();
  const committed = useAppSelector((state) => state.config.theme);
  const preview = useAppSelector((state) => state.themePreview);
  const themePickerRef = useRef<ThemePickerHandle | null>(null);
  const getCommittedThemeId = useCallback(() => committed, [committed]);
  const { applyThemePreview, clearThemePreview, commitTheme } = useCommandBarThemePreview({ dispatch, getCommittedThemeId, themePickerRef });
  useEffect(() => { window.__paneChrome.resetTheme = () => commitTheme("high-contrast"); }, [commitTheme]);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  return <div data-theme-controls data-preview={preview ?? ""} data-committed={committed} style={{ position: "absolute", top: 48, right: 24, zIndex: 200 }}>
    <button onClick={() => setOpen(!open)}>Themes</button>
    {open && <div style={{ background: "var(--gloom-command-bg)", padding: 12, width: 480 }}>
      <input aria-label="Theme filter" value={filter} onChange={(event) => setFilter(event.target.value)} onKeyDown={(event) => {
        if (event.key === "ArrowDown") themePickerRef.current?.move(1);
        else if (event.key === "ArrowUp") themePickerRef.current?.move(-1);
        else if (event.key === "Home") themePickerRef.current?.jump("first");
        else if (event.key === "End") themePickerRef.current?.jump("last");
        else if (event.key === "Escape") clearThemePreview(committed);
        else if (event.key === "Enter") themePickerRef.current?.commit();
        else return;
        event.preventDefault();
      }} />
      <button onClick={() => clearThemePreview(committed)}>Cancel preview</button>
      <button onClick={() => themePickerRef.current?.commit()}>Commit preview</button>
      <ThemePicker ref={themePickerRef} filter={filter} committedThemeId={committed} height={6} contentPadding={1} labelWidth={50} trailingWidth={6} queryDisplayWidth={50} nativePaneChrome onPreview={applyThemePreview} onCommit={commitTheme} />
    </div>}
  </div>;
}

const SURFACE_INPUT: Surface3DInput = {
  values: [[1, 2, 1], [2, 4, 2], [1, 3, 1]], columnPositions: [0, .5, 1], rowPositions: [0, .5, 1],
  zMin: 0, zMax: 5, xTicks: [], yTicks: [], zTicks: [], titles: { x: "", y: "", z: "" },
};
const SPARKLINE_POINTS = inventedSeries(30, 100, 12);
function PalettePane({ width, height }: PaneProps) {
  return <Box flexDirection="column">
    <AsciiText text="GLOOM" color="var(--gloom-text)" />
    <PriceSparkline priceHistory={SPARKLINE_POINTS} width={width} height={2} period="all" />
    <Surface3DChart input={SURFACE_INPUT} camera={DEFAULT_SURFACE3D_CAMERA} onCameraChange={ignore} onSelect={ignore} width={width} height={Math.max(3, height - 6)} />
  </Box>;
}

const PANES = {
  palette: { name: "Surface", component: PalettePane },
  overview: { name: "Overview", component: OverviewPane },
  paint: { name: "Research", component: PaintPane },
  plain: { name: "Plain", component: PlainPane },
  tabs: { name: "Tabbed", component: TabsPane },
  broken: { name: "Broken", component: BrokenPane },
  table: { name: "Table", component: TablePane },
  "fear-greed": { name: "Fear & Greed", component: FearGreedPane },
  charts: { name: "Charts", component: ChartsPane },
  news: { name: "Top News", component: NewsPane },
  chart: { name: "Chart", component: ChartPane },
  "chart-bar": { name: "G chart", component: ChartUnderBarPane },
  board: { name: "Board", component: ChartBoardPane },
  beside: { name: "Chart beside a table", component: ChartBesideTablePane },
  overlay: { name: "Chart under a toolbar", component: ChartOverlayPane },
  under: { name: "Chart under a table", component: ChartUnderTablePane },
  sidebar: { name: "Sidebar", component: SidebarPane },
  heat: { name: "Heat map", component: HeatPane },
  chat: { name: "Chat", component: ChatFixturePane },
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

const FLOATING_RESIZE: Record<string, string> = {
  chart: "chart", heat: "heat", fear: "fear-greed", g: "chart-bar", board: "board", beside: "beside", overlay: "overlay", under: "under",
};

/**
 * news:dock | chart:dock over sidebar:dock | table:dock, with news:float (or
 * chart:float, heat:float, fear-greed:float, chart-bar:float, board:float,
 * beside:float, overlay:float, under:float) over the middle.
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

/**
 * Two docked panes under floating ones a cell either side of the narrowest
 * header that keeps Ask Gloom, and one far wider.
 */
function narrowLayout(): LayoutConfig {
  const ids = ["plain:a", "plain:b"];
  const floating = [
    { instanceId: "plain:under", x: 4, y: 4, width: PANE_HEADER_ASK_MIN_WIDTH - 1 },
    { instanceId: "plain:at", x: 50, y: 4, width: PANE_HEADER_ASK_MIN_WIDTH },
    { instanceId: "tabs:wide", x: 100, y: 4, width: 60 },
  ];
  return {
    dockRoot: row(ids),
    instances: [...ids, ...floating.map((entry) => entry.instanceId)].map(instance),
    floating: floating.map((entry, index) => ({ ...entry, height: 10, zIndex: 60 + index })),
    detached: [],
  };
}

/** The charts that sit inside a pane's own layout, docked: chart-bar:dock | beside:dock over board:dock | overlay:dock. */
function nestedLayout(): LayoutConfig {
  return {
    dockRoot: {
      kind: "split", axis: "vertical", ratio: 0.5,
      first: row(["chart-bar:dock", "beside:dock"]),
      second: row(["board:dock", "overlay:dock"]),
    },
    instances: ["chart-bar:dock", "beside:dock", "board:dock", "overlay:dock"].map(instance),
    floating: [],
    detached: [],
  };
}

/** The chart under a table beside a chart, docked: each a fraction of a cell off whole cells. */
function stackedLayout(): LayoutConfig {
  const ids = ["under:dock", "chart:dock"];
  return { dockRoot: { kind: "split", axis: "horizontal", ratio: 0.62, first: leaf(ids[0]!), second: leaf(ids[1]!) }, instances: ids.map(instance), floating: [], detached: [] };
}

/** The Fear & Greed pane beside the charts pane, both tall enough to show their charts. */
function screenshotLayout(): LayoutConfig {
  const ids = ["fear-greed:a", "charts:a"];
  return { dockRoot: row(ids), instances: ids.map(instance), floating: [], detached: [] };
}

function themeLayout(): LayoutConfig {
  const ids = ["chart:theme", "overview:theme", "heat:theme", "table:theme", "palette:theme"];
  return {
    dockRoot: { kind: "split", axis: "vertical", ratio: 0.55, first: row(ids.slice(0, 2)), second: row(ids.slice(2)) },
    instances: [...ids, "chart:float"].map(instance),
    floating: [{ instanceId: "chart:float", x: 116, y: 29, width: 52, height: 15, zIndex: 60 }], detached: [],
  };
}

function config() {
  const base = createDefaultConfig("/pane-chrome-fixture");
  const layout: LayoutConfig = scenario.startsWith("theme") ? themeLayout()
    : scenario === "paint" ? { dockRoot: leaf("paint:a"), instances: [instance("paint:a")], floating: [], detached: [] }
    : scenario === "perf" ? perfLayout()
    : scenario === "screenshot" ? screenshotLayout()
    : scenario === "resize" ? resizeLayout()
    : scenario === "narrow" ? narrowLayout()
    : scenario === "chat" ? chatLayout()
    : scenario === "nested" ? nestedLayout()
    : scenario === "stacked" ? stackedLayout()
    : chromeLayout();
  if (scenario === "theme-detached") layout.detached.push({ instanceId: "chart:theme", x: 0, y: 0, width: 80, height: 24 });
  const layouts = [{ name: "Fixture", layout: cloneLayout(layout) }];
  if (scenario === "theme") layouts.push({ name: "Alternate", layout: cloneLayout(layout) });
  return { ...base, theme: params.get("theme") ?? base.theme, layout, layouts, activeLayoutIndex: 0 };
}

const paneRegistry = registry();
const detachedBridge: DesktopWindowBridge & { kind: "detached"; paneId: string } = {
  kind: "detached",
  paneId: scenario === "theme-detached" ? "chart:theme" : "tabs:a",
  subscribeState: () => () => {},
  closeDetachedPane: async () => { window.__paneChrome.detachedCloses += 1; },
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
  themes: Object.fromEntries(getThemeIds().map((id) => [id, getThemeColors(id)])),
  themeOrder: matchThemeOptions("").map(({ id }) => id),
  resetTheme: ignore,
  cell: { width: WEB_CELL_WIDTH, height: WEB_CELL_HEIGHT },
  registry: paneRegistry,
  windowControls: [],
  docs: [],
  asks: [],
  attachments: [],
  clipboardImages: [],
  detachedCloses: 0,
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
// Ask Gloom takes pane questions, so the headers offer its button; the page records which pane asked.
registerAskGloomPaneHandler(({ paneId, visibleText, args }) => {
  window.__paneChrome.asks.push(paneId);
  window.__paneChrome.attachments.push({ paneId, visibleText, args });
});
// The pane reads its data from the cache on mount, so it renders with the invented data at once.
if (scenario === "screenshot" || params.get("float") === "fear") await loadFearGreed(true, async () => INVENTED_FEAR_GREED);
const rendererHost: RendererHost = {
  ...webRendererHost,
  controlWindow: (action) => { window.__paneChrome.windowControls.push(action); },
  // The system clipboard is not there to read; the check counts what Copy Screenshot sends it.
  copyPngImage: async (pngBase64) => { window.__paneChrome.clipboardImages.push(pngBase64.length); },
};

const root = document.getElementById("root")!;
root.tabIndex = -1;
createRoot(root).render(
  <DomHostProviders ui={createWebUiHost(platform)} renderer={rendererHost}>
    <AppProvider config={config()} desktopBridge={detached ? detachedBridge : undefined}>
      {detached
        ? <DetachedPaneShell pluginRegistry={paneRegistry} desktopWindowBridge={detachedBridge} />
        : scenario === "theme" ? <Box flexDirection="column" width="100%" height="100%">
          <Box data-theme-chrome="header"><Header /></Box>
          <Shell pluginRegistry={paneRegistry} />
          <Box data-theme-chrome="status"><StatusBar /></Box>
        </Box> : <Shell pluginRegistry={paneRegistry} />}
      {(scenario.startsWith("theme") || scenario === "paint") && <ThemeControls />}
      <Ready />
    </AppProvider>
  </DomHostProviders>,
);
