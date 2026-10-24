import { publicTickerBindingSymbol } from "../../../tickers/selection";
import type { PluginModule } from "../plugin-module";
import { holdsActiveTicker } from "../../../shares/pane-image";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { normalizeTickerInput } from "../../../tickers/search";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { FinancialAnalysisPane } from "./financials/pane";
import { HistoricalPricesPane } from "./data-panes/historical-prices";
import { ReturnsPane } from "./data-panes/returns-pane";
import { TickerResearchPane } from "./pane";
import { futuresContractCache } from "./overview/futures-contract";
import { offeringFilingsCache } from "./financials/offerings";
import { TICKER_RESEARCH_BUILTIN_TABS } from "./research-tabs";
import { QuoteMonitorPane } from "./quote-monitor";
import { financialStatementsHeadless, historicalPricesHeadless, quoteComparisonHeadless, returnsHeadless } from "./headless";
import {
  buildQuoteMonitorSettingsDef,
  buildQuoteMonitorPaneTitle,
  buildTickerResearchSettingsDef,
  getTickerResearchPaneSettings,
} from "./settings";
import { formatTickerListInput } from "../../../tickers/list";
import { withCommandTab } from "../shared/command-tab";
import { buildTickerSurfaceInstanceId } from "../shared/ticker-surface";
import { adrPairHeadless, ADR_PAIR_KEYWORDS } from "./adr-pair/headless";
import { ADR_PAIR_TAB_ID, ADR_PAIR_TEMPLATE_ID } from "./adr-pair/model";
import {
  LIVE_STREAMING_QUICK_SETTING,
  withLiveStreamingSetting,
} from "../../../state/hooks/live-streaming";

