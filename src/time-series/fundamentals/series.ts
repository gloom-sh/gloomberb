// Extracts a fundamental or valuation series from a ticker's financials, with the warnings and issues that explain it.
import type { TickerFinancials } from "../../types/financials";
import { fiscalYearEndMonth } from "../../utils/fiscal-period";
import { canonicalTimeSeriesFieldId, getTimeSeriesField } from "../field-catalog";
import { dailyForwardPeHistory, forwardPeHistory, realizedNtmPeHistory } from "../forward-valuation";
import { reportingCurrencySeries } from "../reporting-currency";
import { createValuationCurrencyContext } from "../valuation-currency";
import { valuationPriceAtOrBefore, valuationQuoteIssue, type ValuationPriceIssue } from "../valuation-price";
import type { SecuritySeriesSource, TimeSeriesPoint } from "../types";
import { isBankOrInsurerIndustry } from "../../utils/ebitda";
import { notTheShare } from "../../utils/share-multiples";
import { currentDerivedValuationPoint, currentValuationStatements, providerCurrentValuationPoint } from "./current-valuation";
import { dailyStatementValuation, dailyValuationFallbackPeriod, historicalValuation } from "./historical-valuation";
import { FUNDAMENTAL_IDS, QUOTE_DERIVED_VALUATION_IDS, VALUATION_IDS, valuationSeriesUsesLiveQuote } from "./metric-ids";
import { dedupeFundamentalPeriods, pointForStatement } from "./period-points";
import { sourceStatements } from "./source-statements";
import { fundamentalValue, metricAvailability } from "./statement-fields";
import { valuationAtPrice } from "./valuation-multiples";

/** The multiples of a share's price over its company's earnings (notTheShare withdraws them). */
const SHARE_PRICE_EARNINGS = new Set(["trailingPE", "forwardPE", "realizedNtmPE", "pegRatio"]);

/** Extracts the selected statement snapshot, retaining known availability dates without reconstructing prior vintages. */
export function extractFundamentalSeries(
  financials: TickerFinancials | null,
  source: SecuritySeriesSource,
): TimeSeriesPoint[] {
  if (!financials) return [];
  const canonicalId = canonicalTimeSeriesFieldId(source.fieldId);
  const [namespace, metric = ""] = canonicalId.split(".");
  if (namespace === "fundamental" && FUNDAMENTAL_IDS.has(metric)) {
    const selected = sourceStatements(financials, source.period);
    const yearEndMonth = fiscalYearEndMonth(financials.annualStatements);
    let hasObservation = false;
    const points = selected.statements.flatMap((statement) => {
      const result = fundamentalValue(statement, metric);
      if (result.value !== null) hasObservation = true;
      const point = pointForStatement(
        statement,
        metric,
        result.value,
        selected.period,
        source.timestampMode,
        result.derived,
        yearEndMonth,
      );
      return point ? [point] : [];
    });
    if (!hasObservation) return [];
    const deduped = dedupeFundamentalPeriods(points);
    return getTimeSeriesField(canonicalId)?.unit.startsWith("currency")
      ? reportingCurrencySeries(deduped, financials.financialCurrency).points : deduped;
  }

  if (namespace !== "valuation" || !VALUATION_IDS.has(metric)) return [];
  // A warrant's, a right's, a unit's or an unratioed receipt's price over its company's EPS is no P/E at any date.
  if (SHARE_PRICE_EARNINGS.has(metric) && notTheShare(financials)) return [];
  // A bank's or an insurer's EBITDA measures nothing: its EV/EBITDA is N/M throughout (valuationNotMeaningful).
  if (metric === "evEbitda" && isBankOrInsurerIndustry(financials.profile?.industry)) return [];
  const fallback = dailyValuationFallbackPeriod(financials, source);
  if (fallback) return extractFundamentalSeries(financials, { ...source, period: fallback });
  if (source.period === "daily" && metric !== "realizedNtmPE") {
    if (metric !== "forwardPE") return dailyStatementValuation(financials, metric, source.instrument.exchange);
    const points = dailyForwardPeHistory(financials, createValuationCurrencyContext(financials), source.instrument.exchange);
    if (points.some((point) => point.value !== null)) return points;
    const current = providerCurrentValuationPoint(financials, metric);
    return current ? [current] : [];
  }
  if (metric === "forwardPE") {
    const points = forwardPeHistory(financials, createValuationCurrencyContext(financials));
    if (points.length > 0) return points;
    // Without an estimate history the provider's own figure is all there is.
    const current = providerCurrentValuationPoint(financials, metric);
    return current ? [current] : [];
  }
  if (metric === "realizedNtmPE") {
    return realizedNtmPeHistory(financials, createValuationCurrencyContext(financials));
  }
  if (metric === "pegRatio") {
    const current = providerCurrentValuationPoint(financials, metric);
    return current ? [current] : [];
  }

  const selected = sourceStatements(financials, source.period, metric);
  const currencies = createValuationCurrencyContext(financials);
  const yearEndMonth = fiscalYearEndMonth(financials.annualStatements);
  let hasHistoricalObservation = false;
  const historical = selected.statements.flatMap((statement) => {
    const historical = historicalValuation(financials, statement, metric, currencies);
    if (historical !== null) hasHistoricalObservation = true;
    const point = pointForStatement(
      statement,
      metric,
      historical?.value ?? null,
      selected.period,
      source.timestampMode,
      true,
      yearEndMonth,
    );
    if (point && historical?.integrity) point.provenance = { ...point.provenance, priceHistoryIntegrity: historical.integrity };
    if (point && historical?.issue) point.provenance = { ...point.provenance,
      valuationPriceIssues: [{ ...historical.issue, affectedAt: point.date.toISOString() }] };
    return point ? [point] : [];
  });
  const current = currentDerivedValuationPoint(financials, currentValuationStatements(financials, selected, metric), metric, currencies);
  if (!hasHistoricalObservation && !current) return [];
  const dedupedHistorical = dedupeFundamentalPeriods(historical);
  // Publication timestamps can be shared by distinct fiscal periods. Their
  // period identities were deduplicated above; a gap must not overwrite a
  // different period's usable observation released on the same date.
  return (current ? [...dedupedHistorical, current] : dedupedHistorical).sort((left, right) => (
    left.date.getTime() - right.date.getTime() || left.observedAt.getTime() - right.observedAt.getTime()
  ));
}

