import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { ivHistoryHeadless, ivScreenHeadless } from "./headless";
import { IvHistoryPane } from "./pane";
import { IvScreenPane, VCA_SCOPE_OPTIONS } from "./screen-pane";


export const ivHistoryModule: PluginModule = {
  panes: [{
    id: "iv-history", name: "Implied Volatility History", icon: "V", component: IvHistoryPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 118, height: 36 },
    tableExport: true,
    settings: { title: "Implied Volatility History", fields: [
      { key: "lookback", label: "Lookback", type: "select", options: [{ value: "1Y", label: "1 year" }, { value: "2Y", label: "2 years" }, { value: "ALL", label: "All stored" }] },
      { key: "hvWindow", label: "Realized window", type: "select", options: [{ value: "20", label: "20 sessions" }, { value: "30", label: "30 sessions" }] },
    ] },
  }, {
    id: "iv-screen", name: "Volatility Rich/Cheap", icon: "V", component: IvScreenPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 96, height: 32 },
    tableExport: true, headless: ivScreenHeadless,
    settings: { title: "Volatility Rich/Cheap", fields: [
      { key: "scope", label: "Universe", type: "select", options: [...VCA_SCOPE_OPTIONS] },
      { key: "symbols", label: "Custom symbols", type: "text", placeholder: "AAPL, MSFT, SPY" },
    ] },
  }],
  paneTemplates: [
    { ...createTickerSurfacePaneTemplate({
      id: "iv-history-pane", paneId: "iv-history", label: "Implied Volatility History",
      description: "30 and 90-day ATM implied volatility since 2024 against realized, with IV rank and percentile.",
      keywords: ["hivg", "implied", "volatility", "history", "iv rank", "ivr", "percentile", "vrp"], shortcut: "HIVG", publicShare: true,
    }), headless: ivHistoryHeadless },
    {
      id: "iv-screen-pane", paneId: "iv-screen", label: "Volatility Rich/Cheap",
      description: "IV rank, percentile, term slope, skew and IV/HV across a list, ranked rich to cheap.",
      keywords: ["vca", "rich", "cheap", "iv rank", "implied volatility", "screen"],
      shortcut: { prefix: "VCA", argKind: "ticker-list" as const, argOptional: true }, headless: ivScreenHeadless,
      createInstance: (_context, options) => ({
        title: "VCA", placement: "floating" as const,
        settings: options?.symbols?.length ? { scope: "custom", symbols: options.symbols.join(",") } : { scope: "etfs" },
      }),
    },
  ],
};
