// The current point of a valuation series: served, listing-EV and live-quote multiples, and why one is not meaningful.
import type { FinancialStatement, TickerFinancials } from "../../types/financials";
import { canonicalTimeSeriesFieldId } from "../field-catalog";
import { createValuationCurrencyContext, type ValuationCurrencyContext } from "../valuation-currency";
import { currentValuationPrice, valuationQuoteIssue } from "../valuation-price";
import type { SecuritySeriesSource, SeriesPeriod, TimeSeriesPoint } from "../types";
import { isFiniteNumber } from "../../utils/guards";
import { liveForwardPE, liveTrailingPE } from "../../market-data/quotes/live-valuation";
import { listingEnterpriseValue } from "../../market-data/quotes/listing-enterprise-value";
import { BANK_OR_INSURER_EBITDA, isBankOrInsurerIndustry } from "../../utils/ebitda";
import { comparablePriceEarnings } from "../../utils/price-earnings";
import { buildTtmStatements, deriveQuarterlyStatements } from "./quarterly-ttm";
import { sourceStatements, valuationStatements } from "./source-statements";
import { type InternalStatement, validDate } from "./statement";
import { metricAvailability, ratio } from "./statement-fields";
import { hasValuationInputs, valuationAtPrice } from "./valuation-multiples";

export function providerCurrentValuationPoint(
  financials: TickerFinancials,
  metric: string,
): TimeSeriesPoint | null {
  // A forward P/E is measured at the regular session price, as `valuation` reads it; PEG stays as served.
  const value = metric === "forwardPE"
    ? comparablePriceEarnings(liveForwardPE(financials.quote, financials.fundamentals))
    : metric === "pegRatio"
      ? financials.fundamentals?.pegRatio
      : undefined;
  if (!isFiniteNumber(value) || (metric === "forwardPE" && value <= 0)) return null;
  const quoteTime = financials.quote?.lastUpdated;
  const quoteDate = validDate(isFiniteNumber(quoteTime) && quoteTime > 0 ? quoteTime : null);
  if (!quoteDate) return null;
  const date = metric === "forwardPE" ? currentValuationPrice(financials.quote)?.date ?? quoteDate : quoteDate;
  return {
    date,
    observedAt: date,
    availableAt: date,
    value,
    periodLabel: "Current",
    provenance: {
      providerId: financials.quote?.providerId,
      quality: "estimated",
    },
  };
}

/**
 * The trailing P/E `valuation`, DES and the portfolio columns show: the served
 * one at the regular session price, over positive EPS.
 */
function servedTrailingPE(financials: TickerFinancials): number | null {
  return comparablePriceEarnings(liveTrailingPE(financials.quote, financials.fundamentals));
}

/**
 * A current EV multiple over the listing's enterprise value, the one
 * `valuation` and RV show (listingEnterpriseValue): EV/EBITDA and EV/S then
 * read one EV on every surface. A statement in another currency than the EV
 * (an ADR's EUR or TWD statements) is converted at the rate the EV's balance
 * sheet check was, as RV's EV/S converts revenue. Undefined to read the
 * statement's own (shares times the price, plus debt, less cash) where the
 * listing has none or no rate; null where it is not meaningful.
 */
function listingEnterpriseMultiple(financials: TickerFinancials, statement: FinancialStatement, metric: string): number | null | undefined {
  if (metric !== "evEbitda" && metric !== "evSales") return undefined;
  if (metric === "evEbitda" && isBankOrInsurerIndustry(financials.profile?.industry)) return null;
  const listing = listingEnterpriseValue(financials);
  if (listing.kind === "not-meaningful") return null;
  if (listing.kind !== "value") return undefined;
  const rate = listingStatementRate(listing, statement.currency ?? financials.financialCurrency);
  if (rate === null) return undefined;
  const denominator = metric === "evEbitda" ? statement.ebitda : statement.totalRevenue;
  if (metric === "evEbitda" && !(isFiniteNumber(denominator) && denominator > 0)) return null;
  return ratio(listing.value, isFiniteNumber(denominator) ? denominator * rate : denominator);
}

