import type { Portfolio, PortfolioCash } from "../../../types/ticker";
import type { BrokerAccount } from "../../../types/trading";
import { currencyMinorDigits, getCurrencySymbol, resolveAssetDisplayKind } from "../../../market-data/market/format";
import { formatNumber } from "../../../utils/format";

/**
 * Weights, targets and the trades that would rebalance a portfolio. `PF`, its
 * `fn PF` report and `gloomberb portfolio show` all read these figures from
 * here, so a weight never differs between them.
 *
 * A weight is a share of the total value, cash included: the priced holdings
 * at their net market value (a short counts against it) plus the cash line.
 * A holding without a price is left out of the total and the weights and is
 * listed as unpriced, never valued at zero.
 */

/** The cash line's symbol in targets and reports. */
export const CASH_SYMBOL = "CASH";

/** A broker portfolio without its account: margin can put its positions far above what it is worth. */
export const BROKER_ACCOUNT_MISSING_NOTE = "The broker account has not synced on this device, so its cash and margin are unknown: the total is the positions alone, not the account's value.";

/** One ticker of a portfolio, valued in the portfolio's currency. */
export interface AllocationHolding {
  symbol: string;
  /** Whether the portfolio holds a position in it, rather than only listing it. */
  held: boolean;
  /** Net market value, negative for a short; 0 when not held, null when held without a price. */
  marketValue: number | null;
  /** Units held, signed: shares, contracts or face amount. */
  units: number;
  /** The current price of one unit in the portfolio's currency, when known. */
  unitPrice: number | null;
}

export interface AllocationFigures {
  /** Percent of the total, cash included. */
  weight: number | null;
  /** Percent. */
  targetWeight: number | null;
  /** Weight minus target, in percentage points. */
  drift: number | null;
  /** Value to buy (positive) or sell (negative) to reach the target at the current price. */
  tradeValue: number | null;
  /** The same trade in units. */
  tradeUnits: number | null;
}

type PortfolioAllocationRow = AllocationHolding & AllocationFigures;

export interface PortfolioCashLine extends AllocationFigures {
  /** In the portfolio's currency. */
  value: number;
}

