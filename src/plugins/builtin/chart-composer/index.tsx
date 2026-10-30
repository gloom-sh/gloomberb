import { chartHeadless } from "./headless";
import type {
  PaneTemplateContext,
  PaneTemplateCreateOptions,
  PaneTemplateDef,
} from "../../../types/plugin";
import { CHART_COMPOSER_PANE_ID, type PaneInstanceConfig } from "../../../types/config";
import type { TickerRecord } from "../../../types/ticker";
import { parseTickerListInput } from "../../../tickers/list";
import { canonicalExchange, parsePublicTickerKey, publicTickerKey } from "../../../utils/exchanges";
import { tickerInstrumentLabel } from "../../../tickers/instrument-label";
import type { ChartSpec } from "../../../time-series/types";
import { ChartComposerPane, ChartComposerResearchTab } from "./pane";
import { DataCatalogPane } from "./data-catalog-pane";
import { listFieldSeries } from "./field-series";
import { registeredSeriesName } from "./series-expression";
import {
  CHART_COMPOSER_TEMPLATE_ID,
  DATA_CATALOG_PANE_ID,
  DATA_CATALOG_TEMPLATE_ID,
} from "./catalog-inventory";
import {
  CHART_INTERACTION_VIEWPORT_SETTING_KEY,
  CHART_LEVERAGE_PENDING_SETTING_KEY,
  CHART_PINNED_MOMENT_SETTING_KEY,
  CHART_SPEC_SETTING_KEY,
  parseChartInteractionViewport,
  parseChartSpec,
  type ChartInteractionViewport,
} from "./chart-spec";
import {
  CHART_DRAWINGS_SETTING_KEY,
  parseChartDrawings,
  type ChartDrawing,
} from "../../../components/chart/composite/tools";
import {
  buildComparisonChartPreset,
  buildCustomChartPreset,
  buildFundamentalChartPreset,
  buildIntradayPriceChartPreset,
  buildPriceChartPreset,
  buildValuationChartPreset,
} from "./presets";
import { buildChartComposerPaneSettingsDef } from "./settings";
import type { PluginModule } from "../plugin-module";
import {
  LIVE_STREAMING_QUICK_SETTING,
  withLiveStreamingSetting,
} from "../../../state/hooks/live-streaming";
import { isRecord } from "../../../utils/guards";

function normalizedSymbol(value: string | null | undefined): string | null {
  const symbol = value?.trim().toUpperCase() ?? "";
  return symbol ? symbol : null;
}

function templateSymbols(
  context: PaneTemplateContext,
  options?: PaneTemplateCreateOptions,
): string[] {
  if (options?.symbols?.length) {
    return options.symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  }
  const raw = options?.symbol
    ?? options?.ticker?.metadata.ticker
    ?? options?.arg
    ?? options?.values?.tickers
    ?? context.activeTicker;
  if (!raw) return [];
  try {
    return parseTickerListInput(raw);
  } catch {
    const primary = normalizedSymbol(raw);
    return primary ? [primary] : [];
  }
}

function primarySecuritySymbol(spec: ChartSpec): string | null {
  const source = spec.series.find((series) => series.source.kind === "security")?.source;
  return source?.kind === "security"
    ? publicTickerKey(source.instrument.symbol, source.instrument.exchange)
    : null;
}

