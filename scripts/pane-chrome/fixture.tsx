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
 * floats a chart, a heat map or the Fear & Greed pane instead (`&heat=market`
 * makes the heat map the market board of 500 names, `&ticks=1` recolours it
 * four times a second, and `&dock=heat` docks one in the chart's place), and `&float=g`,
 * `&float=board`, `&float=beside`, `&float=overlay` or `&float=under` one of
 * the charts that sit inside a pane's own layout), `nested` (the first four
 * docked), `stacked` (the chart under a table docked beside a chart),
 * `narrow` (floating panes either side of the width a header keeps Ask Gloom
 * at), `chat` (the chat view over an invented channel, see chat-fixture.tsx),
 * `cmp` (one chart composer pane on invented 30-minute bars, see
 * createInventedChartSource: `&chart=readout` three listings on two venues,
 * volume and two studies, `pan` one listing with years of bars, `edge` one
 * whose bars start 150 sessions back, `percent` three listings rebased;
 * `&linked=1` adds a daily chart composer under it, `&linked=mixed` IV
 * history, a monthly macro series and Fear & Greed beside it, all dated up
 * to the invented bars' last close),
 * `layout` (one pane that sets text or scrolls content, docked or floating,
 * for the layout checks; see layout-fixture.tsx), `des` (DES's overview
 * over an invented company, see DesPane), `header` (the app's top bar in
 * each update state, see header-fixture.tsx; `&host=browser` draws it as the
 * web app does), `tab-sweep` (what the layout sweep's tab visits are checked
 * against, tab-sweep-fixture.tsx), or `kit` (the kit page: every design-system family in every
 * state, see kit-fixture.tsx; `&family=<id>` shows one, `&theme=paper` and
 * `&font=` as everywhere).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { ColumnGrid } from "../../src/components/ui/column-grid";
// A namespace import: the frame budget builds this file against the base
// branch's sources too, which may not have useHeatTreemapScene.
import * as heatSurface from "../../src/components/metric-treemap/heat-surface";
import type { MetricTreemapItem } from "../../src/components/metric-treemap/layout";
import { PaneSidebar } from "../../src/components/layout/pane/sidebar";
import { DetachedPaneShell } from "../../src/components/layout/detached-pane-shell";
import { usePaneTabs } from "../../src/components/layout/pane/pane-tabs";
import { usePaneFooter } from "../../src/components/layout/pane/footer/registration";
import { delayedFooterSegment } from "../../src/components/layout/pane/footer/model";
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
import { AxisFixturePane } from "./axis-fixture";
import { chatLatencyLayouts, ChatLatencySync } from "./chat-latency-fixture";
import { useAppGlobalShortcuts } from "../../src/app/global-shortcuts";
import { HeaderFixture, installHeaderClock, installHeaderMarketData, installHeaderPlatform, type HeaderFixtureHandle } from "./header-fixture";
import { browserUiHost } from "../../src/renderers/browser/ui-host";
import { LAYOUT_PANES, installLayoutFetches, layoutLayout } from "./layout-fixture";
import { KitPage } from "./kit-fixture";
import { TabSweepFixture } from "./tab-sweep-fixture";
import { installTableResizeData, TABLE_RESIZE_PANES, TableResizeData, tableResizeLayout } from "./table-resize-fixture";
// A namespace import: the frame budget builds this file against the base branch's
// sources too, which may not have every capture yet.
import * as domScreenshot from "../../src/utils/dom-screenshot";
import { ChartComposerPane } from "../../src/plugins/builtin/chart-composer/pane";
import { IvHistoryChart } from "../../src/plugins/builtin/iv-history/charts";
import type { IvHistoryModel } from "../../src/plugins/builtin/iv-history/model";
import { scalarLine, SeriesDetailChart } from "../../src/plugins/builtin/shared/series-detail-chart";
import { buildComparisonChartPreset, buildPriceChartPreset } from "../../src/plugins/builtin/chart-composer/presets";
import { appendChartSeries } from "../../src/plugins/builtin/chart-composer/chart-spec-edit";
import { setBuiltinStudies } from "../../src/plugins/builtin/chart-composer/studies";
import { PluginRenderProvider } from "../../src/plugins/runtime";
import { createTestPluginRuntime } from "../../src/test-support/plugin-runtime";
import type { ChartSpec } from "../../src/time-series/types";
import type { DataProvider } from "../../src/types/data-provider";
import type { PricePoint, Quote, TickerFinancials } from "../../src/types/financials";
import type { PriceHistoryResult } from "../../src/types/price-history";
import type { ChartResolutionSupport, ManualChartResolution } from "../../src/time-series/resolution";
import type { TimeRange } from "../../src/time-series/range";
import { subtractTimeRange } from "../../src/time-series/date-window";
import { zonedWallClockToUtcMs } from "../../src/utils/zoned-date-time";
import { isRegularSessionTime } from "../../src/market-data/market/freshness";

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
      /** Toasts, each the end of a Share: the link copied, or what stopped it. */
      shares: number;
      /** Panes handed to Ask Gloom (its button, menu entry or key), in order. */
      asks: string[];
      /** What each of those handed over: its text as drawn and its arguments. */
      attachments: Array<{ paneId: string; visibleText: string | null; args: Readonly<Record<string, string>> }>;
      /** Sizes of the PNG images Copy Screenshot put on the clipboard, in order. */
      clipboardImages: number[];
      /** Addresses handed to the system browser, in order. */
      externalOpens: string[];
      /** Times the popped-out window was asked to close. */
      detachedCloses: number;
      /** `paint`: floats another chart composer pane in, as adding a chart pane does; returns its id. */
      addChartPane?: () => string;
      /** `header`: sets the top bar's update state and window mode, and counts Help and Restart presses. */
      header: HeaderFixtureHandle;
    };
  }
}

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "docked";
const platform = params.get("platform") ?? "darwin";
const detached = scenario === "detached" || scenario === "theme-detached" || (scenario === "chat" && params.get("detached") === "1");

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
  id: `c${index}`, label, width: params.get("wide") === "1" ? 18 : index === 0 ? 10 : 9, align: index === 0 ? "left" as const : "right" as const,
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
      freezeFirstColumn={params.get("frozen") === "1"}
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
  // The real pane has eight plots, not just the index. Separate bitmap
  // resize timers can split their updates into extra commits.
  indicators: Array.from({ length: 7 }, (_, index) => ({
    definition: {
      id: `invented-${index}`, title: `Indicator ${index + 1}`, subtitle: "Invented history",
      primaryKey: "fear_and_greed" as const, primaryLabel: "Invented index", valueFormat: "score" as const,
    },
    score: 45 + index * 3, rating: "neutral" as const, updatedAt: new Date(Date.UTC(2026, 2, 6, 21)),
    points: inventedSeries(180, 45 + index * 3, 12 + index), secondaryPoints: [],
    latestValue: 45 + index * 3, latestSecondaryValue: null,
  })),
};

