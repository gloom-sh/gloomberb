/** EIA weekly petroleum and natural gas storage, as GET /cloud/doe/board serves it. */
export type DoeReport = "petroleum" | "gas";
export type DoeTab = "crude" | "products" | "gas";
/** Thousand barrels, thousand barrels a day, percent, billion cubic feet: as published. */
export type DoeUnit = "kb" | "kbd" | "pct" | "bcf";

interface DoeFiveYear {
  /** Calendar years in the band, oldest first; fewer than five where history is short. */
  years: number[];
  min: number;
  max: number;
  average: number;
  /** The average change into this week over the same years. */
  averageChange: number | null;
  vsAverage: number;
  vsAveragePercent: number | null;
  /** 0 at the five-year low, 100 at the high, beyond either outside the range. */
  position: number | null;
}

interface DoeYearAgo {
  weekEnding: string;
  value: number;
  change: number;
  changePercent: number | null;
}

interface DoeSeasonal {
  /** The calendar year of the latest week. */
  year: number;
  /** Fridays in that year: 52 or 53. */
  weeks: number;
  /** [week of year, value]. */
  current: Array<[number, number]>;
  previous: Array<[number, number]>;
  /** [week, min, average, max] of the band years on that week's day. */
  band: Array<[number, number | null, number | null, number | null]>;
}

export interface DoeSeriesRow {
  id: string;
  key: string;
  report: DoeReport;
  tab: DoeTab;
  label: string;
  unit: DoeUnit;
  weekEnding: string | null;
  value: number | null;
  previousWeekEnding: string | null;
  weekChange: number | null;
  yearAgo: DoeYearAgo | null;
  fiveYear: DoeFiveYear | null;
  /** One plain read worked out from the numbers. */
  read: string | null;
  seasonal: DoeSeasonal | null;
}

export interface DoeReportStatus {
  id: DoeReport;
  weekEnding: string | null;
  releasedAt: string | null;
  releaseHoliday: string | null;
  nextWeekEnding: string | null;
  nextReleaseAt: string | null;
  nextReleaseHoliday: string | null;
}

export interface DoeBoardPayload {
  source: "EIA";
  generatedAt: string;
  status: "available" | "partial" | "unavailable";
  gaps: string[];
  reports: DoeReportStatus[];
  series: DoeSeriesRow[];
}

/** One EIA weekly US retail price series, as GET /cloud/doe/prices serves it. */
interface DoePriceSeries {
  id: string;
  /** The EIA source key, which a report cites. */
  key: string;
  label: string;
  unit: "usd-per-gallon";
  /** [Monday the EIA surveyed, dollars per gallon], oldest first, the last five years. */
  points: Array<[string, number]>;
}

export interface DoePricesPayload {
  source: "EIA";
  generatedAt: string;
  status: "available" | "partial" | "unavailable";
  gaps: string[];
  series: DoePriceSeries[];
}
