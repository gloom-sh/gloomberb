import type { PluginModule } from "../plugin-module";
import { parseTickerListInput, formatTickerListInput } from "../../../tickers/list";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { AnalystResearchView } from "./analyst-pane";
import { CorporateActionsView } from "./corporate-actions-pane";
import { EquityDiagnosticView } from "./equity-diagnostic-pane";
import { RelativeValuationPane } from "./relative-valuation-pane";

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
      component: AnalystResearchView,
      isVisible: ({ ticker }) => !!ticker,
    });
    ctx.registerTickerResearchTab({
      id: "equity-diagnostic",
      name: "Diagnostic",
      order: 33,
      component: EquityDiagnosticView,
      isVisible: ({ ticker }) => !!ticker,
    });
    ctx.registerTickerResearchTab({
      id: "corporate-actions",
      name: "Events",
      order: 34,
      component: CorporateActionsView,
      isVisible: ({ ticker }) => !!ticker,
    });
  },

  panes: [
    {
      id: "analyst-research",
      name: "Analyst Research",
      icon: "A",
      component: AnalystResearchView,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 90, height: 28 },
    },
    {
      id: "equity-diagnostic",
      name: "Equity Diagnostic",
      icon: "D",
      component: EquityDiagnosticView,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 96, height: 30 },
    },
    {
      id: "corporate-actions",
      name: "Corporate Actions",
      icon: "E",
      component: CorporateActionsView,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 104, height: 24 },
    },
    {
      id: "relative-valuation",
      name: "Relative Valuation",
      icon: "R",
      component: RelativeValuationPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 104, height: 24 },
    },
    {
      id: "earnings-estimates",
      name: "Earnings Estimates",
      icon: "E",
      component: EarningsEstimatesPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 104, height: 22 },
    },
  ],

  paneTemplates: [
    createTickerSurfacePaneTemplate({
      id: "analyst-research-pane",
      paneId: "analyst-research",
      label: "Analyst Research",
      description: "Price targets, recommendations, and recent analyst actions.",
      keywords: ["analyst", "research", "ratings", "target", "anr"],
      shortcut: "ANR",
      publicShare: true,
    }),
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
    createTickerSurfacePaneTemplate({
      id: "earnings-estimates-pane",
      paneId: "earnings-estimates",
      label: "Earnings Estimates",
      description: "EPS and revenue estimates with reported earnings.",
      keywords: ["earnings", "estimates", "ee", "analyst", "eps", "revenue", "events"],
      shortcut: "EE",
      publicShare: true,
    }),
    {
      id: "relative-valuation-pane",
      paneId: "relative-valuation",
      label: "Relative Valuation",
      description: "Compare valuation and operating metrics across peers.",
      keywords: ["relative", "valuation", "comps", "peers", "rv"],
      shortcut: { prefix: "RV", argPlaceholder: "tickers", argKind: "ticker-list" },
      canCreate: (context, options) => !!(options?.symbols?.length || options?.arg || context.activeTicker),
      createInstance: (context, options) => {
        let symbols: string[];
        try {
          symbols = options?.symbols?.length
            ? options.symbols
            : parseTickerListInput(options?.arg ?? context.activeTicker ?? "", 12);
        } catch {
          return null;
        }
        return {
          title: `RV ${formatTickerListInput(symbols)}`,
          placement: "floating",
          settings: { symbols, symbolsText: formatTickerListInput(symbols) },
        };
      },
    },
  ],
};
