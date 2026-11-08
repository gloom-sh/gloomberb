// Chooses the statements a series is read from for a period and metric: annual, quarterly, trailing, or dated at release.
import type { FinancialStatement, TickerFinancials } from "../../types/financials";
import { areNearbyFinancialPeriodEnds, statementFieldAvailability } from "../../utils/financial-statements";
import { hasStatementGap } from "../../utils/statement-gaps";
import { statementAtRelease } from "../valuation-releases";
import type { SeriesPeriod } from "../types";
import { isFiniteNumber } from "../../utils/guards";
import { buildTtmStatements, deriveQuarterlyStatements } from "./quarterly-ttm";
import {
  completeStatementAvailability,
  type InternalStatement,
  NUMERIC_STATEMENT_FIELDS,
  QUARTERLY_SNAPSHOT_FIELDS,
  statementNumber,
} from "./statement";
import { selectedShares } from "./statement-fields";
import { mergeStatementsByPeriod } from "./statement-merge";
import { hasValuationInputs } from "./valuation-multiples";

/**
 * A split restates EPS onto the new share count, and SEC history dates the
 * restated figure by the filing that evidenced the split. The earnings were
 * known at the original filing; price history is split-adjusted the same way,
 * so a multiple of the restated figure steps when it was first filed. The
 * EPS series itself keeps the restatement's date: its value is the restated one.
 */
export function knownWhenFiled(row: FinancialStatement): FinancialStatement {
  const filed = row.epsBasis?.status === "split-adjusted" ? row.epsBasis.originalFiled : undefined;
  if (!filed || !Number.isFinite(Date.parse(filed))) return row;
  const current = statementFieldAvailability(row, "eps");
  if (current && Date.parse(current) <= Date.parse(filed)) return row;
  return { ...row, fieldAvailability: { ...row.fieldAvailability, eps: filed } };
}

/** The statements a multiple is priced from, each restated EPS dated by its first filing. */
export function valuationStatements(financials: TickerFinancials): { quarterly: FinancialStatement[]; annual: FinancialStatement[] } {
  return { quarterly: financials.quarterlyStatements.map(knownWhenFiled), annual: financials.annualStatements.map(knownWhenFiled) };
}

/**
 * A fiscal fourth quarter's EPS stated without a filing date of its own (a
 * 10-K states the year, the results release the quarter) was public once its
 * year's filing was, so it is dated by that filing. The daily P/E of the
 * quarters after it then sums the same four quarters PEB and the headline EPS
 * (TTM) sum (time-series/filed-trailing-eps), rather than reading the quarter
 * from the year and landing a cent of rounding away from them. The window that
 * ends with the year takes the year's own EPS (fiscalYearEpsAtYearEnd).
 */
function fourthQuarterEpsAtYearFiling(row: FinancialStatement, annual: readonly FinancialStatement[]): FinancialStatement {
  if (!isFiniteNumber(row.eps) || hasStatementGap(row, "eps") || statementFieldAvailability(row, "eps")) return row;
  const year = annual.find((candidate) => candidate.currency === row.currency && areNearbyFinancialPeriodEnds(candidate.date, row.date));
  const filed = year && isFiniteNumber(year.eps) ? statementFieldAvailability(year, "eps") : undefined;
  return filed ? { ...row, fieldAvailability: { ...row.fieldAvailability, eps: filed } } : row;
}

/**
 * At a fiscal year end the filed year's diluted EPS is the daily trailing
 * figure, as PEB and the headline EPS (TTM) read it (filed-trailing-eps): four
 * quarters need not add up to their year (3.90 for the year beside four
 * quarters of 1.00), so their sum stands only where the year gives no dated EPS.
 */
function fiscalYearEpsAtYearEnd(statements: readonly InternalStatement[], annual: readonly FinancialStatement[]): InternalStatement[] {
  return statements.map((statement) => {
    const year = annual.find((row) => row.currency === statement.currency && areNearbyFinancialPeriodEnds(row.date, statement.date));
    const eps = year && !hasStatementGap(year, "eps") ? statementNumber(year, "eps") : null;
    if (!year || eps === null) return statement;
    const { epsBasis: _sum, ...rest } = statement;
    const fieldAvailability = { ...statement.fieldAvailability };
    const filed = statementFieldAvailability(year, "eps");
    if (filed) fieldAvailability.eps = filed;
    else delete fieldAvailability.eps;
    const next: InternalStatement = {
      ...rest, eps, fieldAvailability, ...(year.epsBasis ? { epsBasis: year.epsBasis } : {}),
      __timeSeriesDerivedFields: [...new Set([...(statement.__timeSeriesDerivedFields ?? []), "eps" as const])],
    };
    next.availableAt = completeStatementAvailability(next) ?? statement.availableAt;
    return next;
  });
}

/** An undated vendor value cannot block a derivation from dated filings. */
function datedValuationStatement(statement: FinancialStatement): FinancialStatement {
  const dated = { ...statement };
  for (const field of NUMERIC_STATEMENT_FIELDS) {
    if (!statementFieldAvailability(statement, field)) delete dated[field];
  }
  return dated;
}

