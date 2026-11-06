import type { CloudFredObservationPayload, CloudFredSeriesPayload } from "../api-client/types/econ";
import type { PriceWindow } from "../utils/price-window";

/**
 * A book's return after its currency's consumer prices (`portfolio show
 * --from <date> --real`): the nominal return deflated by the change in the
 * CPI over the period, (1 + nominal) / (1 + inflation) - 1.
 */

/** Where a currency's consumer prices are read: an index level, or the published changes chained into one. */
export interface CpiSource {
  currency: string;
  /** The series Gloom Cloud serves at `/cloud/econ/series/:id`: the level, or the change from the month before. */
  series: string;
  /** The change from a year before, read for whole years so a twelve-month period is the published figure. */
  yearSeries?: string;
  kind: "level" | "changes";
  /** "US CPI": what the report names. */
  label: string;
  publisher: string;
}

export const CPI_SOURCES: Readonly<Record<string, CpiSource>> = {
  USD: { currency: "USD", series: "CPIAUCSL", kind: "level", label: "US CPI", publisher: "BLS" },
  // The central bank's table gives TurkStat's changes on the index, not its level: whole years are the
  // year-on-year change TurkStat computes from the level, the months left over its monthly changes.
  TRY: { currency: "TRY", series: "TURCPIMOM", yearSeries: "TURCPIYOY", kind: "changes", label: "Türkiye CPI", publisher: "TurkStat" },
};

/** One published CPI value the figure was read from, as the source gives it. */
interface CpiReading {
  series: string;
  /** YYYY-MM. */
  month: string;
  value: number;
}

export interface PeriodInflation {
  source: CpiSource;
  /** YYYY-MM: the month whose CPI starts the period, the last one out at its start. */
  fromMonth: string;
  /** YYYY-MM: the month whose CPI ends it, the last one out at its end or the latest published. */
  toMonth: string;
  /** The CPI's change between them, as a fraction: 0.2977 for 29.77%. */
  inflation: number;
  /** The end's own month is not published yet, so the latest is used. */
  latestPublished: boolean;
  /** The published values it was computed from: the two levels, or the changes chained. */
  readings: CpiReading[];
}

/** YYYY-MM of the month before the one `day` (YYYY-MM-DD) falls in. */
function monthBefore(day: string): string {
  const [year, month] = day.slice(0, 7).split("-").map(Number) as [number, number];
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
const indexMonth = (index: number) => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;

function publishedMonths(observations: readonly CloudFredObservationPayload[]) {
  return observations
    .filter((row) => row.value != null && Number.isFinite(row.value))
    .map((row) => ({ month: row.date.slice(0, 7), value: row.value! }))
    .sort((left, right) => left.month.localeCompare(right.month));
}

/**
 * The CPI's change over a period, from the month before its start's month (the
 * last CPI out when it starts) to the month before its end's, or the latest
 * month published when that is not out yet. A month with no level (the US
 * skipped October 2025) reads the month before it. Published changes chain
 * from the end back: a year-on-year change for each whole year, then the
 * monthly changes of the months left; a missing change leaves it unpriced.
 * Null when the series does not reach either month.
 */
export function periodInflation(
  source: CpiSource,
  observations: readonly CloudFredObservationPayload[],
  window: PriceWindow,
  yearOnYear: readonly CloudFredObservationPayload[] = [],
): PeriodInflation | null {
  const months = publishedMonths(observations);
  if (!months.length) return null;
  const wantedFrom = monthBefore(window.from);
  const wantedTo = monthBefore(window.to);
  const latest = months.at(-1)!.month;
  const toMonth = wantedTo <= latest ? wantedTo : latest;
  const latestPublished = wantedTo > latest;
  // A series that starts after the period's first month says nothing of the months before it.
  if (wantedFrom < months[0]!.month || toMonth < wantedFrom) return null;
  if (source.kind === "level") {
    const at = (month: string) => months.findLast((row) => row.month <= month);
    const start = at(wantedFrom), end = at(toMonth);
    if (!start || !end || end.month < start.month) return null;
    return {
      source, fromMonth: start.month, toMonth: end.month, inflation: end.value / start.value - 1, latestPublished,
      readings: [start, end].map((row) => ({ series: source.series, ...row })),
    };
  }
  const monthly = new Map(months.map((row) => [row.month, row.value]));
  const yearly = new Map(publishedMonths(yearOnYear).map((row) => [row.month, row.value]));
  const readings: CpiReading[] = [];
  let index = 1;
  let at = monthIndex(toMonth);
  const first = monthIndex(wantedFrom);
  while (at - first >= 12 && source.yearSeries && yearly.has(indexMonth(at))) {
    const value = yearly.get(indexMonth(at))!;
    readings.unshift({ series: source.yearSeries, month: indexMonth(at), value });
    index *= 1 + value / 100;
    at -= 12;
  }
  for (; at > first; at--) {
    const value = monthly.get(indexMonth(at));
    if (value == null) return null;
    readings.unshift({ series: source.series, month: indexMonth(at), value });
    index *= 1 + value / 100;
  }
  return { source, fromMonth: wantedFrom, toMonth, inflation: index - 1, latestPublished, readings };
}

/** How the figure was read, for the report: `the BLS index`, `TurkStat's year-on-year change`. */
export function inflationMethodText(read: Pick<PeriodInflation, "source" | "readings" | "fromMonth" | "toMonth">): string {
  const { source, readings } = read;
  if (read.fromMonth === read.toMonth) return `no ${source.publisher} month published inside the period`;
  if (source.kind === "level") return `the ${source.publisher} index`;
  const years = readings.filter((row) => row.series === source.yearSeries).length;
  const months = readings.length - years;
  const parts = [
    ...(years ? [years === 1 ? "year-on-year change" : `${years} year-on-year changes`] : []),
    ...(months ? [months === 1 ? "monthly change" : `${months} monthly changes`] : []),
  ];
  return `${source.publisher}'s ${parts.join(" and ")}${readings.length > 1 ? " chained" : ""}`;
}

/** The real return, as a fraction, of a nominal one after `inflation`. */
export function realReturn(nominal: number, inflation: number): number {
  return (1 + nominal) / (1 + inflation) - 1;
}

/** `Oct 2025`. */
export function monthText(month: string): string {
  const [year, number] = month.split("-");
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(number) - 1]} ${year}`;
}

/** Reads a currency's CPI over a window, with a year before it for the starting month. */
export async function loadPeriodInflation(
  currency: string,
  window: PriceWindow,
  client: { getCloudFredSeries(id: string, params: { startDate: string; endDate: string; limit: number; sortOrder: "asc" }): Promise<CloudFredSeriesPayload> },
): Promise<PeriodInflation | { error: string }> {
  const source = CPI_SOURCES[currency];
  if (!source) {
    const known = Object.keys(CPI_SOURCES).join(" and ");
    return { error: `--real deflates by the consumer prices of a ${known} portfolio; there is no ${currency} CPI series here.` };
  }
  const startYear = Number(window.from.slice(0, 4)) - 1;
  const params = { startDate: `${startYear}${window.from.slice(4, 7)}-01`, endDate: window.to, limit: 1000, sortOrder: "asc" as const };
  try {
    const [payload, yearly] = await Promise.all([
      client.getCloudFredSeries(source.series, params),
      source.yearSeries ? client.getCloudFredSeries(source.yearSeries, params) : null,
    ]);
    return periodInflation(source, payload.observations, window, yearly?.observations)
      ?? { error: `${source.label} does not cover ${window.from} to ${window.to}.` };
  } catch (error) {
    return { error: `${source.label} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}
