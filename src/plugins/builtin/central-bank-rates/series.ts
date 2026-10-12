import type { SeriesDefinition } from "../../../series/types";
import { CENTRAL_BANKS, centralBankNames } from "../../../utils/central-banks";
import { cachedSeriesWarning } from "../shared/series-warning";
import { loadCentralBankRates } from "./client";

/**
 * The board rows the endpoint reads from FRED (the Fed's and the ECB's rates,
 * `source: "fred"` on the row); every other row is the BIS central bank policy
 * rates (`source: "bis"`). Check a new bank against `fn CBR --json`.
 */
const FRED_ROWS: ReadonlySet<string> = new Set(["US", "EA"]);

/** One policy rate per bank on the board; a search finds it by any of the bank's names ("SNB", "Norges Bank"). */
export const CENTRAL_BANK_SERIES: readonly SeriesDefinition[] = CENTRAL_BANKS.map((bank) => ({
  id: `policy-rate:${bank.id.toLowerCase()}`,
  name: `${bank.place} policy rate (${bank.instrument})`,
  unit: "%",
  frequency: "daily",
  group: "Rates",
  publisher: FRED_ROWS.has(bank.id) ? "FRED" : "BIS",
  tags: ["central bank", "policy rate", bank.id, ...centralBankNames(bank)],
  load: async () => {
    const resource = await loadCentralBankRates();
    const row = resource.payload.rows.find((entry) => entry.id === bank.id);
    if (!row) throw new Error(`${bank.place} is not on the board right now.`);
    const warning = cachedSeriesWarning(resource);
    return {
      points: row.history.map((point) => ({ date: point.date, value: point.value })),
      ...(warning ? { warning } : {}),
    };
  },
}));
