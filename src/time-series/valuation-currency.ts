import { crossFxCloseOnOrBefore, dailyFxLeg, loadDailyFxCloses, type FxCloses, type FxHistoryClient } from "../market-data/fx-closes";
import type { FinancialStatement, TickerFinancials } from "../types/financials";
import { resolveCurrencyUnit, type CurrencyUnitInfo } from "../utils/currency-units";
import { listingOwnsRow } from "../utils/statement-scope";
import { logFailure } from "../utils/log-failure";

function knownUnit(currency?: string): CurrencyUnitInfo | null {
  const unit = resolveCurrencyUnit(currency);
  return /^[A-Z]{3}$/.test(unit.currency) && unit.currency !== "XXX" ? unit : null;
}

function sameUnit(left: CurrencyUnitInfo, right: CurrencyUnitInfo): boolean {
  return left.currency === right.currency && left.divisor === right.divisor;
}

export const VALUATION_CURRENCY_WARNING_PREFIX = "Valuation currency mismatch or unknown basis:";

/** Price and statement amounts must share a verified monetary basis before division. */
export function createValuationCurrencyContext(financials: TickerFinancials, fx?: ReadonlyMap<string, FxCloses>) {
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
  const rateFor = (row: FinancialStatement, date: string) => {
    const unit = statementUnit(row);
    if (!quoteUnit || !unit) return null;
    if (unit.currency === quoteUnit.currency) return unit.divisor / quoteUnit.divisor;
    const close = fx && crossFxCloseOnOrBefore(fx, quoteUnit.currency, unit.currency, date);
    return close ? close.rate * unit.divisor / quoteUnit.divisor : null;
  };

  return {
    priceInStatementUnits(row: FinancialStatement, price: number, date = row.date.slice(0, 10)): number | null {
      if (!listingOwnsRow(financials.statementScope, row)) return null;
      const rate = rateFor(row, date);
      return rate == null ? null : price * rate;
    },
    warning(rows: readonly FinancialStatement[], dateOf = (row: FinancialStatement) => row.date.slice(0, 10)): string | undefined {
      const incompatible = rows.filter((row) => rateFor(row, dateOf(row)) == null);
      if (!incompatible.length) return undefined;
      const currencies = [...new Set(incompatible.map((row) => statementUnit(row)?.currency ?? "unknown"))];
      return `${VALUATION_CURRENCY_WARNING_PREFIX} ${currencies.join("/")} reporting, ${quoteUnit?.currency ?? "unknown"} price. Affected ratios are unavailable.`;
    },
    conversionNote(rows: readonly FinancialStatement[], dateOf: (row: FinancialStatement) => string): string | undefined {
      const currencies = new Set(rows.flatMap((row) => {
        const unit = statementUnit(row);
        return unit && unit.currency !== quoteUnit?.currency && rateFor(row, dateOf(row)) != null ? [unit.currency] : [];
      }));
      return currencies.size ? `Period-end FX: ${quoteUnit!.currency} prices converted to ${[...currencies].join("/")}.` : undefined;
    },
    fxCurrencies(rows: readonly FinancialStatement[]): string[] {
      if (!quoteUnit) return [];
      const mismatches = rows.flatMap((row) => {
        const unit = statementUnit(row);
        return unit && unit.currency !== quoteUnit.currency ? [unit.currency, quoteUnit.currency] : [];
      });
      return [...new Set(mismatches)].filter((code) => code !== "USD" && dailyFxLeg(code));
    },
  };
}

export type ValuationCurrencyContext = ReturnType<typeof createValuationCurrencyContext>;

export async function valuationFxHistories(currencies: readonly string[], since: string, load: (code: string, since: string) => Promise<FxCloses>): Promise<ReadonlyMap<string, FxCloses>> {
  const histories = await Promise.all(currencies.map((code) => load(code, since)
    .catch(logFailure("valuation-currency", `Daily ${code} FX closes unavailable`, null))));
  return new Map(histories.flatMap((history) => history ? [[history.currency, history] as const] : []));
}

export function loadValuationFx(currencies: readonly string[], since: string, client: FxHistoryClient): Promise<ReadonlyMap<string, FxCloses>> {
  return valuationFxHistories(currencies, since, (code, date) => loadDailyFxCloses(code, date, client));
}
