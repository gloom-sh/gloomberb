import type { Portfolio } from "../types/ticker";
import { isManualPortfolio } from "./mutations";

const CURRENCY_CODE = /^[A-Z]{3}$/;

function currencyCode(value: string | undefined): string | null {
  const code = value?.trim().toUpperCase() ?? "";
  return CURRENCY_CODE.test(code) ? code : null;
}

/**
 * The currency a portfolio's totals, market values and P&L are in. A broker
 * portfolio uses its account currency. A manual portfolio uses its stored
 * currency with the default USD base (its first holding sets it, see
 * adoptFirstPositionCurrency); a base currency the user chose is what manual
 * portfolios and watchlists total in.
 */
export function resolvePortfolioTotalsCurrency(portfolio: Portfolio | null | undefined, baseCurrency: string): string {
  const base = currencyCode(baseCurrency) ?? "USD";
  if (!portfolio) return base;
  if (isManualPortfolio(portfolio) && base !== "USD") return base;
  return currencyCode(portfolio.currency) ?? base;
}