/**
 * The period a fundamental series asks for that its company reports no figure
 * of, though it reports annual ones: `quarterly` for an issuer that reports
 * twice a year. Null for any other series, and when the annual figures are as
 * missing as the quarterly ones.
 */
export function unreportedStatementPeriod(
  financials: TickerFinancials,
  source: SecuritySeriesSource,
): "quarterly" | null {
  if (source.period !== "quarterly" || !canonicalTimeSeriesFieldId(source.fieldId).startsWith("fundamental.")) return null;
  return extractFundamentalSeries(financials, { ...source, period: "annual" }).length > 0 ? "quarterly" : null;
}

export function fundamentalSeriesUsesAvailabilityFallback(
  financials: TickerFinancials | null,
  source: SecuritySeriesSource,
): boolean {
  if (!financials || source.timestampMode === "period-end") return false;
  // A gap has no value to place, so it has no date to fall back for.
  const points = extractFundamentalSeries(financials, source);
  return points.some((point) => point.value != null && point.availableAt === undefined);
}

/** Explains withheld currency-dependent values through chart and export metadata. */
export function valuationCurrencyWarning(financials: TickerFinancials, source: SecuritySeriesSource): string | undefined {
  const [namespace, metric = ""] = canonicalTimeSeriesFieldId(source.fieldId).split(".");
  if (namespace !== "valuation" || !QUOTE_DERIVED_VALUATION_IDS.has(metric)) return undefined;
  const selected = sourceStatements(financials, source.period, metric);
  return createValuationCurrencyContext(financials).warning(selected.statements.filter((row) => (
    valuationAtPrice(row, metric, 1) !== null
  )));
}

/** Structured failures preserve source values independently of the chart's ratios. */
export function valuationPriceIssues(financials: TickerFinancials, source: SecuritySeriesSource): ValuationPriceIssue[] {
  if (source.period === "daily" && canonicalTimeSeriesFieldId(source.fieldId).startsWith("valuation.")) {
    return extractFundamentalSeries(financials, source).flatMap((point) => point.provenance?.valuationPriceIssues ?? []);
  }
  if (!valuationSeriesUsesLiveQuote(source.fieldId)) return [];
  const metric = canonicalTimeSeriesFieldId(source.fieldId).split(".")[1]!;
  const currencies = createValuationCurrencyContext(financials);
  const selected = sourceStatements(financials, source.period, metric);
  const rows = selected.statements.filter((row) => (
    currencies.priceInStatementUnits(row, 1) !== null && valuationAtPrice(row, metric, 1) !== null
  ));
  if (!rows.length) return [];
  const quoteIssue = valuationQuoteIssue(financials.quote);
  const issues = rows.flatMap((row) => {
    const price = valuationPriceAtOrBefore(financials.priceHistory, metricAvailability(row, metric) ?? row.date);
    const date = pointForStatement(row, metric, null, selected.period, source.timestampMode, true, null)?.date;
    return price?.issue && date ? [{ ...price.issue, affectedAt: date.toISOString() }] : [];
  });
  return [...(quoteIssue ? [quoteIssue] : []), ...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values()];
}