/** Units of the listing EV's currency per unit of the statement's: 1 in its own, the check's rate from another, null without one. */
function listingStatementRate(listing: Extract<ReturnType<typeof listingEnterpriseValue>, { kind: "value" }>, currency: string | undefined): number | null {
  if (!currency || currency === listing.currency) return 1;
  return listing.fx && listing.fx.from === currency && isFiniteNumber(listing.fx.rate) && listing.fx.rate > 0 ? listing.fx.rate : null;
}

/**
 * The rate a current EV multiple converted the statement at
 * (listingEnterpriseMultiple): `{ from: "EUR", rate: 1.133 }` for an ADR's
 * EUR statements under its USD EV; null in the EV's own currency.
 */
export function listingStatementConversion(financials: TickerFinancials, statement: FinancialStatement): { from: string; rate: number; to: string } | null {
  const listing = listingEnterpriseValue(financials);
  const currency = statement.currency ?? financials.financialCurrency;
  if (listing.kind !== "value" || !currency || currency === listing.currency) return null;
  const rate = listingStatementRate(listing, currency);
  return rate === null ? null : { from: currency, rate, to: listing.currency };
}

/**
 * The latest value of a statement-based multiple and the period it reads:
 * the regular session price (after the close, the close, dated by it) over
 * the latest period known when the quote was observed. The statements decide
 * whether there is one; a trailing P/E then takes the served one at that
 * price where there is one, so the chart ends on the P/E `valuation` prints,
 * and an EV multiple divides the listing's EV. `value` null where that period
 * gives none (a loss, EBITDA at or below zero, a missing line); null where
 * there is no period or price to read.
 */
function currentDerivedValuation(
  financials: TickerFinancials,
  statements: readonly FinancialStatement[],
  metric: string,
  currencies: ValuationCurrencyContext,
): { value: number | null; date: Date; statement: FinancialStatement } | null {
  const quote = financials.quote;
  if (valuationQuoteIssue(quote)) return null;
  const quoteDate = validDate(quote?.lastUpdated);
  if (!quoteDate || !isFiniteNumber(quote?.price) || quote.price <= 0) return null;
  const current = currentValuationPrice(quote);
  if (!current) return null;
  const quoteTime = quoteDate.getTime();
  // Select the latest known period first. Missing inputs, a loss or incompatible
  // currency cannot make an older period's denominator current again.
  const statement = statements
    .flatMap((candidate) => {
      const availableAt = validDate(metricAvailability(candidate, metric) ?? candidate.date);
      const observedAt = validDate(candidate.date);
      if (!availableAt || !observedAt || availableAt.getTime() > quoteTime) return [];
      return [{ candidate, observedAt: observedAt.getTime(), availableAt: availableAt.getTime() }];
    })
    .sort((left, right) => (
      left.observedAt - right.observedAt || left.availableAt - right.availableAt
    ))
    .at(-1)?.candidate;
  if (!statement) return null;
  // The listing's EV needs no price in the statement's currency: an ADR's converts the statement instead.
  const listing = listingEnterpriseMultiple(financials, statement, metric);
  if (listing !== undefined) return { value: listing, date: current.date, statement };
  const comparablePrice = currencies.priceInStatementUnits(statement, current.price);
  if (comparablePrice === null) return null;
  const value = valuationAtPrice(statement, metric, comparablePrice);
  if (value === null) return { value: null, date: current.date, statement };
  return { value: (metric === "trailingPE" ? servedTrailingPE(financials) : null) ?? value, date: current.date, statement };
}

/**
 * Why a current EV/EBITDA is N/M where the statement it reads has an EBITDA:
 * a bank's or an insurer's, or EBITDA at or below zero. Undefined otherwise.
 */
function ebitdaNotMeaningful(financials: TickerFinancials, statement: FinancialStatement): string | undefined {
  if (isBankOrInsurerIndustry(financials.profile?.industry)) return BANK_OR_INSURER_EBITDA;
  return isFiniteNumber(statement.ebitda) && statement.ebitda <= 0 ? "Trailing EBITDA is not positive" : undefined;
}

