import type { SeriesDefinition } from "../../../series/types";
import { cachedSeriesWarning } from "../shared/series-warning";
import { loadCentralBankRates } from "./client";

/** The banks the board charts a policy rate for, by the board's row id. */
const BANKS: ReadonlyArray<readonly [id: string, place: string, instrument: string]> = [
  ["US", "United States", "Fed funds target, midpoint"],
  ["EA", "Euro area", "deposit facility rate"],
  ["JP", "Japan", "call rate target"],
  ["GB", "United Kingdom", "Bank Rate"],
  ["CA", "Canada", "overnight rate target"],
  ["AU", "Australia", "cash rate target"],
  ["CN", "China", "1-year loan prime rate"],
  ["IN", "India", "repo rate"],
  ["ID", "Indonesia", "7-day reverse repo rate"],
  ["KR", "South Korea", "base rate"],
  ["BR", "Brazil", "Selic target"],
  ["MX", "Mexico", "overnight rate target"],
  ["RU", "Russia", "key rate"],
  ["SA", "Saudi Arabia", "repo rate"],
  ["TR", "Turkey", "1-week repo rate"],
  ["ZA", "South Africa", "repo rate"],
];

export const CENTRAL_BANK_SERIES: readonly SeriesDefinition[] = BANKS.map(([id, place, instrument]) => ({
  id: `policy-rate:${id.toLowerCase()}`,
  name: `${place} policy rate (${instrument})`,
  unit: "%",
  frequency: "daily",
  group: "Rates",
  tags: ["central bank", "policy rate", id],
  load: async () => {
    const resource = await loadCentralBankRates();
    const row = resource.payload.rows.find((entry) => entry.id === id);
    if (!row) throw new Error(`${place} is not on the board right now.`);
    const warning = cachedSeriesWarning(resource);
    return {
      points: row.history.map((point) => ({ date: point.date, value: point.value })),
      ...(warning ? { warning } : {}),
    };
  },
}));
