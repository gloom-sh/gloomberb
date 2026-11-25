import type { DividendAction } from "../../../types/financials";
import { MISSING_VALUE } from "../../../utils/format";
import { quarterLabel } from "../shared/earnings-report";
import { nextReportOf, quarterName, type EventRow } from "./event-model";

/** How many reported quarters the Earnings chart and table show; EE and ERN have the older ones. */
const EARNINGS_QUARTERS = 12;

/** One quarter of the Earnings view: a reported one, or the next one with its consensus alone. */
export interface EarningsQuarter {
  id: string;
  /** The event row it is drawn from (the report, or the estimate of a quarter not dated yet): what Enter opens. */
  rowId: string;
  /** The report's day, or for a quarter with no report dated yet, the day it ends. */
  date: string;
  /** As the fiscal calendar names it (`Q3 FY2026`), else by the month it ends in. */
  period: string;
  /** Under its bar: `Q3 FY26`, `Sep '26`. */
  axisLabel: string;
  upcoming: boolean;
  eps?: number;
  estimate?: number;
  surprisePercent?: number;
  surpriseNotMeaningful?: boolean;
  revenue?: number;
  revenueEstimate?: number;
  epsCurrency?: string;
  revenueCurrency?: string;
  /** What the row says beside its figures: the EPS basis and the difference, or the report's date status and time. */
  detail: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function axisLabel(period: string, date: string): string {
  const fiscal = /^Q([1-4]) FY(\d{4})$/.exec(period);
  if (fiscal) return `Q${fiscal[1]} FY${fiscal[2]!.slice(2)}`;
  const month = /^([A-Z][a-z]{2}) (\d{4})$/.exec(period);
  if (month) return `${month[1]} '${month[2]!.slice(2)}`;
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} '${date.slice(2, 4)}`;
}

/** A report comes within this long after the quarter it reports ends (see `docs/research-data.md`, Dates and timing). */
const REPORT_LAG_MS = 100 * 86_400_000;

/**
 * A reported fiscal period end that no report covers: a quarter the feed knows
 * only by its end, which is then its only row. One a reported announcement
 * covers (in its quarter, or within REPORT_LAG_MS after it) is that report's.
 */
function uncoveredPeriodEnd(row: EventRow, announced: readonly EventRow[]): boolean {
  const end = Date.parse(row.providerPeriodDate ?? row.date);
  return !announced.some((report) => (row.period !== MISSING_VALUE && report.period === row.period)
    || (Date.parse(report.date) >= end && Date.parse(report.date) - end <= REPORT_LAG_MS));
}

/**
 * The quarters the Earnings view charts and lists, newest first: the next
 * report with the consensus for the quarter it covers (or, undated, the next
 * quarter analysts estimate), then up to EARNINGS_QUARTERS reported ones with
 * their actual against the estimate. A fiscal period end is no report of its
 * own, unless it is all the feed has of that quarter.
 */
export function earningsQuarters(rows: readonly EventRow[], today: string): EarningsQuarter[] {
  const out = rows.filter((row) => row.status === "Earnings" && row.earningsState === "reported");
  const announced = out.filter((row) => row.dateType !== "fiscal-period-end");
  const reported = out
    .filter((row) => row.dateType !== "fiscal-period-end" || uncoveredPeriodEnd(row, announced))
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, EARNINGS_QUARTERS)
    .map((row): EarningsQuarter => {
      const period = row.period && row.period !== MISSING_VALUE ? row.period : quarterLabel(row.fiscalPeriodEnd ?? row.date);
      return {
        id: row.id, rowId: row.id, date: row.date, period, axisLabel: axisLabel(period, row.fiscalPeriodEnd ?? row.date), upcoming: false,
        ...(row.epsActual != null ? { eps: row.epsActual } : {}),
        ...(row.epsEstimate != null ? { estimate: row.epsEstimate } : {}),
        ...(row.surprisePercent != null ? { surprisePercent: row.surprisePercent } : {}),
        ...(row.surpriseNotMeaningful ? { surpriseNotMeaningful: true } : {}),
        ...(row.qRevenue != null ? { revenue: row.qRevenue } : {}),
        ...(row.epsCurrency ? { epsCurrency: row.epsCurrency } : {}),
        ...(row.revenueCurrency ? { revenueCurrency: row.revenueCurrency } : {}),
        detail: row.detail,
      };
    });
  const { report, quarter } = nextReportOf(rows, today);
  const latest = reported[0]?.date ?? "";
  const ahead = report ?? (quarter && quarter.date > latest ? quarter : undefined);
  if (!ahead) return reported;
  // Named as the reported rows under it are: `Q4 FY2026`, else the month it ends in.
  const period = report && report.period !== MISSING_VALUE ? report.period : quarter ? quarterName(quarter).replace(/ qtr$/, "") : MISSING_VALUE;
  const estimate = report?.epsEstimate ?? quarter?.qEps;
  const next: EarningsQuarter = {
    id: `next:${ahead.id}`, rowId: ahead.id, date: ahead.date, period, axisLabel: axisLabel(period, quarter?.date ?? ahead.date), upcoming: true,
    ...(estimate != null ? { estimate } : {}),
    ...(quarter?.qRevenue != null ? { revenueEstimate: quarter.qRevenue } : {}),
    ...((report?.epsEstimate != null ? report.epsCurrency : quarter?.epsCurrency) ? { epsCurrency: (report?.epsEstimate != null ? report.epsCurrency : quarter?.epsCurrency)! } : {}),
    ...(quarter?.revenueCurrency ? { revenueCurrency: quarter.revenueCurrency } : {}),
    detail: report ? report.detail : "not dated yet",
  };
  return [next, ...reported];
}

