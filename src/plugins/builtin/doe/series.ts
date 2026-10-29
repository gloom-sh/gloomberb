import type { DoeSeriesRow, DoeUnit } from "../../../api-client/doe";
import type { SeriesDefinition, SeriesPoint } from "../../../series/types";
import { cachedSeriesWarning } from "../shared/series-warning";
import { loadDoeBoard } from "./client";
import { DOE_SERIES_OPTIONS } from "./model";
import { DOE_PRICE_SERIES } from "./prices";

/** Stocks in million barrels, as the pane shows them; flows, rates and gas as published. */
const UNITS: Record<DoeUnit, { unit: string; scale: number }> = {
  kb: { unit: "million barrels", scale: 1 / 1_000 },
  kbd: { unit: "thousand barrels/day", scale: 1 },
  pct: { unit: "%", scale: 1 },
  bcf: { unit: "billion cubic feet", scale: 1 },
};
/** Which unit each row reports, so the catalog can say it before the board loads. */
const ROW_UNITS: Readonly<Record<string, DoeUnit>> = {
  "refinery-utilization": "pct",
  "crude-input": "kbd",
  "crude-imports": "kbd",
  "crude-exports": "kbd",
  "product-supplied": "kbd",
};
const DAY_MS = 86_400_000;

/** The board counts weeks by the Fridays of a year, the day the reports' weeks end. */
function weekEnding(year: number, week: number): Date {
  const january1 = Date.UTC(year, 0, 1);
  const firstFriday = january1 + ((5 - new Date(january1).getUTCDay() + 7) % 7) * DAY_MS;
  return new Date(firstFriday + (week - 1) * 7 * DAY_MS);
}

/** This year's and last year's weekly readings, dated: about two years of history. */
function doeRowPoints(row: DoeSeriesRow): SeriesPoint[] {
  const seasonal = row.seasonal;
  if (!seasonal) return [];
  const { scale } = UNITS[row.unit];
  const dated = (year: number, points: Array<[number, number]>) => points.map(([week, value]) => ({
    date: weekEnding(year, week),
    value: value * scale,
  }));
  return [...dated(seasonal.year - 1, seasonal.previous), ...dated(seasonal.year, seasonal.current)];
}

const DOE_SERIES: readonly SeriesDefinition[] = DOE_SERIES_OPTIONS.map((option): SeriesDefinition => {
  const unit = ROW_UNITS[option.value] ?? (option.tab === "gas" ? "bcf" : "kb");
  const gas = option.tab === "gas";
  return {
    id: `doe:${option.value}`,
    name: gas ? `Natural gas storage: ${option.label}` : `${option.label}${unit === "kb" ? " stocks" : ""}`,
    unit: UNITS[unit].unit,
    frequency: "weekly",
    group: "Energy",
    // Jet fuel is kerosene, the word a reader may search it by.
    tags: gas ? ["natural gas", "storage", "inventories"] : ["oil", "petroleum", "inventories", "US", ...option.value === "jet" ? ["kerosene"] : []],
    publisher: "EIA",
    load: async () => {
      const resource = await loadDoeBoard();
      const row = resource.payload.series.find((entry) => entry.id === option.value);
      if (!row) throw new Error(`${option.label} is not in this week's report.`);
      const warning = cachedSeriesWarning(resource);
      return { points: doeRowPoints(row), ...(warning ? { warning } : {}) };
    },
  };
});

export const DOE_CATALOG_SERIES = [...DOE_SERIES, ...DOE_PRICE_SERIES];