const PEN_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2.4 13.6 4 9.9 10.6 3.3a1.6 1.6 0 0 1 2.3 0a1.6 1.6 0 0 1 0 2.3L6.2 12Z" fill="none" stroke="#000" stroke-width="1.5"/></svg>`;

/**
 * A canvas chart (the composite chart's bitmap) over an SVG one (a sparkline),
 * on invented data, with a toolbar laid over the canvas by z-index, then the
 * CSS image layers charts draw: a dashed legend cue (a repeating gradient), a
 * colour scale (a gradient) and a toolbar icon (a colour box cut by an SVG mask),
 * and a ColumnGrid, whose rows are `display: contents` (DES Fundamentals, a quote book).
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
      <Box data-shot-region="column-grid" marginTop={1} style={{ width: 360 }}>
        <ColumnGrid
          columns={[{ width: 10, growFrom: 10 }, { width: 12, growFrom: 8, align: "right" }]}
          rows={[["Volume", "1.20M"], ["Market Cap", "5.00B USD"], ["P/E (TTM)", "21.5"]].map(([label, value]) => [
            { text: label!, color: "#9aa3b2" }, { text: value!, color: "#e5e7eb" },
          ])}
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

/**
 * A chart sized in rows under a query bar, over a caption, as the
 * correlation pane lays one out: the pane counts the bar as a row, which the
 * page draws taller, so the chart's rows run past its clipping box.
 */
function ChartRowsPane({ focused, width, height }: PaneProps) {
  // Whole rows for the chart; what is left of the pane's rows, less the bar and the caption, above it.
  const chartRows = Math.max(4, Math.floor(height * 0.6));
  const aboveRows = Math.max(1, height - 1 - chartRows - 1);
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <QueryBar width={width} meta="Invented closes" />
      <Box height={aboveRows} flexShrink={0} paddingX={1}>
        <Text>Invented figures above the chart</Text>
      </Box>
      <Box flexGrow={1} minHeight={0} overflow="hidden">
        <CompositeChart series={CHART_SERIES} panels={CHART_PANELS} width={Math.max(1, width)} height={chartRows} focused={focused} />
      </Box>
      <Box height={1} paddingX={1}>
        <Text>An invented close, rebased to the first day</Text>
      </Box>
    </Box>
  );
}

const BOARD_TABS = [{ value: "one", label: "Stocks" }, { value: "two", label: "Rates" }];
const BOARD_ROWS = TABLE_ROWS.slice(0, 12);
/** The band's cursor rests on the latest close, as the inventories board's rests on the latest week. */
const BOARD_CURSOR = CHART_SERIES[0]!.points.at(-1)!.date;

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
            chart={{ series: CHART_SERIES, minRows: 8, cursorDate: BOARD_CURSOR }}
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

const { HeatTreemapSurface } = heatSurface;
interface FixtureHeatLayout<T> { scene: ReturnType<typeof heatSurface.buildHeatTreemapScene<T>>; resizing: boolean }

declare global {
  interface Window {
    /** Scenes the heat maps committed, and a board refresh with new sizes (`heat=market`), as a snapshot reload brings. */
    __heat: { builds: number; refresh(): void };
  }
}
const heatRefreshes = new Set<() => void>();
window.__heat = { builds: 0, refresh: () => heatRefreshes.forEach((refresh) => refresh()) };

/**
 * The scene as the market heat map's pane lays it out, seeded with the one on
 * screen. A base branch from before `useHeatTreemapScene` lays it out at
 * every size it renders at, as its pane did.
 */
const useFixtureHeatScene = heatSurface.useHeatTreemapScene ?? function useEveryHeatScene<T>(
  items: readonly MetricTreemapItem<T>[],
  width: number,
  height: number,
): FixtureHeatLayout<T> {
  const capabilities = useUiCapabilities();
  const shown = useRef<FixtureHeatLayout<T>["scene"] | null>(null);
  const scene = useMemo(
    () => (shown.current = heatSurface.buildHeatTreemapScene(items, heatSurface.heatTreemapCanvas(width, height, capabilities), shown.current)),
    [capabilities, height, items, width],
  );
  return { scene, resizing: false };
};

/** Counts the scenes a heat map commits: each new one restyles every tile. */
function useCountedScene<T>(layout: FixtureHeatLayout<T>): FixtureHeatLayout<T> {
  useLayoutEffect(() => {
    window.__heat.builds += 1;
  }, [layout.scene]);
  return layout;
}

