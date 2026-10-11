import type { SeriesDefinition } from "../../../series/types";
import { fetchAwards } from "./client";

/** The scope AWARDS calls "US federal contracts": one source, one currency and prime awards, so no total counts a contract twice. */
const US_FEDERAL = { source: "usaspending", currency: "USD", awardType: "prime" } as const;

/**
 * A company's US federal contract obligations by month, as AWARDS charts its
 * company history. Pro: the free preview is one shared view, not the
 * company's history, so it fails with the pane's own words.
 */
export const AWARD_SERIES: readonly SeriesDefinition[] = [{
  id: "awards:us-federal-obligations",
  name: "US federal contract obligations",
  unit: "USD",
  frequency: "monthly",
  group: "Alternative data",
  tags: ["government awards", "contracts", "procurement", "defense", "obligations"],
  description: "Obligated dollars on US federal prime contracts awarded to the company, by award month, as AWARDS charts them. Needs Pro.",
  input: "ticker",
  style: "columns",
  load: async ({ ticker, signal }) => {
    const data = await fetchAwards({ ticker: ticker!, ...US_FEDERAL, limit: 1 }, undefined, signal);
    if (data.locked || data.access === "preview") throw new Error("Full award history requires Pro.");
    const rows = data.history.filter((row) => row.source === US_FEDERAL.source && row.currency === US_FEDERAL.currency && row.awardType === US_FEDERAL.awardType);
    if (!rows.length) throw new Error(`No US federal contracts awarded to ${ticker}.`);
    return rows.map((row) => ({ date: `${row.month.slice(0, 7)}-01`, value: row.obligatedAmount === null ? null : Number(row.obligatedAmount) }));
  },
}];