export interface PortfolioAllocation {
  /** One per holding, in the order given. */
  rows: PortfolioAllocationRow[];
  /** Present when the portfolio has cash or a cash target. */
  cash: PortfolioCashLine | null;
  /** Priced holdings plus cash; null when it cannot be valued. */
  total: number | null;
  /** Held symbols without a price, left out of the total and the weights. */
  unpriced: string[];
  /** The targets of the listed symbols and cash added up; null when none is set. */
  targetSum: number | null;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Weights need a positive total to mean anything. */
function weightBase(total: number | null | undefined): number | null {
  return finite(total) && total > 0 ? total : null;
}

/**
 * A holding's weight, drift and trade against a total. Rows read this with
 * their own live value, so the pane and the reports share one formula.
 */
export function allocationFigures(
  holding: Pick<AllocationHolding, "held" | "marketValue" | "units" | "unitPrice">,
  total: number | null | undefined,
  target: number | null | undefined,
): AllocationFigures {
  const base = weightBase(total);
  const targetWeight = finite(target) ? target : null;
  const marketValue = holding.held ? holding.marketValue : 0;
  // A listed ticker without a position has no weight to show until it has a target.
  const weight = base != null && finite(marketValue) && (holding.held || targetWeight != null)
    ? (marketValue / base) * 100
    : null;
  const drift = weight != null && targetWeight != null ? weight - targetWeight : null;
  const tradeValue = base != null && targetWeight != null && finite(marketValue)
    ? (targetWeight / 100) * base - marketValue
    : null;
  // The value of one unit as the position is valued (multiplier, par and FX
  // included); a ticker not yet held trades at its price.
  const unitValue = holding.held && holding.units !== 0 && finite(holding.marketValue)
    ? Math.abs(holding.marketValue / holding.units)
    : holding.unitPrice;
  const tradeUnits = tradeValue != null && finite(unitValue) && unitValue > 0 ? tradeValue / unitValue : null;
  return { weight, targetWeight, drift, tradeValue, tradeUnits };
}

/** The total weights divide by: every priced holding plus the cash. */
export function allocationTotal(holdings: readonly AllocationHolding[], cashValue: number | null | undefined): number | null {
  // Cash that cannot be converted leaves the total unknown rather than smaller.
  if (cashValue != null && !finite(cashValue)) return null;
  let total = cashValue ?? 0;
  for (const holding of holdings) {
    if (holding.held && finite(holding.marketValue)) total += holding.marketValue;
  }
  return Number.isFinite(total) ? total : null;
}

export function buildPortfolioAllocation({
  holdings,
  cashValue,
  targets,
}: {
  holdings: readonly AllocationHolding[];
  /** The cash line in the portfolio's currency; NaN when it cannot be converted. */
  cashValue?: number | null;
  targets?: Readonly<Record<string, number>>;
}): PortfolioAllocation {
  const total = allocationTotal(holdings, cashValue);
  const rows = holdings.map((holding) => ({ ...holding, ...allocationFigures(holding, total, holdingTarget(targets, holding.symbol)) }));
  const cashTarget = targets?.[CASH_SYMBOL];
  const cash = cashValue != null || finite(cashTarget)
    ? {
      value: cashValue ?? 0,
      ...allocationFigures({ held: true, marketValue: cashValue ?? 0, units: 0, unitPrice: null }, total, cashTarget),
    }
    : null;
  let targetSum: number | null = null;
  for (const symbol of new Set([...holdings.map((holding) => holding.symbol), CASH_SYMBOL])) {
    const target = symbol === CASH_SYMBOL ? cashTarget : holdingTarget(targets, symbol);
    if (finite(target)) targetSum = (targetSum ?? 0) + target;
  }
  return {
    rows,
    cash,
    total,
    unpriced: holdings.filter((holding) => holding.held && !finite(holding.marketValue)).map((holding) => holding.symbol),
    targetSum,
  };
}

/**
 * A holding's target. A stock saved under the bare symbol `CASH` (before that
 * symbol meant the cash line) never takes the cash line's target.
 */
export function holdingTarget(targets: Readonly<Record<string, number>> | undefined, symbol: string): number | undefined {
  return symbol === CASH_SYMBOL ? undefined : targets?.[symbol];
}

/** Whether any target is set on the portfolio. */
export function hasTargetWeights(portfolio: Pick<Portfolio, "targetWeights"> | null | undefined): boolean {
  return !!portfolio?.targetWeights && Object.keys(portfolio.targetWeights).length > 0;
}

/**
 * The portfolio's cash in its own currency. A broker account that reports its
 * cash is used instead of an entry made by hand, so the two never add up.
 */
export function resolvePortfolioCash(
  portfolio: Pick<Portfolio, "cash"> | null | undefined,
  account: Pick<BrokerAccount, "totalCashValue" | "currency"> | null | undefined,
): (PortfolioCash & { source: "broker" | "manual" }) | null {
  if (account && finite(account.totalCashValue)) {
    return { amount: account.totalCashValue, currency: account.currency?.trim().toUpperCase() ?? "", source: "broker" };
  }
  return portfolio?.cash ? { ...portfolio.cash, source: "manual" } : null;
}

/** `12.5`, `12.5%`: a target weight in percent from 0 to 100. */
export function parseTargetWeight(raw: string | undefined): number {
  const text = raw?.trim().replace(/%$/, "").trim() ?? "";
  const value = Number(text);
  if (!text || !Number.isFinite(value)) throw new Error(`Target weight must be a percent, such as 12.5 or 12.5%.`);
  if (value < 0 || value > 100) throw new Error("Target weight must be between 0% and 100%.");
  return value;
}

/** A one-line note when the targets do not add up to the whole portfolio, else null. */
export function describeTargetSum(targetSum: number | null): string | null {
  if (targetSum == null || Math.abs(targetSum - 100) < 0.05) return null;
  const remainder = 100 - targetSum;
  return remainder > 0
    ? `Targets add up to ${formatAllocationWeight(targetSum)}; ${formatAllocationWeight(remainder)} is unallocated.`
    : `Targets add up to ${formatAllocationWeight(targetSum)}, ${formatAllocationWeight(-remainder)} over the whole portfolio.`;
}

// One format per figure, the same in the pane, `fn PF` and `portfolio show`.

/** A weight to one decimal: 12.3%. */
export function formatAllocationWeight(value: number | null | undefined): string {
  if (!finite(value)) return "—";
  const fixed = value.toFixed(1);
  return `${/[1-9]/.test(fixed) ? fixed : fixed.replace("-", "")}%`;
}

/** Drift in percentage points, always signed unless it rounds to zero: +2.3pp. */
export function formatAllocationDrift(value: number | null | undefined): string {
  if (!finite(value)) return "—";
  const fixed = Math.abs(value).toFixed(1);
  if (!/[1-9]/.test(fixed)) return `${fixed}pp`;
  return `${value > 0 ? "+" : "-"}${fixed}pp`;
}

/**
 * Units to trade, signed. A holding kept in whole units trades in whole units,
 * rounded to the nearest; fractional holdings and coins keep four decimals
 * (eight for coins).
 */
export function formatTradeUnits(
  value: number | null | undefined,
  { units, assetCategory }: { units: number; assetCategory?: string },
): string {
  if (!finite(value)) return "—";
  const kind = resolveAssetDisplayKind({ assetCategory });
  const whole = kind !== "crypto" && kind !== "cash" && Number.isInteger(units);
  const decimals = whole ? 0 : kind === "crypto" ? 8 : 4;
  const rounded = Number(value.toFixed(decimals));
  if (rounded === 0) return "0";
  const body = new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals }).format(Math.abs(rounded));
  return `${rounded > 0 ? "+" : "-"}${body}`;
}

/**
 * A money value with thousands separators, at its currency's minor unit
 * ($1,234,567.89, ¥1,234,568) or in whole units for market values and
 * trades ($1,234,568). Signed values always carry + or -.
 */
export function formatAllocationMoney(
  value: number | null | undefined,
  currency: string,
  { signed = false, whole = false }: { signed?: boolean; whole?: boolean } = {},
): string {
  if (!finite(value)) return "—";
  const digits = whole ? 0 : currencyMinorDigits(currency);
  const body = formatNumber(Math.abs(value), digits);
  const zero = !/[1-9]/.test(body);
  const sign = zero ? "" : value < 0 ? "-" : signed ? "+" : "";
  return `${sign}${getCurrencySymbol(currency)}${body}`;
}
