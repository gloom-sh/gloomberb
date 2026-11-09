import type { PluginModule } from "../plugin-module";
import { hongKongMoneyMarketsCache, moneyMarketsCache } from "./client";
import { MONEY_MARKET_TABS } from "./model";
import { moneyMarketsHeadless } from "./headless";
import { MONEY_MARKET_SERIES } from "./series";

export const moneyMarketsModule: PluginModule = {
  series: MONEY_MARKET_SERIES,
  panes: [{ id: "money-markets", name: "Money Markets", icon: "$", get component(): typeof import("./pane").MoneyMarketsPane { const { MoneyMarketsPane } = require("./pane"); return MoneyMarketsPane; },
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 88, height: 28 },
    tableExport: true, headless: moneyMarketsHeadless,
    settings: { title: "Money Markets", fields: [{ key: "tab", label: "View", type: "select",
      options: MONEY_MARKET_TABS.map(({ value, label }) => ({ value, label })) }] } }],
  paneTemplates: [{ id: "money-markets-pane", paneId: "money-markets", label: "Money Markets",
    description: "Funding rates, Treasury bills and Federal Reserve liquidity, and Hong Kong's Exchange Fund Bill yields, with historical context.",
    keywords: ["btmm", "money", "rates", "bills", "sofr", "liquidity", "hibor", "hong kong", "hkd", "exchange fund bills", "efb", "hkma"], shortcut: { prefix: "BTMM" },
    headless: moneyMarketsHeadless }],
  setup(ctx) { moneyMarketsCache.attach(ctx.persistence); hongKongMoneyMarketsCache.attach(ctx.persistence); },
  dispose() { moneyMarketsCache.reset(); hongKongMoneyMarketsCache.reset(); },
};