/** A heat map over invented tiles, laid out the way the market heat map lays out its board. */
function InventedHeatPane({ width, height }: PaneProps) {
  const { scene, resizing } = useCountedScene(useFixtureHeatScene(HEAT_ITEMS, width, height));
  return <HeatTreemapSurface scene={scene} resizing={resizing} items={HEAT_ITEMS} width={width} height={height} selectedId={null} onSelect={ignoreTile} />;
}

/** Eleven invented sectors of five invented industries each. */
const MARKET_SECTORS = Array.from({ length: 11 }, (_, sector) => `Sector ${String.fromCharCode(65 + sector)}`);
/** A deterministic stand-in for Math.random, so both checkouts draw the same board. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** 500 invented names in sectors and industries, sized like market caps: a few giants and a long tail. */
function marketHeatItems(generation: number, moves: readonly number[]): MetricTreemapItem<null>[] {
  const random = seeded(7 + generation);
  return moves.map((move, index) => {
    const sector = MARKET_SECTORS[index % MARKET_SECTORS.length]!;
    const weight = 4_000 / (index + 8) ** 1.1 * (0.85 + random() * 0.3);
    return {
      id: `name-${index}`,
      label: `N${index}`,
      weight,
      colorValue: move,
      primaryText: `${move >= 0 ? "+" : ""}${move.toFixed(1)}%`,
      group: sector,
      subgroup: `${sector} ${Math.floor(index / MARKET_SECTORS.length) % 5}`,
      data: null,
    };
  });
}

/**
 * `heat=market`: the market heat map's board as its pane lays it out: 500
 * names in sectors and industries, and with `ticks=1` a few moves changing
 * four times a second, as quotes stream in. Tiles are sized by the board a
 * refresh brings (`window.__heat.refresh()`), coloured by every tick.
 */
function MarketHeatPane({ width, height }: PaneProps) {
  const [moves, setMoves] = useState(() => Array.from({ length: 500 }, (_, index) => Math.sin(index * 1.3) * 3.2));
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const refresh = () => setGeneration((value) => value + 1);
    heatRefreshes.add(refresh);
    if (params.get("ticks") !== "1") return () => { heatRefreshes.delete(refresh); };
    const random = seeded(11);
    const timer = setInterval(() => {
      setMoves((current) => current.map((move) => (random() < 0.04 ? move + (random() - 0.5) * 1.2 : move)));
    }, 250);
    return () => {
      heatRefreshes.delete(refresh);
      clearInterval(timer);
    };
  }, []);
  const layoutItems = useMemo(() => marketHeatItems(generation, moves), [generation]); // eslint-disable-line react-hooks/exhaustive-deps
  const paintItems = useMemo(() => marketHeatItems(generation, moves), [generation, moves]);
  const { scene, resizing } = useCountedScene(useFixtureHeatScene(layoutItems, width, height));
  return <HeatTreemapSurface scene={scene} resizing={resizing} items={paintItems} width={width} height={height} selectedId={null} onSelect={ignoreTile} />;
}

const OVERVIEW_TICKER = createTestTicker("EXMPL", "Example Industries", { exchange: "", assetCategory: "STK" });
const OVERVIEW_FINANCIALS = createTestFinancials({
  quote: createTestQuote({ symbol: "EXMPL", price: 108, change: 2, changePercent: 1.89, lastUpdated: Date.UTC(2026, 0, 2) }),
  priceHistory: inventedSeries(120, 100, 18),
});
function OverviewPane({ width, height, focused }: PaneProps) {
  return <OverviewTab ticker={OVERVIEW_TICKER} financials={OVERVIEW_FINANCIALS} width={width} height={height} focused={focused} />;
}

/**
 * DES's overview over an invented company (`scenario=des`): the quote book,
 * fundamentals, positions in several accounts, profile and description.
 * `positions=<n>` sets how many accounts hold it (3 by default), `scale=<n>`
 * repeats the description, `long=1` gives it long account names, long
 * classification and site names, dated figures with their muted detail and a
 * book with large sizes, and `float=1` floats the pane over a plain one.
 * `footer=1` gives it the status and hint of a delayed quote,
 * `ratio=<0 to 1>` is how much of the width the docked pane starts with, and
 * `fw=<cells>` how wide the floating one is.
 */
const DES_LONG = params.get("long") === "1";
/** Account names from 4 to 44 characters, several near the length a column at rest holds, so a name ends close to its track whatever the width. */
const DES_LONG_ACCOUNTS = [4, 9, 16, 22, 27, 31, 35, 38, 44].map((length) => "Retirement savings account of the invented family partnership".slice(0, length).trimEnd());
const DES_ACCOUNTS = DES_LONG
  ? DES_LONG_ACCOUNTS
  : ["main", "Retirement", "Joint savings", "Trading", "Long term", "Education", "Family trust", "Margin", "Paper"];