export function currentDerivedValuationPoint(
  financials: TickerFinancials,
  statements: readonly FinancialStatement[],
  metric: string,
  currencies: ValuationCurrencyContext,
): TimeSeriesPoint | null {
  const current = currentDerivedValuation(financials, statements, metric, currencies);
  if (!current || current.value === null) return null;
  return {
    date: current.date,
    observedAt: current.date,
    availableAt: current.date,
    value: current.value,
    periodLabel: "Current",
    provenance: {
      providerId: financials.quote?.providerId,
      quality: "derived",
    },
  };
}

/**
 * The value GE's trailing-twelve-months series of a statement multiple ends
 * on, and the quarter its period ends with: the figure RV's added EV/EBITDA
 * column shows, so the two never disagree. `value` null with the reason where
 * it is not meaningful (`notMeaningful`, GE's N/M); null where GE draws no
 * current point and has no reason for it.
 */
export function currentTrailingValuation(
  financials: TickerFinancials,
  metric: "evEbitda" | "evSales",
): { value: number | null; notMeaningful?: string; periodEnd: string; statement: FinancialStatement } | null {
  const current = currentValuation(financials, "ttm", metric);
  if (!current) return null;
  const dated = { periodEnd: current.statement.date.slice(0, 10), statement: current.statement };
  if (current.value !== null) return { value: current.value, ...dated };
  const notMeaningful = metric === "evEbitda" ? ebitdaNotMeaningful(financials, current.statement) : undefined;
  return notMeaningful ? { value: null, notMeaningful, ...dated } : null;
}

function currentValuation(financials: TickerFinancials, period: SeriesPeriod | undefined, metric: string) {
  const selected = sourceStatements(financials, period, metric);
  return currentDerivedValuation(financials, currentValuationStatements(financials, selected, metric), metric,
    createValuationCurrencyContext(financials));
}

/**
 * Why a valuation series ends on no value: EV/EBITDA is N/M for a bank or an
 * insurer, and over EBITDA at or below zero, as RV reads it. The period the
 * series would end on dates it. Undefined for any other series, or where its
 * current value is there.
 */
export function valuationNotMeaningful(financials: TickerFinancials, source: SecuritySeriesSource): { reason: string; asOf: string } | undefined {
  const [namespace, metric = ""] = canonicalTimeSeriesFieldId(source.fieldId).split(".");
  if (namespace !== "valuation" || metric !== "evEbitda") return undefined;
  // A daily series ends on the trailing twelve months, as its current point does.
  const period = source.period === "daily" || source.period === "auto" || !source.period ? "ttm" : source.period;
  const current = currentValuation(financials, period, metric);
  if (current) {
    const reason = current.value === null ? ebitdaNotMeaningful(financials, current.statement) : undefined;
    return reason ? { reason, asOf: current.statement.date.slice(0, 10) } : undefined;
  }
  if (!isBankOrInsurerIndustry(financials.profile?.industry)) return undefined;
  const latest = sourceStatements(financials, period).statements.at(-1);
  return latest ? { reason: BANK_OR_INSURER_EBITDA, asOf: latest.date.slice(0, 10) } : undefined;
}

/**
 * The trailing twelve months of a statement line the way GE's `ttm` series
 * reads it (four consecutive quarters, a fiscal fourth quarter completed from
 * its year): the latest one, or null when the latest window is incomplete.
 */
export function latestTrailingStatement(financials: TickerFinancials): FinancialStatement | null {
  const selected = sourceStatements(financials, "ttm");
  return selected.statements.at(-1) ?? null;
}

/**
 * The periods a Current multiple is read from: the selected ones, and beside
 * fiscal years the trailing twelve months the quarters after them sum to, so a
 * fiscal year's EPS never prices today once later quarters are reported. A
 * fiscal year is itself a trailing twelve months at its end.
 */
export function currentValuationStatements(
  financials: TickerFinancials,
  selected: ReturnType<typeof sourceStatements>,
  metric: string,
): InternalStatement[] {
  if (selected.period !== "annual") return selected.statements;
  const known = valuationStatements(financials);
  const trailing = buildTtmStatements(deriveQuarterlyStatements(known.quarterly, known.annual), known.annual)
    .filter((statement) => hasValuationInputs(statement, metric));
  return [...selected.statements, ...trailing];
}
