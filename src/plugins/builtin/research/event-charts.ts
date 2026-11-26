import type { DividendAction } from "../../../types/financials";
import { INCOMPLETE_DISTRIBUTIONS } from "../../../market-data/fund-actions";
import { publishedDividend } from "../../../market-data/price-adjustments";
import { MISSING_VALUE } from "../../../utils/format";
import { EPS_BASIS_UNCONFIRMED, epsBasisShort, NO_CONSENSUS, quarterLabel, type EpsBasisName } from "../shared/earnings-report";
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
  withoutConsensus?: true;
  eps?: number;
  estimate?: number;
  surprisePercent?: number;
  surpriseNotMeaningful?: boolean;
  revenue?: number;
  revenueEstimate?: number;
  epsCurrency?: string;
  revenueCurrency?: string;
  /**
   * What the row says that its figures do not (earningsQuarters): a reported
   * one's basis where it is not the table's (quartersEpsBasis), a provisional
   * figure, no consensus on record, a period end standing for its report; one
   * to come, its date's status, time and analysts. The beat in EPS is the
   * quarter's detail's, beside its estimate and actual.
   */
  detail: string;
  /** The reported figure's basis, or an estimate's where Gloom Cloud labels it. */
  basis?: EpsBasisName;
}

/** How a basis reads in a heading or a detail: `ADJ`, `GAAP`; unknown as a phrase, since "?" reads as no figure. */
const basisText = (basis: EpsBasisName) => basis === "unknown" ? "basis unknown" : epsBasisShort(basis === "GAAP" ? "gaap" : "adjusted");

/**
 * The basis the reported quarters' EPS are on, which the EPS column's heading
 * names once (`ADJ EPS`): the one most of them share, null when none is known
 * or two tie. A quarter on another says its own in DETAIL.
 */
export function quartersEpsBasis(quarters: readonly Pick<EarningsQuarter, "upcoming" | "basis">[]): Exclude<EpsBasisName, "unknown"> | null {
  const counts = new Map<EpsBasisName, number>();
  for (const quarter of quarters) if (!quarter.upcoming && quarter.basis) counts.set(quarter.basis, (counts.get(quarter.basis) ?? 0) + 1);
  const [first, second] = [...counts].sort((left, right) => right[1] - left[1]);
  if (!first || first[0] === "unknown" || (second && second[1] === first[1])) return null;
  return first[0];
}

/** The EPS heading with the basis it names: `ADJ EPS`, `GAAP EPS`. */
export const epsHeading = (basis: EpsBasisName | null, label = "EPS") => basis ? `${basisText(basis).toUpperCase()} ${label}` : label;

/** A quarter's DETAIL once the table's basis is known: its own basis only where it differs. */
function quarterDetail(quarter: EarningsQuarter, row: EventRow | undefined, basis: EpsBasisName | null): string {
  if (quarter.upcoming) {
    // A report to come keeps its date's status, time and analysts; an estimate on the table's basis says nothing more.
    const own = quarter.basis && quarter.basis !== basis ? basisText(quarter.basis) : null;
    const parts = quarter.detail.split(", ").filter((part) => !quarter.basis || part !== basisText(quarter.basis));
    return [...parts, ...(own ? [own] : [])].join(", ") || "Pending";
  }
  const parts = [
    row?.epsComparisonUnconfirmed ? EPS_BASIS_UNCONFIRMED : null,
    quarter.basis && quarter.basis !== basis && (basis || quarter.basis !== "unknown") ? basisText(quarter.basis) : null,
    row?.epsProvisional ? "provisional" : null,
    quarter.withoutConsensus ? NO_CONSENSUS : null,
  ].filter((part): part is string => !!part).join(", ");
  return row?.dateType === "fiscal-period-end" ? ["Period end", parts].filter(Boolean).join("; ") : parts;
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
        ...(row.epsActual != null && row.epsEstimate == null && row.epsDifference == null && row.surprisePercent == null && !row.surpriseNotMeaningful
          ? { withoutConsensus: true } : {}),
        ...(row.epsActual != null ? { eps: row.epsActual } : {}),
        ...(row.epsEstimate != null ? { estimate: row.epsEstimate } : {}),
        ...(row.surprisePercent != null ? { surprisePercent: row.surprisePercent } : {}),
        ...(row.surpriseNotMeaningful ? { surpriseNotMeaningful: true } : {}),
        ...(row.qRevenue != null ? { revenue: row.qRevenue } : {}),
        ...(row.epsCurrency ? { epsCurrency: row.epsCurrency } : {}),
        ...(row.revenueCurrency ? { revenueCurrency: row.revenueCurrency } : {}),
        ...(row.epsBasis ? { basis: row.epsBasis } : {}),
        detail: row.detail,
      };
    });
  const { report, quarter } = nextReportOf(rows, today);
  const latest = reported[0]?.date ?? "";
  const ahead = report ?? (quarter && quarter.date > latest ? quarter : undefined);
  const withDetails = (quarters: EarningsQuarter[]) => {
    const basis = quartersEpsBasis(quarters);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return quarters.map((entry) => ({ ...entry, detail: quarterDetail(entry, byId.get(entry.rowId), basis) }));
  };
  if (!ahead) return withDetails(reported);
  // Named as the reported rows under it are: `Q4 FY2026`, else the month it ends in.
  const period = report && report.period !== MISSING_VALUE ? report.period : quarter ? quarterName(quarter).replace(/ qtr$/, "") : MISSING_VALUE;
  const estimate = report?.epsEstimate ?? quarter?.qEps;
  const next: EarningsQuarter = {
    id: `next:${ahead.id}`, rowId: ahead.id, date: ahead.date, period, axisLabel: axisLabel(period, quarter?.date ?? ahead.date), upcoming: true,
    ...(estimate != null ? { estimate } : {}),
    ...(quarter?.qRevenue != null ? { revenueEstimate: quarter.qRevenue } : {}),
    ...((report?.epsEstimate != null ? report.epsCurrency : quarter?.epsCurrency) ? { epsCurrency: (report?.epsEstimate != null ? report.epsCurrency : quarter?.epsCurrency)! } : {}),
    ...(quarter?.revenueCurrency ? { revenueCurrency: quarter.revenueCurrency } : {}),
    ...(report?.epsBasis ? { basis: report.epsBasis } : {}),
    detail: report ? report.detail : "not dated yet",
  };
  return withDetails([next, ...reported]);
}

