import type { FinancialStatement, Quote, TickerFinancials } from "../types/financials";
import type { HeadlessPaneFreshness, HeadlessPaneRow } from "../types/headless";
import { deriveHeadlessFreshness, type ReportFreshness } from "./pane-functions/freshness";
import { fxPairObservation, fxRateObservations, type FxRateTiming } from "../plugins/builtin/shared/fx-rate-freshness";
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
function quoteFreshnessRow(quote: Quote, now: number): HeadlessPaneRow {
  return { ...quoteFreshnessFields(quote, now), updatedAt: quote.lastUpdated };
}

/**
 * Worst of across the quotes shown, dated by the newest, with their delay and
 * where their markets stand. Quotes that failed to load say nothing.
 */
export function quotesFreshness(
  quotes: Iterable<Quote | null | undefined>,
  declared?: HeadlessPaneFreshness,
  now = Date.now(),
): ReportFreshness | undefined {
  const rows = [...quotes].filter((quote): quote is Quote => quote != null).map((quote) => quoteFreshnessRow(quote, now));
  return rows.length > 0 ? rowsFreshness(rows, declared, undefined, now) : undefined;
}

/**
 * A currency pair crossed from the loaded USD rates of its legs, dated as the
 * FX matrix dates its rates (`fn FXC`): as old as its oldest dated leg, as
 * held back as its most delayed, stale when any leg is, and read against the
 * FX week. A pair with no loaded leg (a code priced in itself) cites nothing.
 */
export function fxPairFreshness(
  legs: ReadonlyMap<string, { rate: number; timing: FxRateTiming }>,
  now = Date.now(),
): ReportFreshness | undefined {
  const rates = new Map([...legs].map(([currency, leg]) => [currency, leg.rate] as const));
  const observation = fxPairObservation(fxRateObservations([...legs.keys()], rates, (currency) => ({ entry: legs.get(currency)?.timing }), now));
  return observation ? rowsFreshness([observation], undefined, undefined, now) : undefined;
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