function bindSelectedContract(spec: ChartSpec, context: PaneTemplateContext, options?: PaneTemplateCreateOptions): ChartSpec {
  const contract = options?.instrument !== undefined ? options.instrument : context.activeInstrument;
  const listing = options?.listing ?? context.activeListing;
  const selected = options?.symbol ?? context.activeTicker;
  if (contract === undefined || !selected) return spec;
  const selectedSymbol = parsePublicTickerKey(selected).symbol;
  const selectedExchange = canonicalExchange(parsePublicTickerKey(selected).exchange
    || listing?.exchange || (contract?.exchange === "SMART" ? contract.primaryExchange : contract?.exchange));
  return { ...spec, series: spec.series.map((series) => (
    series.source.kind === "security" && !series.source.instrument.instrument
      && parsePublicTickerKey(series.source.instrument.symbol).symbol === selectedSymbol
      && (!series.source.instrument.exchange || canonicalExchange(series.source.instrument.exchange) === selectedExchange)
      ? { ...series, source: { ...series.source, instrument: {
        ...series.source.instrument, exchange: listing?.exchange || contract?.exchange || series.source.instrument.exchange,
        brokerId: contract?.brokerId, brokerInstanceId: contract?.brokerInstanceId, instrument: contract,
      } } } : series
  )) };
}

/**
 * What a registered series reads as in a chart's title: without its ticker
 * when the chart shows that ticker's price, and once for all of its lines
 * (`Z-score`, not `AAPL · Z-score · Z · AAPL · Z-score · Upper`).
 */
function capabilityTitlePart(
  source: { capabilityId: string; seriesId: string },
  label: string,
  pricedTickers: ReadonlySet<string>,
): { text: string; group: string | null } {
  const slash = source.seriesId.indexOf("/");
  const named = slash < 0 ? source.seriesId : source.seriesId.slice(0, slash);
  let ticker: string | null = null;
  if (slash >= 0) {
    try {
      ticker = decodeURIComponent(source.seriesId.slice(slash + 1));
    } catch {
      ticker = source.seriesId.slice(slash + 1);
    }
  }
  let text = label;
  if (ticker && pricedTickers.has(ticker.toUpperCase())) {
    for (const lead of [`${ticker} · `, `${ticker} `]) {
      if (text.startsWith(lead) && text.length > lead.length) {
        text = text.slice(lead.length);
        break;
      }
    }
  }
  const tilde = named.indexOf("~");
  if (tilde < 0) return { text, group: null };
  const lineAt = text.lastIndexOf(" · ");
  return {
    text: lineAt > 0 ? text.slice(0, lineAt) : text,
    group: `${source.capabilityId}:${named.slice(0, tilde)}/${ticker ?? ""}`,
  };
}

function chartTitle(spec: ChartSpec, prefix = "G"): string {
  const pricedTickers = new Set(spec.series.flatMap((series) => series.source.kind === "security"
    ? [publicTickerKey(series.source.instrument.symbol, series.source.instrument.exchange).toUpperCase(), series.source.instrument.symbol.toUpperCase()]
    : []));
  const groups = new Set<string>();
  const parts = spec.series.flatMap((series) => {
    if (series.source.kind === "security") {
      return [tickerInstrumentLabel(publicTickerKey(series.source.instrument.symbol, series.source.instrument.exchange), series.source.instrument.instrument)];
    }
    if (series.source.kind === "economic") return [`FRED:${series.source.seriesId}`];
    const label = series.label?.trim() || registeredSeriesName(series.source) || series.source.seriesId;
    const { text, group } = capabilityTitlePart(series.source, label, pricedTickers);
    if (group) {
      if (groups.has(group)) return [];
      groups.add(group);
    }
    return [text];
  });
  const labels = parts.slice(0, 3);
  if (labels.length === 0) return "Custom Chart";
  const remaining = parts.length - labels.length;
  return `${prefix} ${labels.join(" · ")}${remaining > 0 ? ` +${remaining}` : ""}`;
}

/**
 * A series authored as a bare symbol resolves its venue through the sender's
 * ticker records at render time. Those records do not travel, so the venue is
 * written into the spec before the pane leaves the device. Broker contract
 * details stay local; only the public exchange is pinned.
 */
