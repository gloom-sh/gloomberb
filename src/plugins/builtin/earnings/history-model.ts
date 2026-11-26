import type { EarningsHistoryPayload, EarningsPeriodKind, EarningsTiming } from "../../../api-client/earnings";
import type { StatItem } from "../../../components";
import { scalarPoint } from "../../../components/chart/static/series";
import type { TimeSeriesPoint } from "../../../time-series/types";
import { formatMonthYear } from "../../../utils/datetime-format";
import type { EarningsEvent } from "../../../types/data-provider";
import type { EarningsDateStatus, EarningsEpsBasis, FilingEpsDetails } from "../../../types/financials";
import { displayEarningsEpsBasis, earningsDateStatus, earningsEpsBasis, isProvisionalActual, reportedEpsComparison } from "../shared/earnings-report";
import { resolveReportRows, type ReportRowAdapter } from "../shared/earnings-calendar";
import { addDays, MIN_AVERAGE_REPORTS } from "./board-model";
import { fiscalQuarterOf, fiscalPeriodText, placedPeriod, type FiscalQuarter } from "./fiscal-quarter";
import { datedYear, epsText, fiscalMonth, impliedText, moveSize, shortDate, surprise, TIMING_LABEL, type Surprise } from "./format";

export interface HistoryRow extends FilingEpsDetails {
  key: string;
  date: string;
  timing: EarningsTiming | null;
  expectedTiming: boolean;
  fiscalPeriod: string | null;
  /** The quarter as the company names it (Q3 FY2027), null when its calls do not say. */
  fiscalQuarter: FiscalQuarter | null;
  /** What the figures cover: a quarter, or a listing abroad's half, year or year to date. */
  periodKind: EarningsPeriodKind;
  periodMonths: number;
  /** A half's, year's or year to date's fiscal year (named by the calendar year it ends in) and a half's number; null for a quarter. */
  periodFiscalYear: number | null;
  fiscalHalf: number | null;
  /** ISO currency of every amount on the row, a listing abroad's; null for a US listing's dollars. */
  currency: string | null;
  /** The results announcement the figures were read from, a listing abroad's. */
  filingUrl: string | null;
  upcoming: boolean;
  /** Whether the date is out, announced or projected; null when the source does not say. */
  dateStatus: EarningsDateStatus | null;
  epsEstimate: number | null;
  /** Analysts behind `epsEstimate`. */
  epsAnalysts: number | null;
  epsActual: number | null;
  epsActualSource?: EarningsHistoryPayload["reports"][number]["epsActualSource"];
  /** The actual is the company's press release's, until the calendar's replaces it. */
  provisional: boolean;
  /** Null when the reported figure's basis cannot be determined. */
  epsBasis: EarningsEpsBasis | null;
  /** A listing abroad's filed EPS that is basic: not the statements' diluted figure, so it has no basis and says so. */
  epsDilution: "diluted" | "basic" | null;
  /** N/M against a loss or zero estimate. */
  epsSurprise: Surprise;
  revenueEstimate: number | null;
  revenueActual: number | null;
  /**
   * ISO currency of `revenueActual` when a US listing reports its revenue in
   * another currency (yuan for a company reporting in China); null when it is
   * in dollars, or in the row's own `currency`.
   */
  revenueCurrency: string | null;
  /** The revenue is the press release's, until the statements have the quarter. */
  revenueProvisional: boolean;
  revenueSurprise: Surprise;
  implied: number | null;
  impliedMethod: "quote-mid" | "trade-close" | null;
  impliedExpiry: string | null;
  /** Signed close-to-close move across the report. */
  move: number | null;
  /** The move's size over the implied move: above 1 moved more than priced. */
  moveRatio: number | null;
}

/**
 * A row's period: the quarter as the company names it (Q3 FY27) or by its
 * end month (Sep '26); a listing abroad's half, year or year to date by its
 * fiscal year (H1 FY26, FY25, 9M FY26), or by its months and end month where
 * its year end is not known (6M Jun '26). `short` years fit a table column.
 */
