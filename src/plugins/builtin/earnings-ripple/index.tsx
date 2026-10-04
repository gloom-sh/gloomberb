import type { PluginModule } from "../plugin-module";
import { formatTickerListInput, parseTickerListInput } from "../../../tickers/list";
import { earningsRippleHeadless } from "./headless";
import { EarningsRipplePane } from "./pane";

function namedSymbols(arg: string | undefined): string[] {
  try { return arg?.trim() ? parseTickerListInput(arg) : []; } catch { return []; }
}

export const earningsRippleModule: PluginModule = {
  panes: [{
    id: "earnings-ripple", name: "Earnings Ripple", icon: "E", component: EarningsRipplePane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 96, height: 20 },
    tableExport: true,
    settings: { title: "Earnings Ripple Settings", fields: [
      { key: "symbols", label: "Holdings", type: "text", placeholder: "Blank for your portfolios and watchlists" },
    ] },
  }],
  paneTemplates: [{
    id: "earnings-ripple-pane", paneId: "earnings-ripple", label: "Earnings Ripple",
    description: "Customers of your holdings that report soon, with the share of each holding's revenue they make up.",
    keywords: ["ripl", "ripple", "earnings", "customers", "supply chain", "exposure", "read-through"],
    shortcut: { prefix: "RIPL", argPlaceholder: "tickers", argKind: "ticker-list", argOptional: true, openWithoutArg: true },
    headless: earningsRippleHeadless,
    canCreate: () => true,
    createInstance: (_context, options) => {
      const symbols = options?.symbols?.length ? options.symbols : namedSymbols(options?.arg);
      return {
        title: symbols.length ? `RIPL ${formatTickerListInput(symbols)}` : "Earnings Ripple",
        placement: "floating",
        settings: symbols.length ? { symbols: formatTickerListInput(symbols) } : undefined,
      };
    },
  }],
};
