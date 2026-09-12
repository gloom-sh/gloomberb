import type { FinancialStatement, TickerFinancials } from "../types/financials";
import { resolveCurrencyUnit, type CurrencyUnitInfo } from "../utils/currency-units";

function knownUnit(currency?: string): CurrencyUnitInfo | null {
  const unit = resolveCurrencyUnit(currency);
  return /^[A-Z]{3}$/.test(unit.currency) && unit.currency !== "XXX" ? unit : null;
}

function sameUnit(left: CurrencyUnitInfo, right: CurrencyUnitInfo): boolean {
  return left.currency === right.currency && left.divisor === right.divisor;
}

/** Price and statement amounts must share a verified monetary basis before division. */
export function createValuationCurrencyContext(financials: TickerFinancials) {
  const quoteUnit = knownUnit(financials.quote?.currency);
  const declared = knownUnit(financials.financialCurrency);
  const explicit = [...financials.annualStatements, ...financials.quarterlyStatements]
    .flatMap((row) => row.currency?.trim() ? [knownUnit(row.currency)] : []);
  // Current aggregate metadata cannot fill historical holes across a currency or
  // denomination change. A row's own declaration always takes precedence.
  const fallback = declared && explicit.every((unit) => unit && sameUnit(unit, declared))
    ? declared : null;
  const statementUnit = (row: FinancialStatement) => row.currency?.trim()
    ? knownUnit(row.currency) : fallback;

  return {
    priceInStatementUnits(row: FinancialStatement, price: number): number | null {
      const unit = statementUnit(row);
      if (!quoteUnit || !unit || unit.currency !== quoteUnit.currency) return null;
      // GBp/GBX prices can be compared with GBP statements without an FX rate.
      // Already normalized GBP prices retain divisor 1 and are not scaled twice.
      return price / quoteUnit.divisor * unit.divisor;
    },
    warning(rows: readonly FinancialStatement[]): string | undefined {
      const incompatible = rows.filter((row) => {
        const unit = statementUnit(row);
        return !quoteUnit || !unit || unit.currency !== quoteUnit.currency;
      });
      if (!incompatible.length) return undefined;
      const currencies = [...new Set(incompatible.map((row) => statementUnit(row)?.currency ?? "unknown"))];
      return `Valuation currency mismatch or unknown basis: ${currencies.join("/")} reporting, ${quoteUnit?.currency ?? "unknown"} price. Affected ratios are unavailable.`;
    },
  };
}

export type ValuationCurrencyContext = ReturnType<typeof createValuationCurrencyContext>;