function pinChartSpecListings(spec: ChartSpec, tickers: ReadonlyMap<string, TickerRecord>): ChartSpec {
  let changed = false;
  const series = spec.series.map((entry) => {
    if (entry.source.kind !== "security" || entry.source.instrument.exchange?.trim()) return entry;
    const symbol = entry.source.instrument.symbol.trim().toUpperCase();
    const exchange = tickers.get(symbol)?.metadata.exchange?.trim();
    if (!exchange) return entry;
    changed = true;
    return {
      ...entry,
      source: {
        ...entry.source,
        instrument: { ...entry.source.instrument, exchange },
      },
    };
  });
  return changed ? { ...spec, series } : spec;
}

function prepareChartPaneForShare(
  pane: PaneInstanceConfig,
  { tickers, pinnedTime }: { tickers: ReadonlyMap<string, TickerRecord>; pinnedTime?: number },
): PaneInstanceConfig {
  // A crosshair pinned in the sender's tab travels with the link, so it opens
  // on that moment. A moment the pane still holds from a link it was opened
  // from is never passed on, whatever else the pane holds.
  const { [CHART_PINNED_MOMENT_SETTING_KEY]: held, ...settings } = pane.settings ?? {};
  const spec = parseChartSpec(pane.settings?.[CHART_SPEC_SETTING_KEY]);
  if (!spec) return held === undefined ? pane : { ...pane, settings };
  const pinned = pinChartSpecListings(spec, tickers);
  if (pinned === spec && pinnedTime === undefined && held === undefined) return pane;
  return { ...pane, settings: {
    ...settings,
    [CHART_SPEC_SETTING_KEY]: pinned,
    ...(pinnedTime !== undefined ? { [CHART_PINNED_MOMENT_SETTING_KEY]: pinnedTime } : {}),
  } };
}

interface SharedChartState {
  drawings?: ChartDrawing[];
  viewport?: ChartInteractionViewport;
}

function instanceFor(spec: ChartSpec, prefix: string, shared: SharedChartState = {}) {
  const symbol = primarySecuritySymbol(spec);
  const primary = spec.series.find((series) => series.source.kind === "security")?.source;
  const instrument = primary?.kind === "security" ? primary.instrument.instrument : null;
  return {
    title: chartTitle(spec, prefix),
    placement: "floating" as const,
    ...(symbol ? { binding: { kind: "fixed" as const, symbol, ...(instrument !== undefined ? { instrument } : {}) } } : {}),
    settings: {
      [CHART_SPEC_SETTING_KEY]: spec,
      ...(shared.drawings?.length
        ? { [CHART_DRAWINGS_SETTING_KEY]: shared.drawings }
        : {}),
      ...(shared.viewport
        ? { [CHART_INTERACTION_VIEWPORT_SETTING_KEY]: shared.viewport }
        : {}),
    },
  };
}

function selectedInstanceFor(spec: ChartSpec, prefix: string, context: PaneTemplateContext, options?: PaneTemplateCreateOptions) {
  const bound = bindSelectedContract(spec, context, options);
  const instance = instanceFor(bound, prefix);
  const primaryIndex = spec.series.findIndex(series => series.source.kind === "security");
  const primary = bound.series[primaryIndex]?.source;
  const symbol = options?.symbol ?? context.activeTicker;
  // Keep the saved ticker key for followers; the series and listing retain its venue.
  if (symbol && primary?.kind === "security" && primary !== spec.series[primaryIndex]?.source) {
    const listing = options?.listing ?? context.activeListing;
    return { ...instance, binding: { kind: "fixed" as const, symbol,
      instrument: primary.instrument.instrument, ...(listing ? { listing } : {}),
    } };
  }
  return instance;
}

