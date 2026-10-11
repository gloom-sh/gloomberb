import type { PluginModule } from "../plugin-module";
import { powerBoardCache, powerDetailCache, powerHistoryCache } from "./client";
import { powerHeadless } from "./headless";
import { PowerPane } from "./pane";
import { powerPriceHistoryCache, powerPricesCache } from "./prices-client";
import { powerPricesHeadless } from "./prices-headless";
import { DAY_AHEAD_SERIES, POWER_PRICE_MARKETS, powerPriceMarket } from "./prices-model";

const CACHES = [powerBoardCache, powerHistoryCache, powerDetailCache, powerPricesCache, powerPriceHistoryCache];

export const powerModule: PluginModule = {
  series: DAY_AHEAD_SERIES,
  panes: [{ id: "power", name: "Power & Grid", icon: "P", component: PowerPane, defaultPosition: "right", defaultMode: "floating",
    defaultFloatingSize: { width: 132, height: 34 }, tableExport: true, headless: powerHeadless }],
  paneTemplates: [{ id: "power-pane", paneId: "power", label: "Power & Grid",
    description: "Pro: interconnection queues, historical MW and outcomes, datacenter loads, utility exposure and generation capacity, with primary evidence.",
    keywords: ["power", "electricity", "interconnection", "grid", "datacenter", "utility", "renewables", "storage", "capacity"],
    shortcut: { prefix: "POWER", argKind: "text", argPlaceholder: "ticker", argOptional: true }, headless: powerHeadless,
    createInstance: (_context, options) => {
      const symbol = options?.symbol ?? options?.arg?.trim().toUpperCase() ?? "";
      return { placement: "floating", params: { symbol }, ...(symbol ? { title: `POWER ${symbol}` } : {}) };
    } }, {
    id: "power-prices-pane", paneId: "power", label: "European Power Prices",
    description: "Day-ahead power prices for 32 European markets, EUR/MWh: the latest delivery day, 7- and 30-day averages, a year ago and the 52-week range, with each market's daily history.",
    keywords: ["day-ahead", "day ahead", "power price", "power prices", "electricity price", "electricity prices", "wholesale power",
      "spot power", "baseload", "europe", "european", "eur/mwh"],
    shortcut: { prefix: "EPWR", argKind: "text", argPlaceholder: "market", argOptional: true,
      argOptions: () => POWER_PRICE_MARKETS.map(({ code, name }) => ({ value: code, label: name })) },
    headless: powerPricesHeadless,
    createInstance: (_context, options) => {
      const input = options?.arg?.trim();
      const market = powerPriceMarket(input);
      if (input && !market) throw new Error("Use a market such as DE, FR, GB or Spain");
      return { placement: "floating", settings: { tab: "prices" }, ...(market ? { params: { market: market.code } } : {}) };
    } }],
  setup(ctx) { for (const cache of CACHES) cache.attach(ctx.persistence); },
  dispose() { for (const cache of CACHES) cache.reset(); },
};