/** A date `days` from today, as the day a registry would list it. */
const desDay = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const desPositions = Number(params.get("positions") ?? 3);
const DES_DESCRIPTION = Array.from({ length: Number(params.get("scale") ?? 1) }, () => "Example Industries builds small instruments for imaginary observatories. The team assembles each device in a bright studio beside the river, checks the lenses twice, and sends a hand written guide with every order. Longer runs use the same tools, but the instruments travel to classrooms, research stations and libraries across several regions.").join(" ");
const DES_NAME = DES_LONG ? "Example Industries of the Invented Archipelago and Associated Holdings Limited" : "Example Industries";
const DES_TICKER = createTestTicker("EXMPL", DES_NAME, {
  exchange: "NASDAQ",
  assetCategory: "STK",
  portfolios: DES_ACCOUNTS.slice(0, desPositions),
  positions: Array.from({ length: desPositions }, (_, index) => ({
    portfolio: DES_ACCOUNTS[index % DES_ACCOUNTS.length]!, shares: 10 + index * 7, avgCost: 70 + index * 2.5, currency: "USD", broker: "manual",
  })),
});
const DES_FINANCIALS = createTestFinancials({
  financialCurrency: "USD",
  quote: createTestQuote({
    symbol: "EXMPL", name: DES_NAME, price: 105.25, change: 1.25, changePercent: 1.2, previousClose: 104, lastUpdated: Date.UTC(2026, 0, 2),
    ...(DES_LONG ? { exchangeName: "NASDAQ" } : {}),
    bid: 105.2, ask: 105.3, bidSize: DES_LONG ? 12_345_678 : 300, askSize: DES_LONG ? 98_765_432 : 500, high: 106, low: 103, high52w: 140, low52w: 80, volume: 1_200_000, marketCap: 5e9, marketState: "CLOSED",
  }),
  priceHistory: inventedSeries(120, 100, 18),
  fundamentals: {
    marketCap: 5e9, enterpriseValue: 5.5e9, trailingPE: 21.5, forwardPE: 19.4, eps: 4.89, dividendYield: 0.017, beta: 1.12, revenue: 2e9,
    netIncome: 3e8, freeCashFlow: 2e8, profitMargin: 0.15, operatingMargin: 0.22, sharesOutstanding: 47_505_938, floatShares: 42e6,
    ...(DES_LONG ? {
      exDividendDate: desDay(6), shortPercentOfFloat: 0.034, shortRatio: 3.2, institutionPercentHeld: 0.71, insiderPercentHeld: 0.04,
      revenueGrowth: 0.12, pegRatio: 1.4,
    } : {}),
  },
  ...(DES_LONG ? { nextEarnings: { date: desDay(4), timing: "amc" as const, timingSource: "filing" as const } } : {}),
  profile: DES_LONG
    ? {
      description: DES_DESCRIPTION,
      sector: "Industrials and precision instruments",
      industry: "Precision measuring instruments and observatory equipment makers",
      employees: 12_345,
      website: "https://www.a-very-long-invented-company-website-name-for-testing.example.invalid",
      fiscalYearEnd: "12-31",
      sic: "3829",
      sicDescription: "Measuring and controlling devices not elsewhere classified",
    }
    : { description: DES_DESCRIPTION, sector: "Industrials", industry: "Instruments", employees: 12_345, website: "https://example.invalid", fiscalYearEnd: "12-31" },
});
const DES_FOOTER = params.get("footer") === "1";
function DesPane({ width, height, focused }: PaneProps) {
  // The status and the one hint the pane's real footer carries for a delayed quote.
  usePaneFooter("des-fixture", () => DES_FOOTER ? {
    info: [
      { id: "quote", parts: [{ text: "Stale quote 2026-01-02", tone: "muted" }] },
      delayedFooterSegment({ id: "access", detail: "15m delayed", delay: "15m", onPress: () => {} }),
    ],
    hints: [{ id: "upgrade", key: "$", label: "upgrade", onPress: () => {} }],
  } : null, []);
  return <OverviewTab ticker={DES_TICKER} financials={DES_FINANCIALS} width={width} height={height} focused={focused} />;
}

/** DES beside a plain pane, or floating over it (`float=1`). */
function desLayout(): LayoutConfig {
  if (params.get("float") === "1") {
    return {
      dockRoot: leaf("plain:a"),
      instances: [instance("des:a"), instance("plain:a")],
      floating: [{ instanceId: "des:a", x: 10, y: 2, width: Number(params.get("fw") ?? 112), height: 44, zIndex: 50 }],
      detached: [],
    };
  }
  return {
    dockRoot: { kind: "split", axis: "horizontal", ratio: Number(params.get("ratio") ?? 0.66), first: leaf("des:a"), second: leaf("plain:a") },
    instances: [instance("des:a"), instance("plain:a")],
    floating: [],
    detached: [],
  };
}

/**
 * Real title-bar tabs mount each chart just as opening a research tab does.
 * `composer` is the research Chart tab itself: the chart composer on the
 * invented source, loading its bars after a delay the first time.
 */
function PaintPane(props: PaneProps) {
  const [active, setActive] = useState("empty");
  // Like the research pane: a tab opened once stays mounted, hidden while
  // another one shows, so going back to it reveals the chart it drew.
  const [mounted, setMounted] = useState<readonly string[]>(["empty"]);
  const select = useCallback((tab: string) => {
    setActive(tab);
    setMounted((current) => (current.includes(tab) ? current : [...current, tab]));
  }, []);
  const { strip, rows } = usePaneTabs({
    tabs: ["empty", "chart", "overview", "composer"].map((value) => ({ value, label: value })),
    activeValue: active, onSelect: select,
  });
  const body = { ...props, height: Math.max(4, props.height - rows) };
  return <Box flexDirection="column" flexGrow={1}>
    {strip}
    {mounted.map((tab) => (
      <Box key={tab} visible={tab === active} flexDirection="column" flexGrow={1} flexBasis={0} overflow="hidden">
        {tab === "chart" ? <ChartPane {...body} />
          : tab === "overview" ? <OverviewPane {...body} />
          : tab === "composer" ? <ChartComposerFixturePane {...body} />
          : null}
      </Box>
    ))}
  </Box>;
}