function securityTemplate({
  id,
  prefix,
  aliases,
  label,
  description,
  returns,
  argKind,
  minimumSymbols,
  build,
  keywords = [],
  settings,
}: {
  id: Parameters<typeof chartHeadless>[0];
  prefix: "GP" | "GIP" | "CMP" | "GF" | "GE";
  aliases?: readonly string[];
  /** Searches beyond the label that should find it. */
  keywords?: readonly string[];
  label: string;
  description: string;
  /** What the report returns, when the description is about drawing the chart. */
  returns?: string;
  argKind: "ticker" | "ticker-list";
  minimumSymbols: number;
  build: (symbols: string[]) => ChartSpec;
  /** Pane settings the template opens with besides the chart. */
  settings?: Record<string, unknown>;
}): PaneTemplateDef {
  return {
    id,
    paneId: CHART_COMPOSER_PANE_ID,
    headless: { ...chartHeadless(id), ...(returns ? { description: returns } : {}) },
    label,
    description,
    keywords: ["chart", "graph", prefix.toLowerCase(), ...label.toLowerCase().split(" "), ...keywords],
    shortcut: {
      prefix,
      ...(aliases ? { aliases } : {}),
      argPlaceholder: argKind === "ticker" ? "ticker" : "tickers",
      argKind,
    },
    wizard: [{
      key: "tickers",
      label: argKind === "ticker" ? "Ticker" : "Tickers",
      placeholder: argKind === "ticker" ? "AAPL" : "AAPL, MSFT",
      type: "text",
      body: [argKind === "ticker" ? "Enter a ticker symbol." : "Enter ticker symbols separated by commas."],
    }],
    canCreate: (context, options) => templateSymbols(context, options).length >= minimumSymbols,
    createInstance: (context, options) => {
      const symbols = templateSymbols(context, options);
      if (symbols.length < minimumSymbols) return null;
      const instance = selectedInstanceFor(build(symbols), prefix, context, options);
      return settings ? { ...instance, settings: { ...instance.settings, ...settings } } : instance;
    },
  };
}

