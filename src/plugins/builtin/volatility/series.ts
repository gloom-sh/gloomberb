import { apiClient } from "../../../api-client";
import type { SeriesAttribution, SeriesDefinition } from "../../../series/types";
import { loadVolatilityTermHistory } from "./client";
import { DVOL_COINS, dvolSeriesId, loadDvol, type DvolCurrency } from "./dvol";
import { IMPLIED_CORRELATION_ROWS, type VolatilityTermHistory } from "./model";
import { VOLATILITY_INDICES } from "../shared/volatility-indices";

/** VIX and VIX 3M come from FRED's daily closes, listed with the other FRED series. */
const FRED_LISTED = new Set(["vix", "vix3m"]);
const CORRELATION = IMPLIED_CORRELATION_ROWS as Readonly<Record<string, string>>;

const BOARD_NAMES: Readonly<Record<string, string>> = {
  vxn: "Nasdaq 100 volatility index",
  rvx: "Russell 2000 volatility index",
  ovx: "Oil volatility index",
  gvz: "Gold volatility index",
  vxeem: "Emerging markets volatility index",
  vxewz: "Brazil volatility index",
  vxapl: "Apple volatility index",
  vxazn: "Amazon volatility index",
  vxgog: "Alphabet volatility index",
  vxgs: "Goldman Sachs volatility index",
  vxibm: "IBM volatility index",
  cor1m: "S&P 500 implied correlation, 1 month",
  cor3m: "S&P 500 implied correlation, 3 months",
};

async function loadImpliedCorrelation(code: string) {
  const { series } = await apiClient.impliedVolatility<{ series: Array<{ id: string; observations: Array<{ date: string; value: number }> }> }>(
    "implied-correlation",
  );
  const match = series.find((entry) => entry.id === code);
  if (!match) throw new Error(`${code} history is unavailable.`);
  return match.observations.filter((row) => Number.isFinite(row.value) && row.value > 0)
    .map((row) => ({ date: row.date, value: row.value }));
}

/**
 * Who a chart of the ratio cites: the publisher of its latest closes and the
 * formula, with FRED named when it fills dates Cboe's closes do not reach.
 */
function termAttribution(term: VolatilityTermHistory): SeriesAttribution | undefined {
  if (!term.publisher) return undefined;
  if (term.publisher === "FRED") return { source: "FRED, VIX 3M / VIX (VXVCLS / VIXCLS)", publisher: "FRED" };
  const filled = term.ratioHistory.some((point) => point.publisher === "FRED");
  return filled ? { source: "Cboe, VIX 3M / VIX (FRED for earlier dates)", publisher: "Cboe, FRED" }
    : { source: "Cboe, VIX 3M / VIX", publisher: "Cboe" };
}

/**
 * Deribit's volatility index for a coin: each UTC day's close, today's
 * latest print last, and refreshed through the day.
 */
function dvolSeries(currency: DvolCurrency): SeriesDefinition {
  const coin = DVOL_COINS[currency];
  return {
    id: dvolSeriesId(currency),
    name: `${coin} volatility index (DVOL)`,
    unit: "index",
    frequency: "daily",
    group: "Volatility",
    tags: ["volatility", "DVOL", "Deribit", "crypto", "implied volatility", currency, `${currency}-USD`, coin.toLowerCase()],
    description: `Deribit's DVOL for ${currency}: the 30-day implied volatility its ${currency} options price, in vol points, daily since March 2021.`,
    url: `https://www.deribit.com/statistics/${currency}/volatility-index`,
    refreshMs: 5 * 60_000,
    load: async ({ signal }) => {
      const payload = await loadDvol(currency, signal ? { signal } : {});
      return { points: payload.observations, attribution: { source: `Deribit DVOL (${currency})`, publisher: "Deribit" } };
    },
  };
}

/** Every index on the curve and the board, by its own close; implied correlation from its daily history. */
export const VOLATILITY_SERIES: readonly SeriesDefinition[] = [
  ...VOLATILITY_INDICES.filter((index) => !FRED_LISTED.has(index.id)).map((index): SeriesDefinition => {
    const name = BOARD_NAMES[index.id] ?? index.label;
    const tags = ["volatility", index.symbol.replace("^", "")];
    const code = CORRELATION[index.id];
    return code
      ? {
        id: `volatility:${index.id}`,
        name,
        unit: "index",
        frequency: "daily",
        group: "Volatility",
        tags: [...tags, "correlation"],
        load: async () => ({ points: await loadImpliedCorrelation(code) }),
      }
      : {
        id: `volatility:${index.id}`,
        name,
        unit: "index",
        frequency: "daily",
        group: "Volatility",
        tags,
        expression: `${index.symbol}:close`,
      };
  }),
  {
    id: "volatility:vix-term-ratio",
    name: "VIX 3M / VIX ratio",
    unit: "ratio",
    frequency: "daily",
    group: "Volatility",
    tags: ["term structure", "contango", "backwardation", "VIX"],
    description: "VIX 3M over VIX on each date both closed, from Cboe's daily closes and FRED's before them; above 1 is contango.",
    load: async ({ start, signal }) => {
      const { term, warning } = await loadVolatilityTermHistory({ ...(start ? { start } : {}), ...(signal ? { signal } : {}) });
      const attribution = termAttribution(term);
      return {
        points: term.ratioHistory.map((point) => ({ date: point.date, value: point.value })),
        ...(warning ? { warning } : {}),
        ...(attribution ? { attribution } : {}),
      };
    },
  },
  dvolSeries("BTC"),
  dvolSeries("ETH"),
];
