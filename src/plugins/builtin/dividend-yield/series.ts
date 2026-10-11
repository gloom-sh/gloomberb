import type { SeriesDefinition } from "../../../series/types";
import { fetchDividendData } from "./client";
import { buildTrailingCashChartPoints } from "./view";

/** A ticker's trailing twelve months of cash dividends, stepping at each payment, as DVD charts it. */
export const DIVIDEND_SERIES: readonly SeriesDefinition[] = [{
  id: "dividends:ttm-cash",
  name: "Trailing 12-month dividends",
  unit: "currency/share",
  frequency: "irregular",
  group: "Securities",
  tags: ["dividends", "income", "payout", "DVD"],
  input: "ticker",
  style: "step",
  load: async ({ ticker }) => {
    const data = await fetchDividendData(ticker!, null);
    if (data.historyAvailable === false) throw new Error(data.historyError ?? `No dividend history for ${ticker}.`);
    return buildTrailingCashChartPoints(data.payments).map((point) => ({ date: point.date, value: point.close }));
  },
}];