export const tickerDetailModule: PluginModule = {
  setup(ctx) {
    futuresContractCache.attach(ctx.persistence);
    offeringFilingsCache.attach(ctx.persistence);
    for (const tab of TICKER_RESEARCH_BUILTIN_TABS) {
      ctx.registerTickerResearchTab(tab);
    }
  },
  dispose() {
    futuresContractCache.reset();
    offeringFilingsCache.reset();
  },

  panes: [
    {
      id: TICKER_RESEARCH_PANE_ID,
      name: "Research",
      icon: "D",
      component: TickerResearchPane,
      defaultPosition: "right",
      tickerFollower: true,
      // DES and ADR open this pane; ADR's window is named by its params (the tab it asked for), so settings never say whose a window is.
      identitySettings: [],
      personalData: (context) => {
        const settings = getTickerResearchPaneSettings(context.settings);
        const tab = settings.hideTabs ? settings.lockedTabId : context.paneState.activeTabId;
        // Notes and theses stay private even for a ticker the person does not hold.
        if (tab === "notes") return "messages";
        return tab === "thesis" || holdsActiveTicker(context) ? "holdings" : null;
      },
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
      headless: financialStatementsHeadless,
      defaultPosition: "right",
      tickerFollower: true,
      defaultMode: "floating",
      defaultFloatingSize: { width: 98, height: 30 },
      tableExport: true,
    },
    {
      id: "quote-monitor",
      name: "Quote Monitor",
      icon: "Q",
      component: QuoteMonitorPane,
      headless: quoteComparisonHeadless,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 72, height: 10 },
      quickSettings: [LIVE_STREAMING_QUICK_SETTING],
      settings: (context) => withLiveStreamingSetting(
        buildQuoteMonitorSettingsDef(context.settings),
        context.settings,
      ),
    },
    {
      id: "historical-prices",
      name: "Historical Prices",
      icon: "H",
      component: HistoricalPricesPane,
      headless: historicalPricesHeadless,
      defaultPosition: "right",
      tickerFollower: true,
      defaultMode: "floating",
      defaultFloatingSize: { width: 92, height: 26 },
      tableExport: true,
    },
    {
      id: "returns",
      reportFreshness: { status: "not-a-feed", basis: "price history" },
      name: "Returns",
      icon: "R",
      component: ReturnsPane,
      headless: returnsHeadless,
      defaultPosition: "right",
      tickerFollower: true,
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 28 },
      tableExport: true,
    },
  ],
  paneTemplates: [
    {
      id: "new-ticker-detail-pane",
      paneId: TICKER_RESEARCH_PANE_ID,
      label: "Ticker Research",
      description: "Open another research pane for the selected ticker or current collection",
      keywords: ["new", "ticker", "research", "detail", "pane", "inspector", "runway", "cash runway", "burn", "cash burn", "months of cash"],
      shortcut: { prefix: "T", aliases: ["DES"], argPlaceholder: "ticker", argKind: "ticker" },
      canCreate: (context) => context.activeTicker !== null || context.activeCollectionId !== null,
      createInstance: (context) => (
        context.activeTicker
          ? {
            title: context.activeTicker,
            binding: { kind: "fixed", symbol: context.activeTicker },
          }
          : {}
      ),
      publicShare: {
        serialize: ({ pane }) => pane.binding?.kind === "fixed" && publicTickerBindingSymbol(pane.binding)
          ? { title: pane.title?.trim() || pane.binding.symbol, data: { symbol: publicTickerBindingSymbol(pane.binding)! } }
          : null,
        restore: (data) => Object.keys(data).length === 1 && typeof data.symbol === "string" && data.symbol.trim()
          ? { symbol: data.symbol.trim().toUpperCase(), instrument: null }
          : null,
      },
    },
    {
      // DES on its ADR vs Home tab: no pane of its own.
      ...withCommandTab({
        id: ADR_PAIR_TEMPLATE_ID,
        paneId: TICKER_RESEARCH_PANE_ID,
        label: "ADR vs Home",
        description: "A depositary receipt beside its home listing: the ratio, both prices, the dollar rate they imply (the CCL rate for an Argentine pair), spot, and the receipt's premium or discount.",
        keywords: [...ADR_PAIR_KEYWORDS],
        shortcut: { prefix: "ADR", argPlaceholder: "ticker", argKind: "ticker" },
        canCreate: (context, options) => normalizeTickerInput(context.activeTicker, options?.arg) !== null,
        // One window a listing: ADR again focuses it and brings its tab back.
        createInstance: (context, options) => {
          const symbol = options?.symbol?.trim().toUpperCase() || normalizeTickerInput(context.activeTicker, options?.arg);
          return symbol ? {
            instanceId: buildTickerSurfaceInstanceId(TICKER_RESEARCH_PANE_ID, symbol, "ADR"),
            title: symbol, binding: { kind: "fixed", symbol }, placement: "floating",
          } : null;
        },
      }, ADR_PAIR_TAB_ID),
      headless: adrPairHeadless,
    },
    {
      id: "quote-monitor-pane",
      headless: quoteComparisonHeadless,
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
    {
      ...createTickerSurfacePaneTemplate({
        id: "returns-pane",
        paneId: "returns",
        label: "Returns",
        description: "Inspect interval and cumulative price returns over a selectable range and granularity.",
        keywords: ["returns", "return", "performance", "change", "interval", "granularity", "drawdown", "max drawdown", "peak to trough"],
        shortcut: "RETURN",
        publicShare: true,
        titlePrefix: "RETURN",
      }),
      headless: returnsHeadless,
    },
    {
      ...createTickerSurfacePaneTemplate({
        id: "historical-prices-pane",
        paneId: "historical-prices",
        label: "Historical Prices",
        description: "Open a historical OHLCV table for a ticker.",
        keywords: ["historical", "prices", "hp", "ohlc", "volume", "drawdown", "max drawdown", "peak to trough"],
        shortcut: "HP",
        publicShare: true,
      }),
      headless: historicalPricesHeadless,
    },
    {
      ...createTickerSurfacePaneTemplate({
        id: "financial-analysis-pane",
        paneId: "financial-analysis",
        label: "Financial Analysis",
        description: "Open financial statements for a ticker.",
        keywords: ["fa", "financial", "analysis", "statements", "runway", "cash runway", "burn", "cash burn", "months of cash"],
        shortcut: "FA",
        publicShare: true,
        titlePrefix: "FA",
      }),
      headless: financialStatementsHeadless,
    },
  ],
};
