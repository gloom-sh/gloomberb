import type { PluginModule } from "../plugin-module";
import { powerBoardCache, powerDetailCache, powerHistoryCache } from "./client";
import { powerHeadless } from "./headless";
import { PowerPane } from "./pane";
import { carbonHistoryCache, carbonPriceCache, powerPriceHistoryCache, powerPricesCache } from "./prices-client";
import { powerPricesHeadless } from "./prices-headless";
import { CARBON_SELECTION, CARBON_SERIES, DAY_AHEAD_SERIES, isCarbonQuery, POWER_PRICE_MARKETS, powerPriceMarket } from "./prices-model";

const CACHES = [powerBoardCache, powerHistoryCache, powerDetailCache, powerPricesCache, powerPriceHistoryCache, carbonPriceCache, carbonHistoryCache];

export const powerModule: PluginModule = {
  series: [...DAY_AHEAD_SERIES, ...CARBON_SERIES],
  // POWER sets the symbol param, EPWR the prices tab.
  panes: [{ id: "power", name: "Power & Grid", icon: "P", component: PowerPane, defaultPosition: "right", defaultMode: "floating", identitySettings: ["tab", "symbol"],
    defaultFloatingSize: { width: 132, height: 34 }, tableExport: true, headless: powerHeadless }],
  paneTemplates: [{ id: "power-pane", paneId: "power", label: "Power & Grid",
    description: "Pro: interconnection queues, historical MW and outcomes, datacenter loads, utility exposure and generation capacity, with primary evidence.",
    keywords: ["power", "electricity", "interconnection", "grid", "datacenter", "utility", "renewables", "storage", "capacity"],
    shortcut: { prefix: "POWER", argKind: "text", argPlaceholder: "ticker", argOptional: true }, headless: powerHeadless,
    createInstance: (_context, options) => {
      const symbol = options?.symbol ?? options?.arg?.trim().toUpperCase() ?? "";
      return { placement: "floating", params: { symbol }, ...(symbol ? { title: `POWER ${symbol}` } : {}) };
    } }, {
    id: "power-prices-pane", paneId: "power", label: "EU Power & Carbon",
    description: "Day-ahead power prices for 32 European markets in EUR/MWh and the EU carbon allowance (EUA) auction price in EUR/tCO2: the latest day, 7- and 30-day averages, a year ago and the 52-week range, with daily history.",
    keywords: ["day-ahead", "day ahead", "power price", "power prices", "electricity price", "electricity prices", "wholesale power",
      "spot power", "baseload", "europe", "european", "eur/mwh", "carbon", "eu carbon", "eua", "eu ets", "carbon price",
      "carbon allowance", "emission allowances", "co2", "eur/tco2"],
    shortcut: { prefix: "EPWR", argKind: "text", argPlaceholder: "market", argOptional: true,
      argOptions: () => [{ value: "EUA", label: "EU carbon allowance" }, ...POWER_PRICE_MARKETS.map(({ code, name }) => ({ value: code, label: name }))] },
    headless: powerPricesHeadless,
    createInstance: (_context, options) => {
      const input = options?.arg?.trim();
      const market = powerPriceMarket(input);
      // EPWR EUA opens the tab with the carbon allowance charted above the board.
      const carbon = isCarbonQuery(input);
      if (input && !market && !carbon) throw new Error("Use a market such as DE, FR, GB or Spain, or EUA");
      return { placement: "floating", settings: { tab: "prices" }, ...(market || carbon ? { params: { market: market?.code ?? CARBON_SELECTION } } : {}) };
    } }],
  setup(ctx) { for (const cache of CACHES) cache.attach(ctx.persistence); },
  dispose() { for (const cache of CACHES) cache.reset(); },
};