/** One calendar year of paid dividends, by ex-date. */
export interface DividendYear {
  id: string;
  /** The year, or the last of a run of years with no payment. */
  year: number;
  /** The first year of a run with no payment, when the run is longer than one. */
  fromYear?: number;
  /**
   * The known amount paid in the year; null when no payment is recorded, and for a year whose amounts are on
   * different bases (`mixedBasis`), which no sum states.
   */
  total: number | null;
  /** What the issuer's own forms mark special, where they say. */
  special: number;
  payments: number;
  /** The year is not over: what is paid so far. */
  partial: boolean;
  coverageIncomplete?: true;
  splitOnly?: true;
  /** Against the year before, as a fraction, when both are whole years with payments on the same basis. */
  change?: number;
  /**
   * The year's amounts are on more than one basis (CTVA's $0.027007 adjusted for the VYLR spin-off beside $0.18 as
   * its forms published it before that): not summed.
   */
  mixedBasis?: true;
  /** Every amount in the year is as published before a split or adjustment after it, not on today's shares. */
  published?: true;
  /**
   * The splits and price adjustments that went ex in the year, as said (`4-for-1 split`, `VYLR spin-off`,
   * `1253:1000 factor`): the history's amounts before them are adjusted for them, a published one is not.
   */
  splits: string[];
}

/** A split or price adjustment on record, by the day it went ex, as a year names it (`4-for-1 split`). */
export interface SplitMark {
  date: string;
  terms: string;
}

/**
 * What an amount is stated on: the history's own amounts on today's shares
 * (""), adjusted for every split and adjustment after them; one its issuer or
 * sponsor published as it was paid, on the shares before each of those after
 * it (their dates). Two amounts on one basis sum and compare; others do not.
 */
function amountBasis(dividend: DividendAction, marks: readonly SplitMark[]): string {
  if (!publishedDividend(dividend)) return "";
  return marks.filter((mark) => mark.date > dividend.exDate.slice(0, 10)).map((mark) => mark.date).join(",");
}

/**
 * The paid history summed by calendar year of ex-date, newest first, from
 * the first payment on. Years without one stay in as a gap, a run of them as
 * one entry (AAPL's 1996-2011), so the paying years keep the room; a year a
 * split or price adjustment went ex in is its own entry, to say so. Amounts are
 * as the history states them, on today's shares, or as published: a year is
 * summed, and compared with the year before, only on one basis.
 */