function normalizeFundamentalPeriod(period: SeriesPeriod | undefined): "annual" | "quarterly" | "ttm" | "auto" {
  return period === "annual" || period === "quarterly" || period === "ttm" ? period : "auto";
}

export function sourceStatements(
  financials: TickerFinancials,
  period: SeriesPeriod | undefined,
  valuationMetric?: string,
  exchange?: string,
): { statements: InternalStatement[]; period: "annual" | "quarterly" | "ttm" } {
  const normalized = normalizeFundamentalPeriod(period);
  let known = valuationMetric
    ? valuationStatements(financials)
    : { quarterly: financials.quarterlyStatements, annual: financials.annualStatements };
  if (period === "daily" && valuationMetric) {
    const releases = financials.earningsReleases ?? [];
    const venue = financials.quote?.listingExchangeName || financials.quote?.exchangeName || exchange;
    known = { quarterly: known.quarterly.map(row => statementAtRelease(row, releases, venue)),
      annual: known.annual.map(row => statementAtRelease(row, releases, venue)) };
    const annualRows = known.annual;
    known = { ...known, quarterly: known.quarterly.map((row) => fourthQuarterEpsAtYearFiling(row, annualRows)) };
    known = { quarterly: known.quarterly.map(datedValuationStatement), annual: known.annual.map(datedValuationStatement) };
    // A later comparative quarter may repeat a year-end balance sheet that
    // the annual filing already published. Only identical, same-currency
    // snapshots can inherit that earlier evidence; changed values cannot.
    known.quarterly = known.quarterly.map((statement) => {
      const dated = { ...statement, fieldAvailability: Object.fromEntries(NUMERIC_STATEMENT_FIELDS.flatMap((field) => {
        const availableAt = statementFieldAvailability(statement, field);
        return availableAt ? [[field, availableAt]] : [];
      })) };
      for (const annual of known.annual) {
        if (annual.currency !== dated.currency || !areNearbyFinancialPeriodEnds(annual.date, dated.date)) continue;
        for (const field of QUARTERLY_SNAPSHOT_FIELDS) {
          const value = statementNumber(dated, field);
          const earlier = statementFieldAvailability(annual, field);
          const current = statementFieldAvailability(dated, field);
          if (value !== null && value === statementNumber(annual, field) && earlier
            && (!current || Date.parse(earlier) < Date.parse(current))) {
            dated.fieldAvailability[field] = earlier;
          }
        }
      }
      return dated;
    });
  }
  const quarterly = deriveQuarterlyStatements(known.quarterly, known.annual);
  if (period === "daily" && valuationMetric) {
    // Sparse or loss-making quarters are gaps, not permission to substitute
    // an older annual denominator. Annual-only issuers retain their years.
    if (!known.quarterly.length) return { statements: mergeStatementsByPeriod(known.annual), period: "annual" };
    const statements = fiscalYearEpsAtYearEnd(buildTtmStatements(quarterly, known.annual), known.annual);
    // Capitalization uses the latest reported share count, not an average
    // of four quarters. Keep TTM average shares for the income/EPS fallback.
    if (valuationMetric !== "trailingPE") for (const statement of statements) {
      const latest = quarterly.find((row) => row.date === statement.date);
      const year = known.annual.find((row) => areNearbyFinancialPeriodEnds(row.date, statement.date));
      const shareRow = latest && selectedShares(latest) ? latest : year;
      for (const field of ["dilutedShares", "basicShares", "ordinarySharesNumber", "shareIssued"] as const) {
        delete statement[field];
        delete statement.fieldAvailability?.[field];
        if (shareRow?.[field] !== undefined) {
          statement[field] = shareRow[field];
          const availableAt = statementFieldAvailability(shareRow, field);
          if (availableAt) (statement.fieldAvailability ??= {})[field] = availableAt;
        }
      }
    }
    return { statements, period: "ttm" };
  }
  if (normalized === "annual") {
    return { statements: mergeStatementsByPeriod(known.annual), period: "annual" };
  }
  if (normalized === "ttm" || valuationMetric) {
    const ttm = buildTtmStatements(quarterly, known.annual);
    if (normalized === "ttm" && ttm.length > 0) return { statements: ttm, period: "ttm" };
    if (valuationMetric && ttm.some((statement) => hasValuationInputs(statement, valuationMetric))) {
      return { statements: ttm, period: "ttm" };
    }
    if (normalized === "ttm") return { statements: [], period: "ttm" };
    if (valuationMetric) {
      return { statements: mergeStatementsByPeriod(known.annual), period: "annual" };
    }
  }
  if (normalized === "quarterly" || (normalized === "auto" && quarterly.length > 0)) {
    return { statements: quarterly, period: "quarterly" };
  }
  return { statements: mergeStatementsByPeriod(known.annual), period: "annual" };
}
