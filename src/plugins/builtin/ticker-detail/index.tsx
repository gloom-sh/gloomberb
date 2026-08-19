import type { PluginModule } from "../plugin-module";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { normalizeTickerInput } from "../../../tickers/search";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { FinancialAnalysisPane } from "./financials/pane";
import { HistoricalPricesPane } from "./data-panes/historical-prices";
import {
  createProviderSearchPaneTemplate,
  ProviderSearchPane,
} from "./data-panes/provider-search";
import { TickerResearchPane } from "./pane";
import { TICKER_RESEARCH_BUILTIN_TABS } from "./research-tabs";
import { QuoteMonitorPane } from "./quote-monitor";
import {
  buildQuoteMonitorSettingsDef,
  buildQuoteMonitorPaneTitle,
  buildTickerResearchSettingsDef,
  getTickerResearchPaneSettings,
} from "./settings";
import { formatTickerListInput } from "../../../tickers/list";
import {
  LIVE_STREAMING_QUICK_SETTING,
  withLiveStreamingSetting,
} from "../shared/live-streaming";

export const tickerDetailModule: PluginModule = {
  setup(ctx) {
    for (const tab of TICKER_RESEARCH_BUILTIN_TABS) {
      ctx.registerTickerResearchTab(tab);
    }
  },

  panes: [
    {
      id: TICKER_RESEARCH_PANE_ID,
      name: "Research",
      icon: "D",
      component: TickerResearchPane,
      defaultPosition: "right",
      defaultMode: "floating",
      quickSettings: [LIVE_STREAMING_QUICK_SETTING],
      settings: (context) => withLiveStreamingSetting(
        buildTickerResearchSettingsDef(getTickerResearchPaneSettings(context.settings)),
        context.settings,
      ),
    },
    {
      id: "financial-analysis",
      name: "Financials",
      icon: "F",
      component: FinancialAnalysisPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 98, height: 30 },
    },
    {
      id: "quote-monitor",
      name: "Quote Monitor",
      icon: "Q",
      component: QuoteMonitorPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 72, height: 10 },
      quickSettings: [LIVE_STREAMING_QUICK_SETTING],
      settings: (context) => withLiveStreamingSetting(buildQuoteMonitorSettingsDef(), context.settings),
    },
    {
      id: "historical-prices",
      name: "Historical Prices",
      icon: "H",
      component: HistoricalPricesPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 92, height: 26 },
    },
    {
      id: "provider-search-results",
      name: "Provider Search",
      icon: "S",
      component: ProviderSearchPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 86, height: 24 },
    },
  ],
  paneTemplates: [
    {
      id: "new-ticker-detail-pane",
      paneId: TICKER_RESEARCH_PANE_ID,
      label: "Ticker Research",
      description: "Open another research pane for the selected ticker or current collection",
      keywords: ["new", "ticker", "research", "detail", "pane", "inspector"],
      shortcut: { prefix: "T", argPlaceholder: "ticker", argKind: "ticker" },
      canCreate: (context) => context.activeTicker !== null || context.activeCollectionId !== null,
      createInstance: (context) => (
        context.activeTicker
          ? {
            title: context.activeTicker,
            binding: { kind: "fixed", symbol: context.activeTicker },
          }
          : {}
      ),
    },
    {
      id: "quote-monitor-pane",
      paneId: "quote-monitor",
      label: "Quote Monitor",
      description: "Open a compact quote monitor for one or more tickers",
      keywords: ["quote", "monitor", "price", "ticker", "pane"],
      shortcut: { prefix: "QQ", argPlaceholder: "tickers", argKind: "ticker-list" },
      wizard: [
        {
          key: "tickers",
          label: "Quote Tickers",
          placeholder: "AAPL, MSFT, NVDA",
          body: ["Enter one or more ticker symbols separated by commas."],
          type: "text",
        },
      ],
      canCreate: (context, options) => (
        (options?.symbols?.length ?? 0) > 0
        || normalizeTickerInput(context.activeTicker, options?.arg) !== null
      ),
      createInstance: (context, options) => {
        const symbols = options?.symbols?.length
          ? options.symbols
          : [normalizeTickerInput(context.activeTicker, options?.arg)].filter((symbol): symbol is string => !!symbol);
        const primarySymbol = symbols[0];
        return primarySymbol
          ? {
            title: buildQuoteMonitorPaneTitle(symbols),
            binding: { kind: "fixed", symbol: primarySymbol },
            settings: {
              symbol: primarySymbol,
              symbols,
              symbolsText: formatTickerListInput(symbols),
            },
            placement: "floating",
          }
          : null;
      },
    },
    createTickerSurfacePaneTemplate({
      id: "historical-prices-pane",
      paneId: "historical-prices",
      label: "Historical Prices",
      description: "Open a historical OHLCV table for a ticker.",
      keywords: ["historical", "prices", "hp", "ohlc", "volume"],
      shortcut: "HP",
    }),
    createProviderSearchPaneTemplate(),
    createTickerSurfacePaneTemplate({
      id: "financial-analysis-pane",
      paneId: "financial-analysis",
      label: "Financial Analysis",
      description: "Open financial statements for a ticker.",
      keywords: ["fa", "financial", "analysis", "statements"],
      shortcut: "FA",
      titlePrefix: "FA",
    }),
  ],
};