/** Opens another chart composer pane, floating, as adding a chart pane does. */
function PaneAdder() {
  const dispatch = useAppDispatch();
  const layout = useAppSelector((state) => state.config.layout);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => {
    window.__paneChrome.addChartPane = () => {
      const current = layoutRef.current;
      const instanceId = `chart-composer:added${current.instances.length}`;
      dispatch({ type: "UPDATE_LAYOUT", layout: {
        ...current,
        instances: [...current.instances, { ...instance(instanceId), settings: { chartSpec: chartComposerSpec("pan") } }],
        floating: [...current.floating, { instanceId, x: 20, y: 6, width: 100, height: 30, zIndex: 70 }],
      } });
      return instanceId;
    };
  }, [dispatch]);
  return null;
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

const DAY_MS = 86_400_000;
const STEP_MS: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000 };
const ANSWER_CAP = 2_000;
const LATENCY_MS = 120;
const SUPPORT: ChartResolutionSupport[] = [
  { resolution: "15m", maxRange: "3M" },
  { resolution: "30m", maxRange: "6M" },
  { resolution: "1h", maxRange: "1Y" },
  { resolution: "1d", maxRange: "5Y" },
];

interface Listing {
  exchange: string;
  timeZone: string;
  open: [number, number];
  close: [number, number];
  currency: string;
  base: number;
  /** Sessions of intraday bars it keeps; daily bars go back as far as the rest. */
  intradaySessions?: number;
}

const LISTINGS: Record<string, Listing> = {
  ALFA: { exchange: "NASDAQ", timeZone: "America/New_York", open: [9, 30], close: [16, 0], currency: "USD", base: 120 },
  BRVO: { exchange: "NASDAQ", timeZone: "America/New_York", open: [9, 30], close: [16, 0], currency: "USD", base: 48 },
  CHRL: { exchange: "XETR", timeZone: "Europe/Berlin", open: [9, 0], close: [17, 30], currency: "EUR", base: 86 },
  EDGE: { exchange: "NASDAQ", timeZone: "America/New_York", open: [9, 30], close: [16, 0], currency: "USD", base: 30, intradaySessions: 150 },
};

/**
 * A wandering made-up price: waves from minutes to months long, their sizes
 * growing with their length, so it reads like a market without being one.
 */
const WAVES: Array<[periodDays: number, size: number]> = [
  [0.021, 0.0012], [0.067, 0.0021], [0.23, 0.004], [0.81, 0.007], [2.7, 0.012], [9.1, 0.022], [31, 0.04], [97, 0.07], [301, 0.12],
];

function priceAt(listing: Listing, time: number): number {
  const days = time / DAY_MS;
  let wave = 0;
  for (const [period, size] of WAVES) wave += size * Math.sin((days / period) * Math.PI * 2 + listing.base * period);
  return listing.base * Math.exp(wave);
}

function bar(listing: Listing, time: number, step: number): PricePoint {
  const open = priceAt(listing, time);
  const close = priceAt(listing, time + step);
  const swing = Math.abs(close - open) + listing.base * 0.002;
  return {
    date: new Date(time), open, close,
    high: Math.max(open, close) + swing * 0.4, low: Math.min(open, close) - swing * 0.4,
    volume: Math.round(listing.base * (900 + 700 * Math.abs(Math.sin(time / 2_700_000)) + 500 * Math.abs(Math.sin(time / 31_000_000)))),
  };
}

/** Session days (weekdays) from `start` to `end`, newest last. */
function sessionDays(start: number, end: number): Date[] {
  const days: Date[] = [];
  for (let day = Math.floor(start / DAY_MS) * DAY_MS; day <= end; day += DAY_MS) {
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(new Date(day));
  }
  return days;
}

/**
 * The invented source's own "now": the latest close, over every listing, of
 * the newest weekday that has ended for all of them, never later than the
 * clock. Its newest bar is then always the last US bar of a session day, after
 * the German listing's, whatever the hour or day the checks run at; against
 * the plain clock, both venues have a bar at the newest time while they are
 * open together and nothing is carried. Derived from the listings' own closes
 * and zones, so it holds across daylight saving changes.
 */
function settledNow(clock: number): number {
  for (let day = Math.floor(clock / DAY_MS) * DAY_MS; ; day -= DAY_MS) {
    const date = new Date(day);
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    const [year, month, dayOfMonth] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    const settled = Math.max(...Object.values(LISTINGS).map((listing) => (
      zonedWallClockToUtcMs(listing.timeZone, year, month, dayOfMonth, listing.close[0], listing.close[1], 0)
    )));
    if (settled <= clock) return settled;
  }
}

const sourceNow = () => settledNow(Date.now());

function intradayBars(listing: Listing, start: number, end: number, step: number, now: number): PricePoint[] {
  let days = sessionDays(start - DAY_MS, Math.min(end, now));
  if (listing.intradaySessions !== undefined) {
    const kept = sessionDays(now - listing.intradaySessions * 1.5 * DAY_MS, now).slice(-listing.intradaySessions);
    const first = kept[0]?.getTime() ?? Number.POSITIVE_INFINITY;
    days = days.filter((day) => day.getTime() >= first);
  }
  const bars: PricePoint[] = [];
  for (const day of days) {
    const [year, month, date] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    const open = zonedWallClockToUtcMs(listing.timeZone, year, month, date, listing.open[0], listing.open[1], 0);
    const close = zonedWallClockToUtcMs(listing.timeZone, year, month, date, listing.close[0], listing.close[1], 0);
    // Holidays have no session; the venue's own calendar says which.
    if (!isRegularSessionTime(listing.exchange, open + step)) continue;
    for (let time = open; time < close; time += step) {
      if (time >= start && time < end && time + step <= now) bars.push(bar(listing, time, step));
    }
  }
  return bars;
}