export function periodText(
  row: Pick<HistoryRow, "periodKind" | "periodMonths" | "periodFiscalYear" | "fiscalHalf" | "fiscalQuarter" | "fiscalPeriod">,
  short = true,
): string {
  if (row.periodKind === "quarter") return fiscalPeriodText(row.fiscalPeriod, row.fiscalQuarter, short);
  const year = row.periodFiscalYear == null ? null : `FY${short ? String(row.periodFiscalYear).slice(-2) : row.periodFiscalYear}`;
  if (row.periodKind === "year" && year) return year;
  if (row.periodKind === "half" && year && row.fiscalHalf != null) return `H${row.fiscalHalf} ${year}`;
  return `${row.periodMonths}M ${row.periodKind === "ytd" && year ? year : fiscalMonth(row.fiscalPeriod)}`;
}

/** Past quarters shown, beside the upcoming report. */
const HISTORY_QUARTERS = 12;
const AVERAGE_OVER = 8;

/**
 * A report today stays upcoming until its first close after the report
 * prices a move; a listing abroad's moves are not priced, so it is upcoming
 * until it is out.
 */
const isUpcoming = (row: { date: string; move: number | null; dateStatus?: EarningsDateStatus | null; epsActual?: number | null }, today: string, abroad: boolean) =>
  row.date >= today && row.move == null && (!abroad || (row.dateStatus !== "reported" && row.epsActual == null));

const PERIOD_KINDS: ReadonlySet<string> = new Set<EarningsPeriodKind>(["quarter", "half", "ytd", "year"]);
const PERIOD_MONTHS: Record<EarningsPeriodKind, number | null> = { quarter: 3, half: 6, year: 12, ytd: null };

/** A report's period as the server names it; absent is a quarter, anything unknown cannot be labelled and is null. */
function reportPeriod(report: { periodKind?: unknown; periodMonths?: unknown }): { kind: EarningsPeriodKind; months: number } | null {
  if (report.periodKind == null) return { kind: "quarter", months: 3 };
  if (typeof report.periodKind !== "string" || !PERIOD_KINDS.has(report.periodKind)) return null;
  const kind = report.periodKind as EarningsPeriodKind;
  const months = PERIOD_MONTHS[kind] ?? (typeof report.periodMonths === "number" && Number.isInteger(report.periodMonths) ? report.periodMonths : null);
  return months && months > 0 && months <= 12 ? { kind, months } : null;
}

const isoCurrency = (value: unknown) => (typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null);

/**
 * A US listing's revenue: its dollar figure, else the one it reports in its
 * own currency, labelled with that currency. Never the second read as the first.
 */
function listedRevenue(report: { revenueActual: number | null; revenueActualSource?: unknown; reportedRevenue?: unknown }) {
  if (report.revenueActual != null) {
    return { amount: report.revenueActual, currency: null, provisional: report.revenueActualSource === "press-release" };
  }
  const reported = report.reportedRevenue;
  if (!reported || typeof reported !== "object") return null;
  const { amount, currency, source } = reported as { amount?: unknown; currency?: unknown; source?: unknown };
  const code = isoCurrency(currency);
  if (typeof amount !== "number" || !Number.isFinite(amount) || !code || code === "USD") return null;
  return { amount, currency: code, provisional: source === "press-release" };
}
const wholeOrNull = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? value : null);

