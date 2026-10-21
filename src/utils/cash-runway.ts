import type { FinancialStatement } from "../types/financials";
import { formatNumber } from "./format";
import { latestFinancialPeriod } from "./latest-financial-period";

/**
 * Months of cash: cash and short-term investments at the latest balance sheet
 * over the cash the operations used per month. One computation behind
 * `ticker`, the Overview and FA's Liquidity tab.
 *
 * The burn is operating cash flow, the line a 10-Q reports for the quarter:
 * a quarter's over 3 months, the trailing year's over 12. Both are given
 * because a quarter swings for a company paid in lumps (a collaboration's
 * upfront payment one quarter, none the next), and the year smooths that.
 * Positive operating cash flow is no burn. Capital expenditure and financing
 * are left out: a raise is cash in, not less burn.
 */

export const QUARTER_MONTHS = 3;
export const YEAR_MONTHS = 12;

/** The method, as the reports state it under the figures; cash alone when no short-term investments are reported. */
export function runwayMethod(includesShortTerm = true): string {
  const cash = includesShortTerm ? "cash + ST investments" : "cash (no ST investments reported)";
  return `Runway: ${cash} over operating cash burn per month (the quarter's operating cash flow ÷ 3, the trailing year's ÷ 12).`;
}

const DAY_MS = 86_400_000;
/** A fiscal year ending within this many days of a quarter is that quarter's trailing year, as FA reads it. */
const SAME_PERIOD_END_DAYS = 7;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export interface RunwayLiquidity {
  amount: number;
  /** False when the filer reports no total with short-term investments and the amount is cash alone. */
  includesShortTerm: boolean;
}

/**
 * Cash, cash equivalents and short-term investments as reported; cash alone
 * when the filer does not report the total. FA's Cash + ST Inv reads the same.
 */
export function cashAndShortTermInvestments(statement: FinancialStatement): RunwayLiquidity | null {
  if (finite(statement.cashCashEquivalentsAndShortTermInvestments)) {
    return { amount: statement.cashCashEquivalentsAndShortTermInvestments, includesShortTerm: true };
  }
  return finite(statement.cashAndCashEquivalents) ? { amount: statement.cashAndCashEquivalents, includesShortTerm: false } : null;
}

/** Cash used by operations per month over a period of `months`, or "no-burn" when they brought cash in. */
export function monthlyOperatingBurn(operatingCashFlow: number | undefined, months: number): number | "no-burn" | undefined {
  if (!finite(operatingCashFlow)) return undefined;
  return operatingCashFlow >= 0 ? "no-burn" : -operatingCashFlow / months;
}

/** Months the cash lasts at a monthly burn above zero; none left is zero months. */
export function runwayMonths(liquidity: number, monthlyBurn: number): number {
  return Math.max(0, liquidity) / monthlyBurn;
}

export type RunwayEstimate =
  | { kind: "months"; months: number; monthlyBurn: number; operatingCashFlow: number }
  | { kind: "no-burn"; operatingCashFlow: number };

function estimate(liquidity: number, operatingCashFlow: number | undefined, months: number): RunwayEstimate | null {
  const burn = monthlyOperatingBurn(operatingCashFlow, months);
  if (burn === undefined) return null;
  return burn === "no-burn"
    ? { kind: "no-burn", operatingCashFlow: operatingCashFlow! }
    : { kind: "months", months: runwayMonths(liquidity, burn), monthlyBurn: burn, operatingCashFlow: operatingCashFlow! };
}

const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY_MS;

/**
 * Operating cash flow over the year to a quarter, as FA's quarterly columns
 * read a trailing flow: the fiscal year when one ends with the quarter,
 * otherwise the four consecutive quarters to it summed. Null when neither is
 * on file, or a quarter of the four has no figure.
 */
export function trailingOperatingCashFlow(
  quarter: FinancialStatement,
  quarterlyStatements: readonly FinancialStatement[],
  annualStatements: readonly FinancialStatement[],
): number | null {
  const year = annualStatements.find((candidate) => (
    Math.abs(days(quarter.date, candidate.date)) <= SAME_PERIOD_END_DAYS
    && (!candidate.currency || !quarter.currency || candidate.currency === quarter.currency)
  ));
  if (year) return finite(year.operatingCashFlow) ? year.operatingCashFlow : null;
  const sorted = [...quarterlyStatements].sort((a, b) => a.date.localeCompare(b.date));
  const index = sorted.findIndex((statement) => statement.date === quarter.date);
  if (index < 3) return null;
  const four = sorted.slice(index - 3, index + 1);
  // Four rows need not cover twelve months: a skipped quarter or a half-year report is not a year.
  for (let at = 1; at < four.length; at += 1) {
    const gap = days(four[at - 1]!.date, four[at]!.date);
    if (!Number.isFinite(gap) || gap < 60 || gap > 120) return null;
  }
  if (new Set(four.map((statement) => statement.currency)).size > 1) return null;
  const flows = four.map((statement) => statement.operatingCashFlow);
  return flows.every(finite) ? flows.reduce((sum, value) => sum + value, 0) : null;
}

