import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { OptionsScenarioPane } from "./pane";
import { optionsScenarioHeadless } from "./headless";
import { CspScreenPane } from "./csp-screen-pane";
import { cspScreenHeadless } from "./csp-screen-headless";

const scenarioSettingKeys = ["legs", "strategy", "strike", "delta", "putStrike", "callStrike", "shares", "expiration", "spot", "rate", "dividendYield", "currency", "asOf", "date", "volShift",
  "spotRange", "seedLeg", "nav", "budgetBps", "sleeve"];

export const optionsScenarioModule: PluginModule = {
  panes: [{
    id: "options-scenario", name: "Options Scenario", icon: "V", component: OptionsScenarioPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 126, height: 36 },
    tableExport: true, headless: optionsScenarioHeadless,
    settings: {
      title: "Options Scenario Settings",
      fields: [
        { key: "spotRange", label: "Spot grid range (%)", type: "text" },
        { key: "nav", label: "Hedge NAV", type: "text", placeholder: "100m",
          description: "Portfolio NAV a hedge budget is a share of, such as 100m, 2.5bn or 1,000,000. Set with a budget to size the position." },
        { key: "budgetBps", label: "Hedge budget (bps)", type: "text", placeholder: "50",
          description: "Share of NAV to spend on the position, in basis points: 50 is 0.5%." },
        { key: "sleeve", label: "Equity sleeve", type: "text", placeholder: "100m",
          description: "The equity the hedge protects, for coverage: notional protected over the sleeve." },
      ],
    },
  }, {
    id: "csp-screen", name: "Options Strategy Screen", icon: "V", component: CspScreenPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 144, height: 24 },
    tableExport: true, headless: cspScreenHeadless,
    settings: {
      title: "Options Strategy Screen",
      fields: [
        { key: "symbols", label: "Symbols", type: "text", placeholder: "JPM, GS, KO" },
        { key: "maxSpread", label: "Wide spread over (%)", type: "text", placeholder: "10",
          description: "A trade whose bid/ask spread is over this percent of its mid is marked wide. It is still ranked." },
      ],
    },
  }],
  paneTemplates: [{
    id: "csp-screen-pane", paneId: "csp-screen", label: "Options Strategy Screen",
    description: "Cash-secured puts, covered calls, verticals, iron condors, straddles, strangles and calendars across a list, ranked, "
      + "with max gain and loss, break-evens, probability of profit, IV rank, spread and an earnings flag.",
    // The put-selling phrases lead here first, then to OSA for one name; so do the strategies it screens.
    keywords: ["csp", "cash secured put", "cash-secured puts", "put selling", "selling puts", "sell put", "sell puts", "short put", "wheel",
      "put screen", "premium yield", "strategy screen", "options screener", "covered call", "covered calls", "iron condor", "strangle",
      "straddle screen", "calendar spread", "bull put spread", "bear call spread", "vertical spread"],
    shortcut: { prefix: "CSP", argKind: "ticker-list" as const }, headless: cspScreenHeadless,
    createInstance: (_context, options) => ({
      title: "CSP", placement: "floating" as const,
      settings: options?.symbols?.length ? { symbols: options.symbols.join(",") } : {},
    }),
  }, createTickerSurfacePaneTemplate({
    id: "options-scenario-pane", paneId: "options-scenario", label: "Options Scenario",
    description: "Build multi-leg positions and compare scenario P&L, payoff and aggregate Greeks.",
    // OSA carries the put-selling phrases after CSP, which ranks names on them; OMON and VCA carry the same words, so a search finds all four.
    keywords: ["osa", "options", "scenario", "payoff", "strategy", "greeks", "hedge", "hedging", "collar", "protective put", "put spread",
      "cash secured put", "csp", "put selling", "sell put", "short put", "wheel"],
    shortcut: "OSA", publicShare: true,
    settings: (symbol, _context, options) => ({ symbol, ...Object.fromEntries(scenarioSettingKeys
      .filter((key) => options?.values?.[key] != null).map((key) => [key, options!.values![key]])) }),
  })],
};