/** ERN's rows as the shared calendar resolver reads and rebuilds them. */
const historyAdapter = (today: string, abroad: boolean): ReportRowAdapter<HistoryRow> => ({
  slot: (row) => ({ date: row.date, dateStatus: row.dateStatus, epsActual: row.epsActual }),
  reported: (row, epsActual, report) => {
    // A listing abroad's row takes the calendar's figure only as a quarter's, in the currency its own figures are in.
    const fits = !abroad || (row.periodKind === "quarter" && row.currency != null && report?.currency === row.currency);
    if (row.epsActual != null || epsActual == null || !fits) return { ...row, dateStatus: "reported" };
    return { ...row, dateStatus: "reported", epsActual, epsBasis: null, epsActualSource: undefined, epsDilution: null, provisional: false, epsSurprise: null };
  },
  fromCalendar(report, row) {
    // A listing abroad's consensus goes with its date only in the currency its figures are in: an unlabelled figure would read as dollars.
    // The calendar's figures are a quarter's: a half's or a year's row keeps its own.
    const currency = abroad ? row?.currency ?? report.currency : null;
    const quarter = !row || row.periodKind === "quarter";
    const inCurrency = !abroad || (report.currency != null && report.currency === currency);
    const estimate = report.epsEstimate != null && quarter && inCurrency;
    const epsEstimate = estimate ? report.epsEstimate : row?.epsEstimate ?? null;
    const estimateBasis = estimate ? report.epsBasis ?? (epsEstimate === row?.epsEstimate ? row?.epsBasis : null) : row?.epsBasis;
    const calendarActual = quarter && inCurrency ? report.epsActual : null;
    const epsActual = calendarActual ?? row?.epsActual ?? null;
    const move = row?.move ?? null;
    const dateStatus = report.dateStatus;
    const revenueEstimate = quarter && (!abroad || (report.revenueCurrency != null && report.revenueCurrency === currency)) ? report.revenueEstimate : null;
    return {
      key: report.date,
      date: report.date,
      // The calendar's pre-market and after-hours are New York's, not a listing abroad's session.
      timing: (abroad ? null : report.timing) ?? row?.timing ?? null,
      expectedTiming: (abroad || report.timing == null) && !!row?.expectedTiming,
      fiscalPeriod: row?.fiscalPeriod ?? report.fiscalPeriod,
      fiscalQuarter: row?.fiscalQuarter ?? null,
      periodKind: row?.periodKind ?? "quarter",
      periodMonths: row?.periodMonths ?? 3,
      periodFiscalYear: row?.periodFiscalYear ?? null,
      fiscalHalf: row?.fiscalHalf ?? null,
      currency,
      filingUrl: row?.filingUrl ?? null,
      upcoming: isUpcoming({ date: report.date, move, dateStatus, epsActual }, today, abroad),
      dateStatus,
      epsEstimate,
      epsAnalysts: estimate ? report.epsAnalysts : row?.epsAnalysts ?? null,
      epsActual,
      ...(calendarActual == null ? { epsActualSource: row?.epsActualSource } : {}),
      provisional: calendarActual == null && (row?.provisional ?? false),
      epsBasis: calendarActual != null ? null : epsActual == null ? estimateBasis ?? null : row?.epsBasis ?? null,
      epsDilution: calendarActual == null ? row?.epsDilution ?? null : null,
      epsSurprise: calendarActual == null && !estimate ? row?.epsSurprise ?? null : null,
      revenueEstimate: revenueEstimate ?? row?.revenueEstimate ?? null,
      revenueActual: row?.revenueActual ?? null,
      revenueCurrency: row?.revenueCurrency ?? null,
      revenueProvisional: row?.revenueProvisional ?? false,
      revenueSurprise: row?.revenueSurprise ?? null,
      implied: row?.implied ?? null,
      impliedMethod: row?.impliedMethod ?? null,
      impliedExpiry: row?.impliedExpiry ?? null,
      move,
      moveRatio: row?.moveRatio ?? null,
    };
  },
});

/**
 * Newest first, the upcoming report leading. The calendar's next report is
 * resolved against the history as every earnings surface resolves it
 * (shared/earnings-calendar): a confirmed date beats a projected one, a date
 * gone by is reported, and a date past the stored calendar's horizon is added.
 */