const chartComposerTemplates: PaneTemplateDef[] = [
  {
    id: CHART_COMPOSER_TEMPLATE_ID,
    headless: chartHeadless("chart-composer-pane"),
    paneId: CHART_COMPOSER_PANE_ID,
    label: "Custom Chart",
    description: "Chart arbitrary market, fundamental, valuation, and FRED series together.",
    // Futures formulas chart here: a crack spread is `42*HO=F - CL=F`.
    keywords: ["chart", "graph", "custom", "series", "fred", "fundamental", "crack spread", "refining margin"],
    shortcut: { prefix: "G", argPlaceholder: "series", argKind: "text", argOptional: true },
    wizard: [{
      key: "series",
      label: "Chart Series",
      placeholder: "AAPL:price, MSFT:revenue, FRED:CPIAUCSL",
      type: "text",
      // Empty falls back to the active ticker in createInstance, as `G` with no argument does.
      required: false,
      body: ["Enter comma-separated SYMBOL:field or FRED:series expressions, or leave empty to chart the active ticker. A/B charts the ratio, 42*HO=F - CL=F a formula. EUR/USD stays one series."],
    }],
    canCreate: () => true,
    createInstance: (context, options) => {
      const sharedData = isRecord(options?.shareData) ? options.shareData : null;
      const sharedSpec = parseChartSpec(sharedData?.chartSpec ?? options?.shareData);
      if (sharedSpec) {
        const drawings = parseChartDrawings(sharedData?.chartDrawings);
        const viewport = parseChartInteractionViewport(sharedData?.chartInteractionViewport);
        return instanceFor(sharedSpec, "G", {
          ...(drawings.length > 0 ? { drawings } : {}),
          ...(viewport ? { viewport } : {}),
        });
      }
      const expression = options?.arg?.trim() || options?.values?.series?.trim() || context.activeTicker || "";
      return selectedInstanceFor(buildCustomChartPreset(expression, context.activeTicker), "G", context, options);
    },
    publicShare: {
      serialize: ({ pane }) => {
        const spec = parseChartSpec(pane.settings?.[CHART_SPEC_SETTING_KEY]);
        if (!spec) return null;
        if (spec.series.some((series) => series.source.kind === "security"
          && (series.source.instrument.instrument || series.source.instrument.brokerId || series.source.instrument.brokerInstanceId))) return null;
        const drawings = parseChartDrawings(pane.settings?.[CHART_DRAWINGS_SETTING_KEY]);
        const viewport = parseChartInteractionViewport(
          pane.settings?.[CHART_INTERACTION_VIEWPORT_SETTING_KEY],
        );
        return {
          title: pane.title?.trim() || chartTitle(spec),
          data: {
            chartSpec: spec,
            ...(drawings.length > 0 ? { chartDrawings: drawings } : {}),
            ...(viewport ? { chartInteractionViewport: viewport } : {}),
          },
        };
      },
      restore: (data) => {
        if (!Object.keys(data).every((key) => [
          "chartSpec",
          "chartDrawings",
          "chartInteractionViewport",
        ].includes(key))) return null;
        const spec = parseChartSpec(data.chartSpec);
        if (!spec) return null;
        const drawings = parseChartDrawings(data.chartDrawings);
        if (data.chartDrawings !== undefined && (!Array.isArray(data.chartDrawings) || (data.chartDrawings.length > 0 && drawings.length === 0))) return null;
        const viewport = data.chartInteractionViewport === undefined
          ? null
          : parseChartInteractionViewport(data.chartInteractionViewport);
        if (data.chartInteractionViewport !== undefined && !viewport) return null;
        return {
          shareData: {
            chartSpec: spec,
            ...(drawings.length > 0 ? { chartDrawings: drawings } : {}),
            ...(viewport ? { chartInteractionViewport: viewport } : {}),
          },
        };
      },
    },
  },
  {
    id: DATA_CATALOG_TEMPLATE_ID,
    paneId: DATA_CATALOG_PANE_ID,
    label: "Data Catalog",
    description: "Browse and search every series a chart can draw: securities, rates, credit, economic data, volatility, sentiment, positioning and your own files.",
    keywords: [
      "catalog",
      "series",
      "data",
      "chart",
      "fred",
      "futures",
      "treasury",
      "crypto",
      "options",
      "option",
      "credit",
      "sentiment",
      "positioning",
    ],
    shortcut: { prefix: "CAT", argPlaceholder: "query", argKind: "text", argOptional: true },
    reportFreshness: { status: "not-a-feed", basis: "series catalog", local: true },
    canCreate: () => true,
    createInstance: (_context, options) => {
      const query = options?.arg?.trim() ?? options?.values?.query?.trim() ?? "";
      return {
        title: query ? `Catalog · ${query}` : "Data Catalog",
        placement: "floating" as const,
        ...(query ? { settings: { query } } : {}),
      };
    },
    publicShare: {
      serialize: ({ pane }) => {
        const query = typeof pane.settings?.query === "string" ? pane.settings.query.trim() : "";
        return { title: pane.title?.trim() || "Data Catalog", data: query ? { query } : {} };
      },
      restore: (data) => Object.keys(data).every((key) => key === "query")
        && (data.query === undefined || typeof data.query === "string")
        ? { arg: typeof data.query === "string" ? data.query : "" }
        : null,
    },
  },
  securityTemplate({
    id: "graph-price-pane",
    prefix: "GP",
    label: "Graph Price",
    description: "Open a price chart for a ticker.",
    returns: "Daily price history for one ticker over a range, 5Y by default. Returns the data; it does not open or show a chart.",
    argKind: "ticker",
    minimumSymbols: 1,
    build: (symbols) => buildPriceChartPreset(symbols[0]!),
  }),
  securityTemplate({
    id: "graph-intraday-price-pane",
    prefix: "GIP",
    label: "Intraday Price Graph",
    description: "Open an intraday price chart for one or five sessions.",
    returns: "Intraday price bars for one ticker over the last one or five sessions. Returns the data; it does not open or show a chart.",
    // The finest bars there are; tick and second searches land here and on QR.
    keywords: ["1 minute", "minute bars", "1m", "tick", "ticks", "second", "seconds", "trades"],
    argKind: "ticker",
    minimumSymbols: 1,
    build: (symbols) => buildIntradayPriceChartPreset(symbols[0]!),
  }),
  securityTemplate({
    id: "comparison-chart-pane",
    prefix: "CMP",
    aliases: ["COMP", "TRA"],
    label: "Comparison Chart",
    description: "Compare price returns over shared observation dates for two or more tickers, or total returns with distributions reinvested. A leveraged or inverse fund gets its daily objective drawn from its index fund (3× daily QQQ beside TQQQ) and its decay against it.",
    // Leveraged and inverse funds: the daily line and the decay come with the comparison.
    keywords: ["leveraged", "inverse", "decay", "daily-reset", "daily reset", "volatility decay"],
    argKind: "ticker-list",
    minimumSymbols: 2,
    build: buildComparisonChartPreset,
    settings: { [CHART_LEVERAGE_PENDING_SETTING_KEY]: true },
  }),
  securityTemplate({
    id: "fundamental-graph-pane",
    prefix: "GF",
    label: "Fundamental Graph",
    description: "Graph quarterly revenue for one or more tickers, then choose any available field in Series.",
    returns: "Annual or quarterly fundamental history for one or more tickers: revenue by default, or the field named by metric.",
    argKind: "ticker-list",
    minimumSymbols: 1,
    build: buildFundamentalChartPreset,
  }),
  securityTemplate({
    id: "valuation-graph-pane",
    prefix: "GE",
    label: "Valuation Graph",
    description: "Graph trailing P/E for one or more tickers, then choose any available field in Series.",
    returns: "Annual or quarterly valuation multiple history for one or more tickers: trailing P/E by default, or the multiple named by metric.",
    argKind: "ticker-list",
    minimumSymbols: 1,
    build: buildValuationChartPreset,
  }),
];