export interface CashRunway {
  /** The balance sheet's date: the latest quarter's end. */
  periodEnd: string;
  currency?: string;
  liquidity: number;
  includesShortTerm: boolean;
  /** At the latest quarter's burn. */
  quarter: RunwayEstimate | null;
  /** At the trailing year's burn. */
  trailing: RunwayEstimate | null;
}

/**
 * Runway at the latest quarter's balance sheet. Null without a quarter, its
 * cash, or any operating cash flow to measure a burn by.
 */
export function cashRunway({ quarterlyStatements, annualStatements }: {
  quarterlyStatements: readonly FinancialStatement[];
  annualStatements: readonly FinancialStatement[];
}): CashRunway | null {
  const quarter = latestFinancialPeriod(quarterlyStatements, (row) => row.date);
  if (!quarter) return null;
  const liquidity = cashAndShortTermInvestments(quarter);
  if (!liquidity) return null;
  const quarterly = estimate(liquidity.amount, quarter.operatingCashFlow, QUARTER_MONTHS);
  const trailing = estimate(liquidity.amount, trailingOperatingCashFlow(quarter, quarterlyStatements, annualStatements) ?? undefined, YEAR_MONTHS);
  if (!quarterly && !trailing) return null;
  return {
    periodEnd: quarter.date,
    ...(quarter.currency ? { currency: quarter.currency } : {}),
    liquidity: liquidity.amount,
    includesShortTerm: liquidity.includesShortTerm,
    quarter: quarterly,
    trailing,
  };
}

/** "12.0 months", to the tenth FA's runway rows show. */
export function formatRunwayMonths(months: number, unit = "months"): string {
  return `${formatNumber(months, 1)} ${unit}`;
}

/** Whether either burn measure finds the company using cash. */
export function burnsCash(runway: CashRunway | null | undefined): runway is CashRunway {
  return runway?.quarter?.kind === "months" || runway?.trailing?.kind === "months";
}

/** A prospectus for an offering that raises cash: a shelf takedown (424B5) or an underwritten offering (424B4). */
const OFFERING_FORMS = ["424B5", "424B4"] as const;

export interface OfferingFiling {
  form: string;
  /** YYYY-MM-DD */
  filed: string;
  /** Two prospectuses on one day are two offerings (shares and convertible notes). */
  accessionNumber?: string;
}

/**
 * Offering prospectuses filed after a balance sheet's date, oldest first:
 * cash the balance sheet, and a runway on it, do not include yet.
 */
export function offeringsAfter(filings: readonly OfferingFiling[], periodEnd: string): OfferingFiling[] {
  return filings
    .map((filing) => ({ ...filing, form: filing.form.trim().toUpperCase().replace(/\/A$/, ""), filed: filing.filed.slice(0, 10) }))
    .filter((filing) => (OFFERING_FORMS as readonly string[]).includes(filing.form) && filing.filed > periodEnd)
    .sort((a, b) => a.filed.localeCompare(b.filed));
}

const MAX_NOTED_DATES = 3;

/** "424B5 offering filed 2026-09-23 and 2026-09-25, after the 2026-06-30 balance sheet; cash and runway predate it." */
export function offeringNote(offerings: readonly OfferingFiling[], periodEnd: string): string | null {
  if (offerings.length === 0) return null;
  const forms = [...new Set(offerings.map((filing) => filing.form))].join("/");
  const dates = [...new Set(offerings.map((filing) => filing.filed))].slice(-MAX_NOTED_DATES);
  const when = dates.length === 1 ? dates[0] : `${dates.slice(0, -1).join(", ")} and ${dates.at(-1)}`;
  return `${forms} offering filed ${when}, after the ${periodEnd} balance sheet; cash and runway predate it.`;
}

interface OfferingFilingsClient {
  getCloudSecFilings(params: { ticker: string; forms?: readonly string[]; limit?: number }, options?: { signal?: AbortSignal }): Promise<{
    filings: Array<{ form: string; filingDate: string; accessionNumber?: string }>;
  }>;
}

const OFFERING_FILING_LIMIT = 10;

/** A US company's latest offering prospectuses, newest first. */
export async function fetchOfferingFilings(client: OfferingFilingsClient, ticker: string, signal?: AbortSignal): Promise<OfferingFiling[]> {
  const { filings } = await client.getCloudSecFilings({ ticker, forms: OFFERING_FORMS, limit: OFFERING_FILING_LIMIT }, signal ? { signal } : undefined);
  // A server that predates the form filter sends every form: offeringsAfter keeps the offerings.
  return filings.flatMap((filing) => /^\d{4}-\d{2}-\d{2}/.test(filing.filingDate)
    ? [{ form: filing.form, filed: filing.filingDate.slice(0, 10), ...filing.accessionNumber ? { accessionNumber: filing.accessionNumber } : {} }]
    : []);
}