export function historyRows(
  payload: EarningsHistoryPayload | null,
  today: string,
  upcoming: EarningsEvent | null,
  /** A listing abroad (Hong Kong's): every amount is labelled with its currency, and no move is priced. */
  options: { abroad?: boolean } = {},
): HistoryRow[] {
  const abroad = options.abroad === true;
  const recorded: HistoryRow[] = (payload?.reports ?? []).flatMap((report) => {
    const period = reportPeriod(report);
    // A listing abroad's amount with no currency could be any: it is not shown. A row with no amount (a report's
    // day and announcement, its next date from the exchange) needs none.
    const currency = abroad ? isoCurrency(report.currency) : null;
    const amounts = [report.epsEstimate, report.epsActual, report.revenueEstimate, report.revenueActual].some((value) => value != null);
    if (!period || (abroad && !currency && amounts)) return [];
    const move = report.realized?.move ?? null;
    const implied = report.implied?.move ?? null;
    const dateStatus = earningsDateStatus(report.dateStatus);
    const quarter = period.kind === "quarter";
    // A listing abroad's amounts are all in the row's currency; a US listing's revenue may be in the company's own.
    const revenue = abroad
      ? { amount: report.revenueActual, currency: null, provisional: report.revenueActual != null && report.revenueActualSource === "press-release" }
      : listedRevenue(report);
    return [{
      // A listing abroad's half and quarter can share a day.
      key: quarter ? report.date : `${report.date}:${period.kind}`,
      date: report.date,
      timing: report.timing,
      expectedTiming: report.timingSource === "history",
      fiscalPeriod: report.fiscalPeriod,
      fiscalQuarter: quarter && report.fiscalYear != null && report.fiscalQuarter != null
        ? { fiscalYear: report.fiscalYear, fiscalQuarter: report.fiscalQuarter } : null,
      periodKind: period.kind,
      periodMonths: period.months,
      periodFiscalYear: quarter ? null : wholeOrNull(report.fiscalYear),
      fiscalHalf: period.kind === "half" ? wholeOrNull(report.fiscalHalf) : null,
      currency,
      filingUrl: abroad && typeof report.filing?.url === "string" ? report.filing.url : null,
      upcoming: isUpcoming({ date: report.date, move, dateStatus, epsActual: report.epsActual }, today, abroad),
      dateStatus,
      epsEstimate: report.epsEstimate,
      epsAnalysts: report.epsAnalysts,
      epsActual: report.epsActual,
      epsActualSource: report.epsActualSource,
      provisional: isProvisionalActual(report),
      epsBasis: displayEarningsEpsBasis(report),
      ...(report.streetEps ? { streetEps: report.streetEps, gaapEps: report.gaapEps } : {}),
      epsDilution: abroad && report.epsDilution === "basic" ? "basic" : null,
      epsSurprise: reportedEpsComparison(report)?.surprise ?? null,
      revenueEstimate: report.revenueEstimate,
      revenueActual: revenue?.amount ?? null,
      revenueCurrency: revenue?.currency ?? null,
      revenueProvisional: revenue?.provisional ?? false,
      // A dollar consensus measures no figure in another currency.
      revenueSurprise: revenue?.currency ? null : surprise(revenue?.amount ?? null, report.revenueEstimate),
      implied,
      impliedMethod: report.implied?.method ?? null,
      impliedExpiry: report.implied?.expiry ?? null,
      move,
      moveRatio: move != null && implied ? Math.abs(move) / implied : null,
    }];
  });
  const anchor = payload?.fiscalAnchor ?? null;
  const basis = earningsEpsBasis(payload?.consensusBasis);
  const rows = resolveReportRows(recorded, upcoming, today, historyAdapter(today, abroad))
    // The calendar's next report past the stored horizon is on the basis the company's reports were measured on.
    .map((row) => (basis && row.upcoming && row.epsActual == null && row.epsEstimate != null && row.epsBasis == null ? { ...row, epsBasis: basis } : row))
    .map((row) => withFiscalQuarter(row, anchor))
    .sort((left, right) => right.date.localeCompare(left.date));
  const upcomingRows = rows.filter((row) => row.upcoming).slice(-1);
  return [...upcomingRows, ...rows.filter((row) => !row.upcoming).slice(0, HISTORY_QUARTERS)];
}

/**
 * A row with the quarter the company names it, on the calendar its calls
 * give: the calendar's next report, past the stored horizon, has none of its
 * own, and one with no quarter-end month either is placed as Gloom Cloud
 * places its own (the last on the company's cycle 5 to 100 days before it).
 */
