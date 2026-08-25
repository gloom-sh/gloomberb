import type {
  PaneTemplateContext,
  PaneTemplateCreateOptions,
  PaneTemplateDef,
} from "../../../types/plugin";
import { CHART_COMPOSER_PANE_ID } from "../../../types/config";
import { parseTickerListInput } from "../../../tickers/list";
import { publicTickerKey } from "../../../utils/exchanges";
import type { ChartSpec } from "../../../time-series/types";
import { ChartComposerPane, ChartComposerResearchTab } from "./pane";
import { DataCatalogPane } from "./data-catalog-pane";
import {
  CHART_COMPOSER_TEMPLATE_ID,
  DATA_CATALOG_PANE_ID,
  DATA_CATALOG_TEMPLATE_ID,
} from "./catalog-inventory";
import { CHART_SPEC_SETTING_KEY, parseChartSpec } from "./chart-spec";
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
} from "../shared/live-streaming";

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

function chartTitle(spec: ChartSpec, prefix = "G"): string {
  const labels = spec.series.slice(0, 3).map((series) => (
    series.source.kind === "security"
      ? publicTickerKey(series.source.instrument.symbol, series.source.instrument.exchange)
      : series.source.kind === "economic"
        ? `FRED:${series.source.seriesId}`
        : series.label?.trim() || series.source.seriesId
  ));
  if (labels.length === 0) return "Custom Chart";
  const remaining = spec.series.length - labels.length;
  return `${prefix} ${labels.join(" · ")}${remaining > 0 ? ` +${remaining}` : ""}`;
}

function instanceFor(spec: ChartSpec, prefix: string) {
  const symbol = primarySecuritySymbol(spec);
  return {
    title: chartTitle(spec, prefix),
    placement: "floating" as const,
    ...(symbol ? { binding: { kind: "fixed" as const, symbol } } : {}),
    settings: {
      [CHART_SPEC_SETTING_KEY]: spec,
    },
  };
}

function securityTemplate({
  id,
  prefix,
  label,
  description,
  argKind,
  minimumSymbols,
  build,
}: {
  id: string;
  prefix: "GP" | "GIP" | "CMP" | "GF" | "GE";
  label: string;
  description: string;
  argKind: "ticker" | "ticker-list";
  minimumSymbols: number;
  build: (symbols: string[]) => ChartSpec;
}): PaneTemplateDef {
  return {
    id,
    paneId: CHART_COMPOSER_PANE_ID,
    label,
    description,
    keywords: ["chart", "graph", prefix.toLowerCase(), ...label.toLowerCase().split(" ")],
    shortcut: {
      prefix,
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
      return symbols.length >= minimumSymbols ? instanceFor(build(symbols), prefix) : null;
    },
  };
}

const chartComposerTemplates: PaneTemplateDef[] = [
  {
    id: CHART_COMPOSER_TEMPLATE_ID,
    paneId: CHART_COMPOSER_PANE_ID,
    label: "Custom Chart",
    description: "Chart arbitrary market, fundamental, valuation, and FRED series together.",
    keywords: ["chart", "graph", "custom", "series", "fred", "fundamental"],
    shortcut: { prefix: "G", argPlaceholder: "series", argKind: "text", argOptional: true },
    wizard: [{
      key: "series",
      label: "Chart Series",
      placeholder: "AAPL:price, MSFT:revenue, FRED:CPIAUCSL",
      type: "text",
      body: ["Enter comma-separated SYMBOL:field or FRED:series expressions."],
    }],
    canCreate: () => true,
    createInstance: (context, options) => {
      const sharedSpec = parseChartSpec(options?.shareData);
      if (sharedSpec) return instanceFor(sharedSpec, "G");
      const expression = options?.arg?.trim() || options?.values?.series?.trim() || context.activeTicker || "";
      return instanceFor(buildCustomChartPreset(expression, context.activeTicker), "G");
    },
    publicShare: {
      serialize: ({ pane }) => {
        const spec = parseChartSpec(pane.settings?.[CHART_SPEC_SETTING_KEY]);
        return spec
          ? { title: pane.title?.trim() || chartTitle(spec), data: { chartSpec: spec } }
          : null;
      },
      restore: (data) => {
        if (Object.keys(data).length !== 1) return null;
        const spec = parseChartSpec(data.chartSpec);
        return spec ? { shareData: spec } : null;
      },
    },
  },
  {
    id: DATA_CATALOG_TEMPLATE_ID,
    paneId: DATA_CATALOG_PANE_ID,
    label: "Data Catalog",
    description: "Browse and search the series Custom Chart already knows: securities, options, crypto, FRED, treasuries, and futures.",
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
    ],
    shortcut: { prefix: "CAT", argPlaceholder: "query", argKind: "text", argOptional: true },
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
    argKind: "ticker",
    minimumSymbols: 1,
    build: (symbols) => buildPriceChartPreset(symbols[0]!),
  }),
  securityTemplate({
    id: "graph-intraday-price-pane",
    prefix: "GIP",
    label: "Intraday Price Graph",
    description: "Open a one-minute intraday price chart.",
    argKind: "ticker",
    minimumSymbols: 1,
    build: (symbols) => buildIntradayPriceChartPreset(symbols[0]!),
  }),
  securityTemplate({
    id: "comparison-chart-pane",
    prefix: "CMP",
    label: "Comparison Chart",
    description: "Compare percentage performance for two or more tickers.",
    argKind: "ticker-list",
    minimumSymbols: 2,
    build: buildComparisonChartPreset,
  }),
  securityTemplate({
    id: "fundamental-graph-pane",
    prefix: "GF",
    label: "Fundamental Graph",
    description: "Graph quarterly revenue for one or more tickers, then choose any available field in Series.",
    argKind: "ticker-list",
    minimumSymbols: 1,
    build: buildFundamentalChartPreset,
  }),
  securityTemplate({
    id: "valuation-graph-pane",
    prefix: "GE",
    label: "Valuation Graph",
    description: "Graph trailing P/E for one or more tickers, then choose any available field in Series.",
    argKind: "ticker-list",
    minimumSymbols: 1,
    build: buildValuationChartPreset,
  }),
];

export const chartComposerModule: PluginModule = {
  panes: [{
    id: CHART_COMPOSER_PANE_ID,
    name: "Chart",
    icon: "G",
    component: ChartComposerPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 100, height: 32 },
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

export * from "./chart-spec";
export * from "./presets";
export * from "./settings";
