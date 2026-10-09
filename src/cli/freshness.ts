import type { FinancialStatement, Quote, TickerFinancials } from "../types/financials";
import type { HeadlessPaneFreshness, HeadlessPaneRow } from "../types/headless";
import { deriveHeadlessFreshness, type ReportFreshness } from "./pane-functions/freshness";
import { quoteFreshnessFields, REPORTED_DATA } from "../plugins/builtin/shared/report-freshness";
import { latestFinancialPeriod } from "../utils/latest-financial-period";

/**
 * The source, as-of and status line of a plain CLI command, derived exactly as
 * an `fn` report derives it: rows read like a headless report's rows (quote
 * `dataSource`, `delayMinutes`, `stale` flags, observation times, worst of
 * across rows) under what the command declares about them. Nothing to cite, no line.
 */
export function rowsFreshness(
  rows: readonly object[],
  declared?: HeadlessPaneFreshness,
  metadata?: Record<string, unknown>,
  now = Date.now(),
): ReportFreshness | undefined {
  if (rows.length === 0 && !metadata && !declared) return undefined;
  return deriveHeadlessFreshness(
    { shape: "rows", freshness: declared },
    { rows: rows as HeadlessPaneRow[], ...(metadata ? { metadata } : {}) },
    now,
  );
}

/** One row per quote shown, as `fn` quote reports carry them: live, delayed or stale for its session. */
function quoteFreshnessRow(quote: Quote): HeadlessPaneRow {
  return { ...quoteFreshnessFields(quote), updatedAt: quote.lastUpdated };
}

/** Worst of across the quotes shown, dated by the newest. Quotes that failed to load say nothing. */
export function quotesFreshness(
  quotes: Iterable<Quote | null | undefined>,
  declared?: HeadlessPaneFreshness,
  now = Date.now(),
): ReportFreshness | undefined {
  const rows = [...quotes].filter((quote): quote is Quote => quote != null).map(quoteFreshnessRow);
  return rows.length > 0 ? rowsFreshness(rows, declared, undefined, now) : undefined;
}

/** The newest reported period end in the statements, the period the trailing figures run through. */
function latestReportedPeriod(financials: Pick<TickerFinancials, "annualStatements" | "quarterlyStatements">): string | null {
  const rows: FinancialStatement[] = [...financials.annualStatements, ...financials.quarterlyStatements];
  return latestFinancialPeriod(rows, (row) => row.date)?.date ?? null;
}

/**
 * Fundamentals and valuation: reported figures, not a feed. Dated by when the
 * statistics block was observed, with the newest statement period they run
 * through named in the status; stale only when the block says so.
 */
export function fundamentalsFreshness(financials: TickerFinancials, now = Date.now()): ReportFreshness {
  const fundamentals = financials.fundamentals;
  const period = latestReportedPeriod(financials);
  return rowsFreshness([], {
    ...REPORTED_DATA,
    basis: period ? `reported through ${period}` : REPORTED_DATA.basis,
    asOf: fundamentals?.fetchedAt ?? null,
  }, { stale: fundamentals?.stale === true }, now)!;
}