function dailyBars(listing: Listing, start: number, end: number, now: number): PricePoint[] {
  return sessionDays(start, Math.min(end, now - DAY_MS)).map((day) => bar(listing, day.getTime(), DAY_MS));
}

function history(symbol: string, start: number, end: number, resolution: ManualChartResolution): PriceHistoryResult {
  const listing = LISTINGS[symbol.toUpperCase()];
  if (!listing) return { points: [], resolution };
  const now = sourceNow();
  const step = STEP_MS[resolution];
  const points = step ? intradayBars(listing, start, end, step, now) : dailyBars(listing, start, end, now);
  // Like the real service: a window longer than one answer gets its newest bars.
  return { points: points.slice(-ANSWER_CAP), resolution };
}

function later<T>(value: () => T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value()), LATENCY_MS));
}

function quote(symbol: string): Quote {
  const listing = LISTINGS[symbol.toUpperCase()]!;
  const now = sourceNow();
  const price = priceAt(listing, now);
  return {
    symbol: symbol.toUpperCase(), price, currency: listing.currency, change: 0, changePercent: 0,
    lastUpdated: now, listingExchangeName: listing.exchange, instrumentType: "EQUITY",
  };
}

const RESOLUTIONS: Record<string, ManualChartResolution> = {
  "1m": "1m", "1min": "1m", "5m": "5m", "5min": "5m", "15m": "15m", "15min": "15m", "30m": "30m", "30min": "30m",
  "1h": "1h", "1d": "1d", "1day": "1d",
};

/**
 * An invented market-data source for the chart composer pane: made-up
 * listings and bars, never real market data, served after a short delay the
 * way a network source answers. Like the real service it caps one answer at
 * the newest `ANSWER_CAP` bars, so a long window comes back short and the
 * chart asks for the older part on its own. Its bars end at the last close of
 * every listing, not at the clock (see settledNow), so they read the same at
 * any hour.
 *
 * - ALFA, BRVO (NASDAQ): 30-minute bars for years.
 * - CHRL (XETR): another venue's hours, so a US afternoon carries its close.
 * - EDGE (NASDAQ): 30-minute bars for its last 150 sessions only.
 */
function createInventedChartSource(): DataProvider {
  return {
    id: "fixture",
    name: "Fixture",
    getChartResolutionSupport: () => SUPPORT,
    getTickerFinancials: async (symbol): Promise<TickerFinancials> => ({
      annualStatements: [], quarterlyStatements: [], priceHistory: [], quote: quote(symbol),
    }),
    getQuote: (symbol) => later(() => quote(symbol)),
    getExchangeRate: async () => 1,
    search: async () => [],
    getArticleSummary: async () => null,
    getPriceHistory: async () => [],
    getPriceHistoryForResolutionWithMetadata: (symbol, _exchange, range: TimeRange, resolution) => later(() => {
      const end = sourceNow();
      return history(symbol, subtractTimeRange(new Date(end), range).getTime(), end, resolution);
    }),
    getDetailedPriceHistoryWithMetadata: (symbol, _exchange, start, end, barSize) => later(() => (
      history(symbol, start.getTime(), end.getTime(), RESOLUTIONS[barSize] ?? "1d")
    )),
  };
}

const CHART_SOURCE = createInventedChartSource();
const CHART_RUNTIME = createTestPluginRuntime({ getMarketData: () => CHART_SOURCE });

/** The chart composer pane itself, reading the invented source. */
function ChartComposerFixturePane(props: PaneProps) {
  return (
    <PluginRenderProvider pluginId="charts" runtime={CHART_RUNTIME}>
      <ChartComposerPane {...props} />
    </PluginRenderProvider>
  );
}

/** A made-up series ending on the invented bars' last close, one point every `stepDays`, so it shares their dates. */
function recentSeries(count: number, base: number, swing: number, stepDays = 1) {
  const end = Math.floor(sourceNow() / DAY_MS) * DAY_MS;
  return Array.from({ length: count }, (_, index) => {
    const close = base + swing * Math.sin(index / 9) + (swing / 4) * Math.sin(index * 1.7);
    return { date: new Date(end - (count - 1 - index) * stepDays * DAY_MS), open: close, high: close + 1, low: close - 1, close, volume: 0 };
  });
}

function recentFearGreed(): FearGreedData {
  const updatedAt = new Date(sourceNow());
  return {
    ...INVENTED_FEAR_GREED,
    overall: { ...INVENTED_FEAR_GREED.overall, updatedAt, history: recentSeries(250, 50, 22) },
    indicators: INVENTED_FEAR_GREED.indicators.map((indicator, index) => ({
      ...indicator, updatedAt, points: recentSeries(180, 45 + index * 3, 12 + index),
    })),
  };
}

/** IV history's chart on invented daily vols: IV 30d, 90d and HV over their spread. */
function IvHistoryFixturePane({ width, height, focused }: PaneProps) {
  const model = useMemo(() => {
    const vols = (base: number, swing: number) => recentSeries(250, base, swing).map(({ date, close }) => ({ date, value: close / 100 }));
    const iv30 = vols(28, 6), hv = vols(24, 5);
    return {
      iv30, iv90: vols(30, 3), iv365: [], quoteIv30: [], hv,
      spread: iv30.map((entry, index) => ({ date: entry.date, value: entry.value! - hv[index]!.value! })),
    } as unknown as IvHistoryModel;
  }, []);
  return <IvHistoryChart model={model} width={width} height={height} hvLabel="HV 30d" focused={focused} />;
}