function withFiscalQuarter(row: HistoryRow, anchor: EarningsHistoryPayload["fiscalAnchor"]): HistoryRow {
  // A half's or year's end month is no quarter's: H1 is not Q2.
  if (row.fiscalQuarter || !anchor || row.periodKind !== "quarter") return row;
  const fiscalPeriod = row.fiscalPeriod ?? (row.upcoming ? placedPeriod(row.date, anchor) : null);
  const fiscalQuarter = fiscalQuarterOf(fiscalPeriod, anchor);
  return fiscalQuarter ? { ...row, fiscalPeriod, fiscalQuarter } : row;
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function daysUntil(date: string, today: string): string {
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}

/** Most important first: the chart-table layout drops figures from the end. */
export function historyFigures(rows: readonly HistoryRow[], today: string, selected?: HistoryRow | null): StatItem[] {
  if (selected?.epsBasis === "company-adjusted" && selected.streetEps) {
    return [
      { id: "filed", label: "Company EPS", value: epsText(selected.epsActual), detail: "non-GAAP diluted" },
      { id: "gaap", label: "GAAP diluted", value: epsText(selected.gaapEps) },
      { id: "street", label: "Street actual", value: epsText(selected.streetEps.actual), detail: "includes stock comp" },
      { id: "street-estimate", label: "Street estimate", value: epsText(selected.streetEps.estimate), detail: "basis unconfirmed" },
    ];
  }
  const next = rows.find((row) => row.upcoming);
  const past = rows.filter((row) => !row.upcoming).slice(0, AVERAGE_OVER);
  const moves = past.flatMap((row) => (row.move == null ? [] : [Math.abs(row.move)]));
  const implied = past.flatMap((row) => (row.implied == null ? [] : [row.implied]));
  const beats = past.filter((row) => row.epsSurprise != null && row.epsActual != null && row.epsEstimate != null);
  const figures: StatItem[] = [];
  if (next) {
    const estimate = next.epsEstimate == null ? null : `EPS est ${epsText(next.epsEstimate)}${next.currency ? ` ${next.currency}` : ""}`;
    figures.push({
      id: "next",
      label: "Next report",
      value: `${shortDate(next.date)}${next.timing ? ` ${TIMING_LABEL[next.timing]}` : ""}`,
      detail: [estimate, next.dateStatus === "reported" ? null : next.dateStatus, daysUntil(next.date, today)].filter(Boolean).join(", "),
      ...(estimate ? { detailVariants: [estimate] } : {}),
    });
    if (next.implied != null) {
      figures.push({
        id: "implied",
        label: "Implied",
        value: impliedText(next.implied),
        detail: next.impliedExpiry ? `${shortDate(next.impliedExpiry)} expiry` : undefined,
      });
    }
  }
  if (moves.length >= MIN_AVERAGE_REPORTS) {
    figures.push({ id: "average", label: "Avg move", value: moveSize(mean(moves)), detail: `last ${moves.length}` });
  }
  if (implied.length >= MIN_AVERAGE_REPORTS) {
    figures.push({ id: "average-implied", label: "Avg implied", value: impliedText(mean(implied)), detail: `last ${implied.length}` });
  }
  if (beats.length >= MIN_AVERAGE_REPORTS) {
    figures.push({
      id: "beats",
      label: "EPS beats",
      // A beat is an actual above the estimate, a loss narrower than expected too (its surprise N/M).
      value: `${beats.filter((row) => row.epsActual! > row.epsEstimate!).length} of ${beats.length}`,
    });
  }
  return figures;
}

/** Oldest first, the order the bars read. */
export function chartRows(rows: readonly HistoryRow[]): HistoryRow[] {
  return rows.filter((row) => row.implied != null || row.move != null).toReversed();
}

/**
 * One slot per report, with an empty slot at each end so the outer bars sit
 * inside the plot. The moves are sizes: the table carries their direction.
 */
export function chartPoints(bars: readonly HistoryRow[], value: (row: HistoryRow) => number | null): TimeSeriesPoint[] {
  if (!bars.length) return [];
  const pad = (date: string, days: number) => scalarPoint(new Date(`${addDays(date, days)}T00:00:00Z`), null);
  return [
    pad(bars[0]!.date, -1),
    ...bars.map((row) => {
      const point = value(row);
      return scalarPoint(new Date(`${row.date}T00:00:00Z`), point == null ? null : point * 100);
    }),
    pad(bars.at(-1)!.date, 1),
  ];
}

/**
 * Each report's month and year under its bar ("Aug '24"); reports fall in any
 * month, so calendar ticks would miss them. Built from the report's ISO date,
 * not cut from a formatted day: "29 Oct" cut for its month read "29 24". Where
 * the bars are too close for every label, the axis drops ticks rather than run
 * them together.
 */
export function chartAxis(bars: readonly HistoryRow[]) {
  const slots = bars.length + 1;
  return {
    ticks: bars.map((row, index) => ({ label: formatMonthYear(row.date), ratio: (index + 1) / slots })),
    formatCursor: (ratio: number) => {
      const row = bars[Math.max(0, Math.min(bars.length - 1, Math.round(ratio * slots) - 1))];
      return row ? datedYear(row.date) : "";
    },
  };
}
