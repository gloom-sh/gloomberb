import type { DebtHistoryPoint } from "../../../api-client/debt-maturities";
import type { SeriesDefinition } from "../../../series/types";
import { cachedSeriesNote } from "../shared/series-warning";
import { loadDebtMaturities } from "./client";

type HistoryField = "totalPrincipal" | "next12MonthsShare" | "next3YearsShare";

const FIELDS: ReadonlyArray<{ id: string; field: HistoryField; name: string; unit: string; tags: readonly string[]; description: string }> = [
  { id: "total-principal", field: "totalPrincipal", name: "Debt principal total", unit: "USD", tags: ["principal", "total debt"],
    description: "The principal the company reports maturing, all years summed, at each annual filing, as DDIS charts it." },
  { id: "due-12m-share", field: "next12MonthsShare", name: "Debt due in the next 12 months", unit: "%", tags: ["near-term maturities", "refinancing"],
    description: "Share of reported debt principal maturing within a year of each annual filing, as DDIS charts it." },
  { id: "due-3y-share", field: "next3YearsShare", name: "Debt due in the next 3 years", unit: "%", tags: ["near-term maturities", "refinancing"],
    description: "Share of reported debt principal maturing within three years of each annual filing, as DDIS charts it." },
];

/**
 * A company's maturity wall across its annual filings, as DDIS reads it: the
 * principal it reports and how much of it falls due soon. The wall itself is
 * a schedule by year and stays in the pane.
 */
export const DEBT_MATURITY_SERIES: readonly SeriesDefinition[] = FIELDS.map(({ id, field, name, unit, tags, description }): SeriesDefinition => ({
  id: `debt-maturities:${id}`,
  name,
  unit,
  frequency: "annual",
  group: "Credit",
  tags: ["debt maturities", "maturity wall", "DDIS", ...tags],
  description,
  publisher: "SEC",
  input: "ticker",
  style: "step",
  load: async ({ ticker }) => {
    const resource = await loadDebtMaturities(ticker!);
    if (!resource.payload.history.length) throw new Error(`No maturity schedule reported for ${ticker}.`);
    // An amount stays in the unit it is listed in: a filing in another currency is a gap, not a converted figure.
    const listed = (point: DebtHistoryPoint) => unit !== "USD" || point.currency === "USD";
    const other = resource.payload.history.find((point) => !listed(point))?.currency;
    return {
      points: resource.payload.history.map((point) => ({ date: point.asOf, value: listed(point) ? point[field] : null })),
      ...cachedSeriesNote(resource),
      ...(other ? { warning: `Filings reported in ${other} are left out.` } : {}),
    };
  },
}));