/** A macro series' detail chart on an invented monthly rate, five years to the invented bars' month. */
function MacroSeriesFixturePane({ width, height, focused }: PaneProps) {
  const { points, lines } = useMemo(() => {
    const end = new Date(sourceNow());
    const points = Array.from({ length: 60 }, (_, index) => {
      const month = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 59 + index, 1));
      return { date: month.toISOString().slice(0, 10), value: 3 + 1.5 * Math.sin(index / 7) };
    });
    const axis = { unit: "%", unitGroup: "percent", nativeFrequency: "monthly" as const };
    return { points, lines: [scalarLine(axis, "rate", "Invented rate", "#4c9aff", points)] };
  }, []);
  return (
    <SeriesDetailChart stats={[]} width={width} height={height} focused={focused} points={points} lines={lines}
      axis={{ unit: "%", unitGroup: "percent", nativeFrequency: "monthly" }} mean={3} resetKey="rate"
      formatValue={(value) => `${value.toFixed(2)}%`} />
  );
}

function chartComposerSpec(kind: string): ChartSpec {
  if (kind === "percent") return { ...buildComparisonChartPreset(["ALFA:NASDAQ", "BRVO:NASDAQ", "CHRL:XETR"]), viewport: { range: "3M", resolution: "30m" } };
  let spec = buildPriceChartPreset(kind === "edge" ? "EDGE:NASDAQ" : "ALFA:NASDAQ");
  if (kind === "readout") {
    spec = appendChartSeries(spec, { kind: "security", symbol: "BRVO", exchange: "NASDAQ", fieldId: "market.close" }).spec;
    spec = appendChartSeries(spec, { kind: "security", symbol: "CHRL", exchange: "XETR", fieldId: "market.close" }).spec;
    spec = setBuiltinStudies(spec, ["volume", "sma20", "rsi14"]);
  }
  return { ...spec, viewport: { ...spec.viewport, range: "3M", resolution: "30m" } };
}

