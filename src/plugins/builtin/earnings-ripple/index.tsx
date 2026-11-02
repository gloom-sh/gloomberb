import type { PluginModule } from "../plugin-module";
import { formatTickerListInput, parseTickerListInput } from "../../../tickers/list";
import { earningsRippleHeadless } from "./headless";

/**
 * The tickers a typed argument names. A list the command bar refuses (more than
 * ten) throws its message rather than opening the pane on the person's holdings.
 * `fn` and `shot` pass their own list as `symbols` and never get here.
 */
function namedSymbols(arg: string | undefined): string[] {
  return arg?.trim() ? parseTickerListInput(arg) : [];
}

export const earningsRippleModule: PluginModule = {
  panes: [{
    id: "earnings-ripple", name: "Earnings Ripple", icon: "E", get component(): typeof import("./pane").EarningsRipplePane { const { EarningsRipplePane } = require("./pane"); return EarningsRipplePane; },
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 96, height: 20 },
    tableExport: true,
    // Without named tickers it lists what is in the person's portfolios.
    personalData: (context) => (typeof context.settings.symbols === "string" && context.settings.symbols.trim() ? null : "holdings"),
    settings: { title: "Earnings Ripple Settings", fields: [
      { key: "symbols", label: "Holdings", type: "text", placeholder: "Blank for your portfolios and watchlists" },
    ] },
  }],
  paneTemplates: [{
    id: "earnings-ripple-pane", paneId: "earnings-ripple", label: "Earnings Ripple",
    description: "Customers and suppliers of your holdings that report soon, with the disclosed revenue share, and with Pro the companies two hops away.",
    keywords: ["ripl", "ripple", "earnings", "customers", "supply chain", "exposure", "read-through", "suppliers", "two hop", "second order"],
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