/**
 * A chart whose securities are all one ticker can follow a list: GP, GIP, and GF or GE of one
 * ticker, whatever fields it shows (revenue beside total debt). Every series of that ticker moves
 * to the selected one and keeps its field; FRED and other series stay as they are. A comparison
 * of several tickers would move only one of them, and a FRED-only chart has no ticker to follow.
 */
function chartShowsOneSecurity(pane: PaneInstanceConfig): boolean {
  const spec = parseChartSpec(pane.settings?.[CHART_SPEC_SETTING_KEY]);
  // Without a saved spec the pane draws its bound ticker's price.
  if (!spec) return true;
  const symbols = new Set<string>();
  for (const series of spec.series) {
    if (series.source.kind !== "security") continue;
    symbols.add(parsePublicTickerKey(series.source.instrument.symbol).symbol.toUpperCase());
  }
  return symbols.size === 1;
}

export const chartComposerModule: PluginModule = {
  // Every ticker field, asking for the ticker when charted.
  series: listFieldSeries(),
  panes: [{
    id: CHART_COMPOSER_PANE_ID,
    name: "Chart",
    icon: "G",
    component: ChartComposerPane,
    defaultPosition: "right",
    tickerFollower: chartShowsOneSecurity,
    defaultMode: "floating",
    defaultFloatingSize: { width: 100, height: 32 },
    portableShare: { prepare: prepareChartPaneForShare },
    quickSettings: [LIVE_STREAMING_QUICK_SETTING],
    settings: (context) => withLiveStreamingSetting(
      buildChartComposerPaneSettingsDef(
        context.settings,
        context.activeTicker,
      ),
      context.settings,
    ),
  }, {
    id: DATA_CATALOG_PANE_ID,
    name: "Data Catalog",
    icon: "C",
    component: DataCatalogPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 110, height: 32 },
  }],
  paneTemplates: chartComposerTemplates,
  setup(ctx) {
    ctx.registerTickerResearchTab({
      id: "chart",
      name: "Chart",
      order: 30,
      component: ChartComposerResearchTab,
      isVisible: ({ ticker }) => !!ticker,
    });
  },
};
