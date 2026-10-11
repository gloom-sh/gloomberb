import type { PowerPriceRow } from "../../../api-client/europe-energy";
import type { SeriesDefinition } from "../../../series/types";
import { fetchCarbonHistory, fetchPowerPriceHistory } from "./prices-client";

/**
 * The markets the server serves day-ahead prices for, by ISO 3166 alpha-2
 * code, known before the board loads so the data catalog can list them. Great
 * Britain is its own market; Northern Ireland trades with Ireland.
 */
export const POWER_PRICE_MARKETS = [
  { code: "AL", name: "Albania" }, { code: "AT", name: "Austria" }, { code: "BE", name: "Belgium" },
  { code: "BG", name: "Bulgaria" }, { code: "HR", name: "Croatia" }, { code: "CZ", name: "Czechia" },
  { code: "DK", name: "Denmark" }, { code: "EE", name: "Estonia" }, { code: "FI", name: "Finland" },
  { code: "FR", name: "France" }, { code: "DE", name: "Germany" }, { code: "GB", name: "Great Britain" },
  { code: "GR", name: "Greece" }, { code: "HU", name: "Hungary" }, { code: "IE", name: "Ireland" },
  { code: "IT", name: "Italy" }, { code: "LV", name: "Latvia" }, { code: "LT", name: "Lithuania" },
  { code: "LU", name: "Luxembourg" }, { code: "ME", name: "Montenegro" }, { code: "NL", name: "Netherlands" },
  { code: "MK", name: "North Macedonia" }, { code: "NO", name: "Norway" }, { code: "PL", name: "Poland" },
  { code: "PT", name: "Portugal" }, { code: "RO", name: "Romania" }, { code: "RS", name: "Serbia" },
  { code: "SK", name: "Slovakia" }, { code: "SI", name: "Slovenia" }, { code: "ES", name: "Spain" },
  { code: "SE", name: "Sweden" }, { code: "CH", name: "Switzerland" },
] as const;

export type PowerPriceMarket = (typeof POWER_PRICE_MARKETS)[number];

/** Words a market goes by besides its name and code. */
const ALIASES: Readonly<Record<string, string>> = {
  UK: "GB", "UNITED KINGDOM": "GB", BRITAIN: "GB", ENGLAND: "GB", GBR: "GB",
  DEU: "DE", FRA: "FR", NLD: "NL", BEL: "BE", ESP: "ES", ITA: "IT", AUT: "AT", CHE: "CH", POL: "PL", IRL: "IE",
  "CZECH REPUBLIC": "CZ", HOLLAND: "NL",
};

/** A typed market: its code (DE), alpha-3 code (DEU), name (germany) or a common alias (UK). */
export function powerPriceMarket(input: string | null | undefined): PowerPriceMarket | null {
  const key = input?.trim().toUpperCase().replace(/\s+/g, " ") ?? "";
  if (!key) return null;
  const code = ALIASES[key] ?? key;
  return POWER_PRICE_MARKETS.find((market) => market.code === code || market.name.toUpperCase() === key) ?? null;
}

export const CARBON_PRICE_UNIT = "EUR/tCO2";
/** The Prices tab's selection when the band charts the carbon allowance instead of a market. */
export const CARBON_SELECTION = "EUA";
/** What `EPWR EUA` (or carbon, EU ETS, CO2) asks for: the carbon allowance instead of a market. */
const CARBON_WORDS = new Set(["EUA", "EUAS", "CARBON", "EU CARBON", "EU ETS", "ETS", "CO2", "EU ALLOWANCE", "EU ALLOWANCES"]);
export const isCarbonQuery = (input: string | null | undefined) =>
  CARBON_WORDS.has(input?.trim().toUpperCase().replace(/[-\s]+/g, " ") ?? "");

/** Germany is the benchmark market a trader reads first. */
export const DEFAULT_PRICE_MARKET = "DE";

export const POWER_PRICE_UNIT = "EUR/MWh";
export const formatPowerPrice = (value: number | null | undefined) => value == null ? "--" : value.toFixed(2);
export const formatPowerChange = (value: number | null | undefined) =>
  value == null ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
/** Where the latest price sits in its 52-week range, 0 at the low and 100 at the high. */
export function powerRangePosition(row: PowerPriceRow): number | null {
  if (row.price == null || row.low52w == null || row.high52w == null || row.high52w <= row.low52w) return null;
  return Math.round(((row.price - row.low52w) / (row.high52w - row.low52w)) * 100);
}
const DAY_AHEAD_PAGE_URL = "https://ember-energy.org/data/european-wholesale-electricity-price-data/";

/** The benchmark markets a search lists first; the rest follow by name. */
const LEAD_MARKETS = ["DE", "FR", "GB", "NL", "BE", "IT", "ES"];
const leadRank = (code: string) => (LEAD_MARKETS.indexOf(code) + LEAD_MARKETS.length + 1) % (LEAD_MARKETS.length + 1);

/** Each market's daily day-ahead price, as `CAP:day-ahead:de`. */
export const DAY_AHEAD_SERIES: readonly SeriesDefinition[] = [...POWER_PRICE_MARKETS].sort((left, right) =>
  leadRank(left.code) - leadRank(right.code)).map((market): SeriesDefinition => ({
  id: `day-ahead:${market.code.toLowerCase()}`,
  name: `${market.name} day-ahead power price`,
  unit: POWER_PRICE_UNIT,
  frequency: "daily",
  group: "Energy",
  tags: ["electricity", "power price", "day-ahead", "wholesale", "Europe", market.code, ...(market.code === "GB" ? ["UK"] : [])],
  description: `Daily average of the ${market.name} day-ahead auction price, weighted by load, in euros per MWh.`,
  publisher: "Ember",
  url: DAY_AHEAD_PAGE_URL,
  load: async ({ start }) => {
    const history = await fetchPowerPriceHistory(market.code, start?.toISOString().slice(0, 10));
    return history.points;
  },
}));

/**
 * The EU carbon allowance price, as `CAP:carbon:eua`: each business day's
 * primary auction clearing price, volume-weighted across that day's auctions.
 */
export const CARBON_SERIES: readonly SeriesDefinition[] = [{
  id: "carbon:eua",
  name: "EU carbon allowance (EUA) auction price",
  unit: CARBON_PRICE_UNIT,
  frequency: "daily",
  group: "Energy",
  tags: ["carbon", "EU carbon", "EUA", "EU ETS", "carbon price", "carbon allowance", "emission allowances", "emissions", "CO2", "Europe"],
  description: "Clearing price of each business day's EU ETS primary auctions of general allowances, volume-weighted, in euros per tonne of CO2. An auction price, not a futures settlement.",
  publisher: "EEX",
  url: "https://www.eex.com/en/markets/environmental-markets/emissions-auctions",
  load: async ({ start }) => {
    const history = await fetchCarbonHistory(start?.toISOString().slice(0, 10));
    return history.points;
  },
}];
