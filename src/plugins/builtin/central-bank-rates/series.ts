import type { CentralBankRow } from "../../../api-client/central-bank-rates";
import type { SeriesDefinition } from "../../../series/types";
import { CENTRAL_BANKS, centralBankNames } from "../../../utils/central-banks";
import { cachedSeriesNote } from "../shared/series-warning";
import { loadCentralBankRates } from "./client";
import { policySeriesAttribution } from "./model";

/**
 * The board rows the endpoint reads from FRED (the Fed's and the ECB's rates,
 * `source: "fred"` on the row); every other row is the BIS central bank policy
 * rates (`source: "bis"`). Check a new bank against `fn CBR --json`.
 */
const FRED_ROWS: ReadonlySet<string> = new Set(["US", "EA"]);

/**
 * A policy rate's observations, carried to the day the bank's own site last
 * showed the same level when that is later: a rate holds until the bank
 * changes it, and BIS publishes its observations days late. Japan's 1.25%
 * stopped at BIS's 10 Nov 2026 while the BoJ's site showed it on the 19th,
 * with no decision between. A rate that may have changed since (a decision
 * BIS has not reported, `stale`) stops at its last observation.
 */
export function policyRatePoints(row: Pick<CentralBankRow, "history" | "status" | "value" | "confirmedAt">): Array<{ date: string; value: number | null }> {
  const points = row.history.map((point) => ({ date: point.date, value: point.value }));
  const confirmed = row.confirmedAt?.slice(0, 10);
  const last = points.findLast((point) => point.value != null);
  if (row.status !== "available" || row.value == null || !confirmed || !last || last.value !== row.value || confirmed <= points.at(-1)!.date) return points;
  return [...points, { date: confirmed, value: row.value }];
}

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
    // Cited as CBR cites the row: the BIS or FRED series and the bank that sets the rate.
    const attribution = policySeriesAttribution(row);
    return {
      points: policyRatePoints(row),
      ...cachedSeriesNote(resource),
      ...(attribution ? { attribution } : {}),
    };
  },
}));
