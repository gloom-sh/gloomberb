import type { CorporateActionsData } from "../types/financials";
import { resolveCurrencyUnit } from "./currency-units";

/**
 * One step of a single-precision number, relative to it. Sources keep cash
 * amounts in single precision and scale them there, so 9.02 rand comes back
 * as 902.00006 cents and 15.36 pence as 15.360001.
 */
const SINGLE_PRECISION_STEP = 2 ** -23;

/**
 * An amount at the precision its source stated it: the shortest decimal within
 * one single-precision step of it, so 902.00006 reads 902 and 17.800001 reads
 * 17.8. A figure stated to more digits than that noise keeps them.
 */
export function atSourcePrecision(value: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const tolerance = Math.abs(value) * SINGLE_PRECISION_STEP;
  for (let digits = 1; digits <= 17; digits += 1) {
    const rounded = Number(value.toPrecision(digits));
    if (Math.abs(rounded - value) <= tolerance) return rounded;
  }
  return value;
}

type CashHistory = Pick<CorporateActionsData, "currency" | "dividends" | "declaredDividends">;

/**
 * A distribution history with its cash in the major currency unit, at its
 * source's precision: a ZAc history's 902.00006 reads ZAR 9.02. This is where
 * a sub-unit (GBp, ZAc, ILA) is divided out, once, as the history arrives from
 * its source; DVD, `events`, EVT and a forward yield's declared distribution
 * all read these figures and divide nothing. A history without a currency
 * keeps its amounts, which nothing can price.
 */
export function cashInMajorUnits<T extends CashHistory>(actions: T): T {
  const unit = resolveCurrencyUnit(actions.currency);
  if (!unit.currency) return actions;
  const major = <Row extends { amount: number }>(row: Row): Row =>
    typeof row?.amount === "number" && Number.isFinite(row.amount)
      ? { ...row, amount: atSourcePrecision(row.amount / unit.divisor) } : row;
  return {
    ...actions,
    currency: unit.currency,
    dividends: Array.isArray(actions.dividends) ? actions.dividends.map(major) : actions.dividends,
    ...(Array.isArray(actions.declaredDividends) ? { declaredDividends: actions.declaredDividends.map(major) } : {}),
  };
}