const PANES = {
  axis: { name: "Composite chart", component: AxisFixturePane },
  palette: { name: "Surface", component: PalettePane },
  overview: { name: "Overview", component: OverviewPane },
  des: { name: "DES", component: DesPane },
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
  "chart-rows": { name: "Chart in rows", component: ChartRowsPane },
  board: { name: "Board", component: ChartBoardPane },
  beside: { name: "Chart beside a table", component: ChartBesideTablePane },
  overlay: { name: "Chart under a toolbar", component: ChartOverlayPane },
  under: { name: "Chart under a table", component: ChartUnderTablePane },
  sidebar: { name: "Sidebar", component: SidebarPane },
  heat: { name: "Heat map", component: params.get("heat") === "market" ? MarketHeatPane : InventedHeatPane },
  chat: { name: "Chat", component: ChatFixturePane },
  "chart-composer": { name: "Chart", component: ChartComposerFixturePane },
  "iv-history": { name: "IV history", component: IvHistoryFixturePane },
  macro: { name: "Macro series", component: MacroSeriesFixturePane },
  ...LAYOUT_PANES,
  ...TABLE_RESIZE_PANES,
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
    getTermSize: () => ({ width: window.innerWidth / WEB_CELL_WIDTH, height: window.innerHeight / WEB_CELL_HEIGHT }),
    getPluginPaneIds: () => [],
    getPanePluginId: () => undefined,
    getPluginPaneTemplateIds: () => [],
    getContextMenuItems: () => [],
    resolvePaneQuickSettings: () => [],
    hasPaneSettings: () => false,
    // Share ends in one toast, the link copied or why not (here it cannot reach
    // the service); nothing else on these pages toasts, so the page counts them all.
    notify: () => { window.__paneChrome.shares++; },
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
  // `dock=heat`: the heat map docked where the chart is, so a window resize resizes it.
  const docked = params.get("dock") === "heat" ? "heat:dock" : "chart:dock";
  return {
    dockRoot: {
      kind: "split", axis: "vertical", ratio: 0.55,
      first: row(["news:dock", docked]),
      second: row(["sidebar:dock", "table:dock"]),
    },
    instances: ["news:dock", docked, "sidebar:dock", "table:dock", floating].map(instance),
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

/**
 * One chart composer pane across the window; with `linked=1`, a daily one
 * under it that shares its crosshair, and with `linked=mixed`, IV history, a
 * macro series and Fear & Greed's charts around it that share it.
 */
function chartComposerLayout(): LayoutConfig {
  const instanceId = "chart-composer:a";
  const spec = chartComposerSpec(params.get("chart") ?? "pan");
  if (params.get("linked") === "mixed") {
    return {
      dockRoot: {
        kind: "split", axis: "vertical", ratio: 0.5,
        first: row([instanceId, "iv-history:a"]), second: row(["macro:a", "fear-greed:a"]),
      },
      instances: [{ ...instance(instanceId), settings: { chartSpec: spec } }, instance("iv-history:a"), instance("macro:a"), instance("fear-greed:a")],
      floating: [],
      detached: [],
    };
  }
  if (params.get("linked") === "1") {
    const daily = buildPriceChartPreset("BRVO:NASDAQ");
    return {
      dockRoot: { kind: "split", axis: "vertical", ratio: 0.5, first: leaf(instanceId), second: leaf("chart-composer:b") },
      instances: [
        { ...instance(instanceId), settings: { chartSpec: spec } },
        { ...instance("chart-composer:b"), settings: { chartSpec: { ...daily, viewport: { ...daily.viewport, range: "6M", resolution: "1d" } } } },
      ],
      floating: [],
      detached: [],
    };
  }
  return {
    dockRoot: leaf(instanceId),
    instances: [{ ...instance(instanceId), settings: { chartSpec: spec } }],
    floating: [],
    detached: [],
  };
}

function axisLayout(): LayoutConfig {
  const floating = params.get("float") === "1";
  return {
    dockRoot: floating ? leaf("plain:back") : leaf("axis:a"),
    instances: [instance("axis:a"), ...(floating ? [instance("plain:back")] : [])],
    floating: floating ? [{ instanceId: "axis:a", x: 2, y: params.get("short") === "1" ? 0 : 2, width: Math.max(30, window.innerWidth / WEB_CELL_WIDTH - 4), height: params.get("short") === "1" ? 6 : 34, zIndex: 60 }] : [],
    detached: [],
  };
}

function config() {
  const base = createDefaultConfig("/pane-chrome-fixture");
  const layout: LayoutConfig = scenario.startsWith("theme") ? themeLayout()
    : scenario === "paint" ? {
      dockRoot: leaf("paint:a"),
      instances: [{ ...instance("paint:a"), settings: { chartSpec: chartComposerSpec("pan") } }],
      floating: [], detached: [],
    }
    : scenario === "perf" ? perfLayout()
    : scenario === "screenshot" ? screenshotLayout()
    : scenario === "resize" ? resizeLayout()
    : scenario === "narrow" ? narrowLayout()
    : scenario === "chat" ? chatLayout()
    : scenario === "des" ? desLayout()
    : scenario === "nested" ? nestedLayout()
    : scenario === "stacked" ? stackedLayout()
    : scenario === "axis" ? axisLayout()
    : scenario === "cmp" ? chartComposerLayout()
    : scenario === "layout" ? layoutLayout(params)
    : scenario === "table-resize" ? tableResizeLayout(params)
    : chromeLayout();
  if (scenario === "theme-detached") layout.detached.push({ instanceId: "chart:theme", x: 0, y: 0, width: 80, height: 24 });
  const layouts = scenario === "chat" ? chatLatencyLayouts(layout) : [{ name: "Fixture", layout: cloneLayout(layout) }];
  if (scenario === "theme") layouts.push({ name: "Alternate", layout: cloneLayout(layout) });
  const fontSize = Number(params.get("font")) || base.fontSize;
  return { ...base, theme: params.get("theme") ?? base.theme, fontSize, layout, layouts, activeLayoutIndex: 0 };
}

const paneRegistry = registry();

function ChatNavigationShortcuts() {
  const state = useAppSelector((value) => value);
  const dispatch = useAppDispatch();
  useAppGlobalShortcuts({ state, dispatch, pluginRegistry: paneRegistry, isDetachedWindow: false,
    focusedTickerSymbol: null, refreshTicker() {}, restartToApplyUpdate() {}, startUpdate() {} });
  return null;
}
const detachedBridge: DesktopWindowBridge & { kind: "detached"; paneId: string } = {
  kind: "detached",
  paneId: scenario === "theme-detached" ? "chart:theme" : scenario === "chat" ? "chat:a" : "tabs:a",
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
  shares: 0,
  asks: [],
  attachments: [],
  clipboardImages: [],
  externalOpens: [],
  detachedCloses: 0,
  header: { show: ignore, fullscreen: ignore, commandBar: ignore, helpOpens: 0, restarts: 0 },
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
if (scenario === "cmp" && params.get("linked") === "mixed") await loadFearGreed(true, async () => recentFearGreed());
if (scenario === "layout") installLayoutFetches(params);
if (scenario === "table-resize") installTableResizeData();
if (scenario === "header") {
  installHeaderPlatform(platform);
  installHeaderClock();
  installHeaderMarketData();
}
const rendererHost: RendererHost = {
  ...webRendererHost,
  controlWindow: (action) => { window.__paneChrome.windowControls.push(action); },
  // The system clipboard is not there to read; the check counts what Copy Screenshot sends it.
  copyPngImage: async (pngBase64) => { window.__paneChrome.clipboardImages.push(pngBase64.length); },
  // There is no desktop process to open a browser; the check reads what it was asked to open.
  openExternal: async (url) => { window.__paneChrome.externalOpens.push(url); },
};

const root = document.getElementById("root")!;
root.tabIndex = -1;
createRoot(root).render(
  <DomHostProviders ui={params.get("host") === "browser" ? browserUiHost : createWebUiHost(platform)} renderer={rendererHost}>
    <AppProvider config={config()} desktopBridge={detached ? detachedBridge : undefined}>
      {detached
        ? <DetachedPaneShell pluginRegistry={paneRegistry} desktopWindowBridge={detachedBridge} />
        : scenario === "header" ? <HeaderFixture handle={window.__paneChrome.header} />
        : scenario === "kit" ? <KitPage family={params.get("family")} />
        : scenario === "tab-sweep" ? <TabSweepFixture />
        : scenario === "theme" || params.get("layoutReturn") === "1" ? <Box flexDirection="column" width="100%" height="100%">
          {scenario === "theme" && <Box data-theme-chrome="header"><Header /></Box>}
          <Shell pluginRegistry={paneRegistry} />
          <Box data-theme-chrome="status"><StatusBar /></Box>
        </Box> : <Shell pluginRegistry={paneRegistry} />}
      {(scenario.startsWith("theme") || scenario === "paint") && <ThemeControls />}
      {scenario === "paint" && <PaneAdder />}
      {scenario === "chat" && params.get("latencyCheck") === "1" && <ChatLatencySync />}
      {scenario === "chat" && params.get("layoutReturn") === "1" && <ChatNavigationShortcuts />}
      {scenario === "table-resize" && <TableResizeData />}
      <Ready />
    </AppProvider>
  </DomHostProviders>,
);
