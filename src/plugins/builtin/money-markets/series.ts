import type { MoneyMarketObservation } from "../../../api-client/money-markets";
import type { SeriesDefinition } from "../../../series/types";
import { cachedSeriesNote } from "../shared/series-warning";
import { loadMoneyMarkets } from "./client";

function observations(history: readonly MoneyMarketObservation[]) {
  return history.map((point) => ({ date: point.date, value: point.value }));
}

/**
 * The two money-market lines the pane computes: the rates and balances under
 * them are FRED series in the catalog already.
 */
export const MONEY_MARKET_SERIES: readonly SeriesDefinition[] = [
  {
    id: "money-markets:net-liquidity",
    name: "Net liquidity (Fed assets less TGA and reverse repo)",
    unit: "billion USD",
    frequency: "weekly",
    group: "Rates",
    tags: ["liquidity", "Fed balance sheet", "TGA", "RRP", "money markets"],
    load: async () => {
      const resource = await loadMoneyMarkets();
      return { points: observations(resource.payload.netLiquidity.history), ...cachedSeriesNote(resource) };
    },
  },
  {
    id: "money-markets:bill-slope",
    name: "Treasury bill curve slope (1Y less 4W)",
    unit: "bp",
    frequency: "daily",
    group: "Rates",
    tags: ["bills", "curve", "money markets"],
    load: async () => {
      const resource = await loadMoneyMarkets();
      return { points: observations(resource.payload.billsCurve.slope.history), ...cachedSeriesNote(resource) };
    },
  },
];