export function dividendYears(dividends: readonly DividendAction[], today: string, splits: readonly SplitMark[] = [], coverage?: "available" | "unavailable", { includeSplitOnly = false } = {}): DividendYear[] {
  const byYear = new Map<number, { total: number; special: number; payments: number; bases: Set<string> }>();
  for (const dividend of dividends) {
    if (!Number.isFinite(dividend.amount)) continue;
    const year = Number(dividend.exDate.slice(0, 4));
    const entry = byYear.get(year) ?? { total: 0, special: 0, payments: 0, bases: new Set<string>() };
    entry.total += dividend.amount;
    entry.special += (dividend.parts ?? []).filter((part) => part.special).reduce((sum, part) => sum + part.amount, 0);
    entry.payments += 1;
    entry.bases.add(amountBasis(dividend, splits));
    byYear.set(year, entry);
  }
  const basisOf = (entry: { bases: Set<string> } | undefined) => (entry?.bases.size === 1 ? [...entry.bases][0]! : null);
  if (!byYear.size && !includeSplitOnly) return [];
  const years = [...byYear.keys()];
  const first = Math.min(...years);
  const last = Math.max(...years);
  const splitsIn = new Map<number, string[]>();
  for (const split of [...splits].sort((left, right) => left.date.localeCompare(right.date))) {
    const year = Number(split.date.slice(0, 4));
    if (includeSplitOnly || (year >= first && year <= last)) splitsIn.set(year, [...(splitsIn.get(year) ?? []), split.terms]);
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
        ...(coverage === "unavailable" ? { coverageIncomplete: true } : {}),
      });
      year = from;
      continue;
    }
    const before = byYear.get(year - 1);
    const partial = year >= thisYear;
    const basis = basisOf(entry);
    if (basis == null) {
      result.push({ id: String(year), year, total: null, special: 0, payments: entry.payments, partial, mixedBasis: true, splits: yearSplits });
      continue;
    }
    const comparable = before && before.total > 0 && !partial && basisOf(before) === basis;
    result.push({
      id: String(year), year, total: entry.total, special: entry.special, payments: entry.payments, partial, splits: yearSplits,
      ...(basis ? { published: true as const } : {}),
      ...(comparable ? { change: entry.total / before.total - 1 } : {}),
    });
  }
  if (!includeSplitOnly) return result;
  for (const [year, terms] of splitsIn) {
    if (year >= first && year <= last) continue;
    result.push({
      id: String(year), year, total: null, special: 0, payments: 0, partial: year >= thisYear, splits: terms, splitOnly: true,
      ...(coverage === "unavailable" ? { coverageIncomplete: true } : {}),
    });
  }
  return result.sort((left, right) => right.year - left.year);
}

/** What a year's row says beside its figures: no payment, amounts not summed, paid so far, a special, as published, a split. */
export function dividendYearDetail(year: DividendYear): string {
  const paid = year.mixedBasis ? `${year.payments} payments on different bases, not summed`
    : year.total == null
      ? year.coverageIncomplete ? INCOMPLETE_DISTRIBUTIONS
        : year.fromYear != null ? `no dividend for ${year.year - year.fromYear + 1} years` : "no dividend"
      : year.partial ? "so far" : year.special > 0 ? "incl. special" : null;
  // The marks are said in full already (`4-for-1 split`, `VYLR spin-off`); a year with only a split leads with it.
  return (year.splitOnly ? [...year.splits, paid] : [paid, year.published ? "as published" : null, ...year.splits]).filter(Boolean).join(" · ");
}

/**
 * The splits and price adjustments among an event list's rows, as the Dividends view marks them. A price adjustment's
 * mark says the amounts before it are adjusted only as far as the paid rows before it say so (their adjustedFor): all
 * of them, or some where others stand as published. A date alone says nothing of an amount's basis.
 */
export function splitMarks(rows: readonly EventRow[]): SplitMark[] {
  const adjustedBefore = (date: string) => {
    const paid = rows.filter((row) => row.status === "Dividend" && !row.declared && row.date < date);
    const adjusted = paid.filter((row) => row.adjustedFor).length;
    return adjusted === 0 ? "" : adjusted === paid.length ? ", amounts before it adjusted" : ", some amounts before it adjusted";
  };
  return rows.flatMap((row) => {
    if (row.status === "Split") return [{ date: row.date, terms: `${row.detail} split` }];
    const name = row.status === "Spin-off" && row.demerger ? `${row.demerger.successor.symbol} spin-off`
      : row.status === "Factor" ? `${row.value} factor` : null;
    return name ? [{ date: row.date, terms: `${name}${adjustedBefore(row.date)}` }] : [];
  });
}

/** How the year reads in the table and under its bar: `2026 YTD`, `1996-2011`, `2025`. */
export function dividendYearLabel(year: DividendYear): string {
  if (year.fromYear != null) return `${year.fromYear}-${year.year}`;
  return year.partial ? `${year.year} YTD` : String(year.year);
}

/** The calendar years from the first payment to the last, gaps included: a year paid on different bases is paid. */
export function dividendYearSpan(years: readonly DividendYear[]): number {
  const newest = years.find((year) => year.payments > 0);
  const oldest = years.findLast((year) => year.payments > 0);
  return newest && oldest ? newest.year - oldest.year + 1 : 0;
}
