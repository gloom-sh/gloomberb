// Valuation multiples at the price of each period or day, and the daily fallback for issuers whose history cannot be dated.
import type { FinancialStatement, TickerFinancials } from "../../types/financials";
import { completeAvailability } from "../../utils/financial-statements";
import { fiscalYearEndMonth } from "../../utils/fiscal-period";
import { canonicalTimeSeriesFieldId } from "../field-catalog";
import { dailyValuationHistory, type DailyValuationBasis } from "../daily-valuation";
import { createValuationCurrencyContext, type ValuationCurrencyContext } from "../valuation-currency";
import { valuationPriceAtOrBefore } from "../valuation-price";
import type { SecuritySeriesSource, TimeSeriesPoint } from "../types";
import { QUOTE_DERIVED_VALUATION_IDS } from "./metric-ids";
import { pointForStatement } from "./period-points";
import { sourceStatements } from "./source-statements";
import { DAY_MS, statementTime, validDate } from "./statement";
import { freeCashFlow, metricAvailability, selectedEps } from "./statement-fields";
import { valuationAtPrice } from "./valuation-multiples";

export function historicalValuation(
  financials: TickerFinancials,
  statement: FinancialStatement,
  metric: string,
  currencies: ValuationCurrencyContext,
) {
  // A price failure cannot make absent financial inputs appear available.
  if (currencies.priceInStatementUnits(statement, 1) === null || valuationAtPrice(statement, metric, 1, true) === null) return null;
  const priceDate = metricAvailability(statement, metric) ?? statement.date;
  const price = valuationPriceAtOrBefore(financials.priceHistory, priceDate);
  if (!price) return null;
  const comparablePrice = price.price === null ? null : currencies.priceInStatementUnits(statement, price.price);
  return { value: comparablePrice === null ? null : valuationAtPrice(statement, metric, comparablePrice), integrity: price.integrity, issue: price.issue };
}

export function dailyStatementValuation(financials: TickerFinancials, metric: string, exchange?: string): TimeSeriesPoint[] {
  const earningsMetric = metric === "pegRatio" ? "trailingPE" : metric;
  const selected = sourceStatements(financials, "daily", earningsMetric, exchange);
  const currencies = createValuationCurrencyContext(financials);
  const yearEndMonth = fiscalYearEndMonth(financials.annualStatements);
  const bases: DailyValuationBasis[] = selected.statements.flatMap((statement) => {
    const usable = valuationAtPrice(statement, earningsMetric, 1, true) !== null;
    // Missing dates cannot put information at the period end: until its
    // publication is known there is no historical denominator to use.
    let publication = metricAvailability(statement, earningsMetric)
      ?? (!usable ? statement.availableAt : undefined);
    let growth: number | null = null;
    if (metric === "pegRatio") {
      const prior = selected.statements.find((candidate) => {
        const days = (statementTime(statement) - statementTime(candidate)) / DAY_MS;
        return days >= 330 && days <= 400;
      });
      const currentEps = selectedEps(statement)?.value;
      const previousEps = prior ? selectedEps(prior)?.value : null;
      if (prior && currentEps != null && currentEps > 0 && previousEps != null && previousEps > 0) {
        publication = completeAvailability([publication, metricAvailability(prior, "trailingPE")]);
        const change = (currentEps / previousEps - 1) * 100;
        if (change > 0) growth = change;
      }
    }
    const observedAt = validDate(statement.date);
    if (!observedAt) return [];
    const availableAt = validDate(publication);
    if (availableAt && availableAt < observedAt) publication = undefined;
    const point = pointForStatement(statement, earningsMetric, null, selected.period, "available-at", true, yearEndMonth);
    return [{
      availableAt: publication,
      observedAt,
      periodLabel: point?.periodLabel,
      atPrice: (price: number) => {
        // An undated newer period must stop the previous TTM from continuing.
        // Its period end only bounds the gap; it never publishes a value.
        if (!publication || !availableAt) return null;
        const comparable = currencies.priceInStatementUnits(statement, price);
        if (comparable === null) return null;
        const value = valuationAtPrice(statement, earningsMetric, comparable);
        // Negative cash flow, revenue or EBITDA cannot produce a meaningful
        // multiple. Explicit period views retain their historical behavior.
        const denominator = earningsMetric === "priceFcf" ? freeCashFlow(statement).value
          : earningsMetric === "evEbitda" ? statement.ebitda
            : earningsMetric === "priceSales" || earningsMetric === "evSales" ? statement.totalRevenue : 1;
        if (denominator == null || denominator <= 0 || value === null) return null;
        return metric === "pegRatio" ? growth === null ? null : value / growth : value;
      },
    }];
  });
  const points = dailyValuationHistory(financials.priceHistory, bases, financials.quote?.listingExchangeName || financials.quote?.exchangeName || exchange);
  return points.some((point) => point.value !== null) ? points : [];
}

/** A daily history cannot be dated at all, but the issuer still has reported figures. */
export function dailyValuationFallbackPeriod(financials: TickerFinancials, source: SecuritySeriesSource): "annual" | "quarterly" | "ttm" | null {
  if (source.period !== "daily") return null;
  const [namespace, metric = ""] = canonicalTimeSeriesFieldId(source.fieldId).split(".");
  const inputMetric = metric === "pegRatio" ? "trailingPE" : metric;
  if (namespace !== "valuation" || !QUOTE_DERIVED_VALUATION_IDS.has(inputMetric)) return null;
  const daily = sourceStatements(financials, "daily", inputMetric, source.instrument.exchange);
  if (daily.statements.some(row => metricAvailability(row, inputMetric))) return null;
  const annual = sourceStatements(financials, "annual", inputMetric);
  if (annual.statements.some(row => valuationAtPrice(row, inputMetric, 1, true) !== null)) return "annual";
  const reported = sourceStatements(financials, "auto", inputMetric);
  return reported.statements.some(row => valuationAtPrice(row, inputMetric, 1, true) !== null) ? reported.period : null;
}