/** One calendar year of paid dividends, by ex-date. */
export interface DividendYear {
  id: string;
  /** The year, or the last of a run of years with no payment. */
  year: number;
  /** The first year of a run with no payment, when the run is longer than one. */
  fromYear?: number;
  /** Everything paid in the year; null for years with no payment between two that have one. */
  total: number | null;
  /** What the issuer's own forms mark special, where they say. */
  special: number;
  payments: number;
  /** The year is not over: what is paid so far. */
  partial: boolean;
  /** Against the year before, as a fraction, when both are whole years with payments. */
  change?: number;
  /**
   * The splits and price adjustments that went ex in the year, as said (`4-for-1 split`, `VYLR spin-off`,
   * `1253:1000 factor`): the amounts before them are adjusted for them.
   */
  splits: string[];
}

/** A split or price adjustment on record, by the day it went ex, as a year names it (`4-for-1 split`). */
export interface SplitMark {
  date: string;
  terms: string;
}

/**
 * The paid history summed by calendar year of ex-date, newest first, from
 * the first payment on. Years without one stay in as a gap, a run of them as
 * one entry (AAPL's 1996-2011), so the paying years keep the room; a year a
 * split or price adjustment went ex in is its own entry, to say so. Amounts are
 * on today's shares, as the history states them.
 */
export function dividendYears(dividends: readonly DividendAction[], today: string, splits: readonly SplitMark[] = []): DividendYear[] {
  const byYear = new Map<number, { total: number; special: number; payments: number }>();
  for (const dividend of dividends) {
    if (!Number.isFinite(dividend.amount)) continue;
    const year = Number(dividend.exDate.slice(0, 4));
    const entry = byYear.get(year) ?? { total: 0, special: 0, payments: 0 };
    entry.total += dividend.amount;
    entry.special += (dividend.parts ?? []).filter((part) => part.special).reduce((sum, part) => sum + part.amount, 0);
    entry.payments += 1;
    byYear.set(year, entry);
  }
  if (!byYear.size) return [];
  const years = [...byYear.keys()];
  const first = Math.min(...years);
  const last = Math.max(...years);
  const splitsIn = new Map<number, string[]>();
  for (const split of [...splits].sort((left, right) => left.date.localeCompare(right.date))) {
    const year = Number(split.date.slice(0, 4));
    if (year >= first && year <= last) splitsIn.set(year, [...(splitsIn.get(year) ?? []), split.terms]);
  }
  const thisYear = Number(today.slice(0, 4));
  const result: DividendYear[] = [];
  for (let year = last; year >= first; year -= 1) {
    const entry = byYear.get(year);
    const yearSplits = splitsIn.get(year) ?? [];
    if (!entry) {
      let from = year;
      if (!yearSplits.length) while (from - 1 >= first && !byYear.has(from - 1) && !splitsIn.has(from - 1)) from -= 1;
      result.push({
        id: String(year), year, ...(from < year ? { fromYear: from } : {}), total: null, special: 0, payments: 0, partial: year >= thisYear, splits: yearSplits,
      });
      year = from;
      continue;
    }
    const before = byYear.get(year - 1);
    const partial = year >= thisYear;
    result.push({
      id: String(year), year, total: entry.total, special: entry.special, payments: entry.payments, partial, splits: yearSplits,
      ...(before && before.total > 0 && !partial ? { change: entry.total / before.total - 1 } : {}),
    });
  }
  return result;
}

/** What a year's row says beside its figures: no payment, paid so far, a special, a split. */
export function dividendYearDetail(year: DividendYear): string {
  const paid = year.total == null
    ? year.fromYear != null ? `no dividend for ${year.year - year.fromYear + 1} years` : "no dividend"
    : year.partial ? "so far" : year.special > 0 ? "incl. special" : null;
  return [paid, ...year.splits].filter(Boolean).join(" · ");
}

/**
 * The splits and price adjustments among an event list's rows, as the Dividends view marks them. A price adjustment's
 * mark says the amounts before it are adjusted for it, as they stand in the history.
 */
export function splitMarks(rows: readonly EventRow[]): SplitMark[] {
  return rows.flatMap((row) => {
    if (row.status === "Split") return [{ date: row.date, terms: `${row.detail} split` }];
    if (row.status === "Spin-off" && row.demerger) {
      return [{ date: row.date, terms: `${row.demerger.successor.symbol} spin-off, amounts before it adjusted` }];
    }
    return row.status === "Factor" ? [{ date: row.date, terms: `${row.value} factor, amounts before it adjusted` }] : [];
  });
}

/** How the year reads in the table and under its bar: `2026 YTD`, `1996-2011`, `2025`. */
export function dividendYearLabel(year: DividendYear): string {
  if (year.fromYear != null) return `${year.fromYear}-${year.year}`;
  return year.partial ? `${year.year} YTD` : String(year.year);
}

/** The calendar years from the first payment to the last, gaps included. */
export function dividendYearSpan(years: readonly DividendYear[]): number {
  const newest = years[0];
  const oldest = years.at(-1);
  return newest && oldest ? newest.year - (oldest.fromYear ?? oldest.year) + 1 : 0;
}
