import type { PluginModule } from "../plugin-module";
import { parseTickerListInput, formatTickerListInput } from "../../../tickers/list";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { CorporateActionsView } from "./corporate-actions-pane";
import { relativeValuationHeadless } from "./relative-valuation-headless";
import { AUTO_PEERS_SETTING, relativeValuationTitle } from "./relative-valuation-peers";
import { buildRelativeValuationSettingsDef, MAX_RELATIVE_VALUATION_TICKERS } from "./relative-valuation-settings";
import { analystResearchHeadless } from "./analyst-headless";
import { eventsHeadless } from "./events-headless";
import { earningsEstimatesHeadless } from "./headless";


function EarningsEstimatesPane(props: { focused: boolean; width: number; height: number }) {
  return (
    <CorporateActionsView
      {...props}
      footerPaneId="earnings-estimates"
      variant="earnings-estimates"
    />
  );
}

export const researchModule: PluginModule = {
  setup(ctx) {
    ctx.registerTickerResearchTab({
      id: "analyst-research",
      name: "Analyst",
      order: 32,
      get component(): typeof import("./analyst-pane").AnalystResearchView { const { AnalystResearchView } = require("./analyst-pane"); return AnalystResearchView; },
      instruments: ["equity"],
    });
    ctx.registerTickerResearchTab({
      id: "equity-diagnostic",
      name: "Diagnostic",
      order: 33,
      get component(): typeof import("./equity-diagnostic-pane").EquityDiagnosticView { const { EquityDiagnosticView } = require("./equity-diagnostic-pane"); return EquityDiagnosticView; },
      instruments: ["equity"],
    });
    ctx.registerTickerResearchTab({
      id: "corporate-actions",
      name: "Events",
      order: 34,
      component: CorporateActionsView,
      instruments: ["equity", "fund"],
    });
  },

  panes: [
    {
      id: "analyst-research",
      name: "Analyst Research",
      icon: "A",
      get component(): typeof import("./analyst-pane").AnalystResearchView { const { AnalystResearchView } = require("./analyst-pane"); return AnalystResearchView; },
      defaultPosition: "right",
      tickerFollower: true,
      instruments: ["equity"],
      defaultMode: "floating",
      defaultFloatingSize: { width: 90, height: 28 },
      tableExport: true,
    },
    {
      id: "equity-diagnostic",
      reportFreshness: { status: "not-a-feed", basis: "analysis of filings" },
      // Signed in, Free reads a preview and Pro the full report; signed out it shows the sign-in wall.
      reportRequirements: ["Free Gloom sign-in"],
      name: "Equity Diagnostic",
      icon: "D",
      get component(): typeof import("./equity-diagnostic-pane").EquityDiagnosticView { const { EquityDiagnosticView } = require("./equity-diagnostic-pane"); return EquityDiagnosticView; },
      defaultPosition: "right",
      tickerFollower: true,
      instruments: ["equity"],
      defaultMode: "floating",
      defaultFloatingSize: { width: 96, height: 30 },
    },
    {
      id: "corporate-actions",
      name: "Corporate Actions",
      icon: "E",
      component: CorporateActionsView,
      defaultPosition: "right",
      tickerFollower: true,
      defaultMode: "floating",
      defaultFloatingSize: { width: 104, height: 24 },
      tableExport: true,
      headless: eventsHeadless,
    },
    {
      id: "relative-valuation",
      name: "Relative Valuation",
      icon: "R",
      get component(): typeof import("./relative-valuation-pane").RelativeValuationPane { const { RelativeValuationPane } = require("./relative-valuation-pane"); return RelativeValuationPane; },
      headless: relativeValuationHeadless,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 104, height: 24 },
      tableExport: true,
      settings: buildRelativeValuationSettingsDef,
    },
    {
      id: "earnings-estimates",
      name: "Earnings Estimates",
      icon: "E",
      component: EarningsEstimatesPane,
      defaultPosition: "right",
      tickerFollower: true,
      instruments: ["equity"],
      defaultMode: "floating",
      defaultFloatingSize: { width: 104, height: 22 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    {
      ...createTickerSurfacePaneTemplate({
        id: "analyst-research-pane",
        paneId: "analyst-research",
        label: "Analyst Research",
        description: "Price targets, recommendations, and recent analyst actions.",
        keywords: ["analyst", "research", "ratings", "target", "anr"],
        shortcut: "ANR",
        publicShare: true,
      }),
      headless: analystResearchHeadless,
    },
    createTickerSurfacePaneTemplate({
      id: "equity-diagnostic-pane",
      paneId: "equity-diagnostic",
      label: "Equity Diagnostic",
      description: "Red flags, anomalies, green flags, and watch items for one company, with cited evidence.",
      keywords: ["diagnostic", "diag", "red flags", "anomalies", "green flags", "review", "evidence"],
      shortcut: "DIAG",
      publicShare: true,
    }),
    createTickerSurfacePaneTemplate({
      id: "corporate-actions-pane",
      paneId: "corporate-actions",
      label: "Corporate Actions",
      description: "Dividends, splits, reported earnings, and analyst estimates.",
      keywords: ["events", "corporate", "actions", "dividend", "split", "earnings", "estimate", "revenue", "evt"],
      shortcut: "EVT",
      publicShare: true,
    }),
    {
      ...createTickerSurfacePaneTemplate({
        id: "earnings-estimates-pane",
        paneId: "earnings-estimates",
        label: "Earnings Estimates",
        description: "EPS and revenue estimates with reported earnings.",
        keywords: ["earnings", "estimates", "ee", "analyst", "eps", "revenue", "events"],
        shortcut: "EE",
        publicShare: true,
      }),
      headless: earningsEstimatesHeadless,
    },
    {
      id: "relative-valuation-pane",
      headless: relativeValuationHeadless,
      paneId: "relative-valuation",
      label: "Relative Valuation",
      description: "Compare valuation and operating metrics across peers.",
      // The words an analyst asks for a comp table by.
      keywords: ["relative", "valuation", "comps", "peers", "rv", "comp table", "comparable companies", "peer comparison", "competitors"],
      shortcut: { prefix: "RV", argPlaceholder: "tickers", argKind: "ticker-list" },
      canCreate: (context, options) => !!(options?.symbols?.length || options?.arg || context.activeTicker),
      createInstance: (context, options) => {
        let symbols: string[];
        try {
          symbols = options?.symbols?.length
            ? options.symbols
            : parseTickerListInput(options?.arg ?? context.activeTicker ?? "", MAX_RELATIVE_VALUATION_TICKERS);
        } catch {
          return null;
        }
        return {
          title: relativeValuationTitle(symbols, null),
          placement: "floating",
          // One ticker is compared with the peers `--peers` picks, which the pane finds once it opens.
          settings: { symbols, symbolsText: formatTickerListInput(symbols), ...(symbols.length === 1 ? { [AUTO_PEERS_SETTING]: true } : {}) },
        };
      },
    },
  ],
};
