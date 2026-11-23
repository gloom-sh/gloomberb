import type { PluginModule } from "../plugin-module";
import { fredSeriesArgument } from "../../../series/fred-argument";
import { parseTickerListInput } from "../../../tickers/list";
import { buildTickerSurfaceInstanceId, createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { macroReleaseCache } from "./client";
import { MAX_MACRO_DAY_SYMBOLS } from "./comparison";
import { macroDayHeadless } from "./headless";
import { LOOKBACK_OPTIONS, MacroDayPane } from "./pane";

const singleTemplate = createTickerSurfacePaneTemplate({
    id: "macro-day-pane", paneId: "macro-day", label: "Macro-Day Reaction",
    description: `Compare up to ${MAX_MACRO_DAY_SYMBOLS} tickers or FRED series side by side on CPI, jobs and central-bank release days, close to close. With one ticker, see how those moves compare to a normal day.`,
    keywords: ["mday", "macro day", "cpi day", "fomc day", "jobs day", "jobs report", "nfp", "payrolls", "nonfarm", "event study", "release reaction", "ipca",
      "hot cpi", "cpi surprise", "release surprise"],
    shortcut: "MDAY", publicShare: true,
});

export const macroDayModule: PluginModule = {
  panes: [{
    id: "macro-day", name: "Macro-Day Reaction", icon: "M", component: MacroDayPane,
    defaultPosition: "right", shareItem: { ticker: true }, tickerFollower: (pane) => !pane.params?.symbols,
    defaultMode: "floating", defaultFloatingSize: { width: 76, height: 26 },
    tableExport: true,
    settings: { title: "Macro-Day Reaction Settings", fields: [
      { key: "lookbackYears", label: "Lookback", type: "select", options: LOOKBACK_OPTIONS },
    ] },
  }],
  paneTemplates: [{
    ...singleTemplate,
    shortcut: { prefix: "MDAY", argKind: "ticker-list", argPlaceholder: "tickers", openWithoutArg: true,
      keepArgToken: (token) => !!fredSeriesArgument(token) },
    canCreate: (context, options) => !!(options?.symbols?.length || options?.arg?.trim() || options?.symbol || context.activeTicker),
    createInstance: (context, options) => {
      const input = options?.symbols?.length ? options.symbols.join(",") : options?.arg || options?.symbol || context.activeTicker;
      if (!input) return null;
      const symbols = parseTickerListInput(input, MAX_MACRO_DAY_SYMBOLS);
      if (symbols.length === 1 && !fredSeriesArgument(symbols[0]!)) {
        return singleTemplate.createInstance?.(context, { ...options, symbol: symbols[0] }) ?? null;
      }
      const list = symbols.join(",");
      return { instanceId: buildTickerSurfaceInstanceId("macro-day", list), title: `MDAY ${symbols.join(", ")}`,
        binding: { kind: "none" }, placement: "floating", params: { symbols: list } };
    },
    headless: macroDayHeadless,
  }],
  setup(ctx) { macroReleaseCache.attach(ctx.persistence); },
  dispose() { macroReleaseCache.reset(); },
};
