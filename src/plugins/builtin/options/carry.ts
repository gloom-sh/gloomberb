import type { OptionContract } from "../../../types/financials";
import { daysToExpiryFrom, optionMid, type OptionSide } from "../shared/volatility";
import { optionSpread } from "./market-reference";

/**
 * What holding a contract costs in time value, read the same way by the OMON
 * columns and the LEAPS screen (`gloomberb options --leaps`):
 *
 *   intrinsic          = max(0, spot - strike) for a call, max(0, strike - spot) for a put
 *   extrinsic          = midpoint - intrinsic, the midpoint of a two-sided quote
 *   extrinsic per year = extrinsic / spot / years to expiry
 *
 * Years are calendar days to the 16:00 New York close on the expiry date, over
 * 365, counted from the instant the Greeks are valued at. Under a day from the
 * close there is no yearly figure: a few cents over a few hours annualises to
 * noise. Extrinsic is negative when the midpoint sits below intrinsic value, as
 * a wide deep in-the-money quote can. Without a two-sided quote or a current
 * spot there is no figure, never a zero.
 */
export interface OptionCarry {
  /** Time value per share, in the contract's currency. */
  extrinsic: number;
  /** Time value as a fraction of spot per year: 0.042 reads 4.2%. Null under a day from expiry. */
  extrinsicPerYear: number | null;
}

/** Less time than this to expiry and a yearly rate means nothing. */
const MIN_CARRY_DAYS = 1;

function positive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function optionIntrinsicValue(side: OptionSide, strike: number, spot: number): number {
  return Math.max(0, side === "call" ? spot - strike : strike - spot);
}

export function optionCarry(
  contract: Pick<OptionContract, "bid" | "ask" | "strike" | "expiration">,
  side: OptionSide,
  spot: number | null | undefined,
  valuationTime: number,
): OptionCarry | null {
  const mid = optionMid(contract);
  if (mid == null || !positive(spot) || !positive(contract.strike)) return null;
  const extrinsic = mid - optionIntrinsicValue(side, contract.strike, spot);
  const days = daysToExpiryFrom(contract.expiration, valuationTime);
  return { extrinsic, extrinsicPerYear: days >= MIN_CARRY_DAYS ? extrinsic / spot / (days / 365) : null };
}

/** Bid/ask width as a percent of the midpoint; null without a two-sided quote. */
export function optionSpreadPercent(contract: Pick<OptionContract, "bid" | "ask">): number | null {
  const spread = optionSpread(contract);
  return spread.kind === "two-sided" ? spread.percentOfMid : null;
}

/**
 * What a contract costs against the stock it covers: the midpoint of a
 * two-sided quote over spot, so a protective put's premium reads as a share of
 * the position it protects (a 5.495 put on a 778.57 underlying is 0.706%).
 * Null without a two-sided quote or a current spot, never a zero.
 */
export function optionCostOfSpot(
  contract: Pick<OptionContract, "bid" | "ask">,
  spot: number | null | undefined,
): number | null {
  const mid = optionMid(contract);
  return mid == null || !positive(spot) ? null : mid / spot;
}

/** Below this a cost of spot reads as a bound: the digits would outrun the column. */
const MIN_COST_OF_SPOT_PERCENT = 0.001;

/**
 * A fraction as a percent to three significant digits: 0.00706 reads 0.706%,
 * 0.0123 reads 1.23%, 0.123 reads 12.3%. Under a thousandth of a percent it
 * reads <0.001%, so a far out-of-the-money quote stays inside the column.
 */
export function formatCostOfSpot(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "\u2014";
  const percent = value * 100;
  if (percent === 0) return "0%";
  if (percent < MIN_COST_OF_SPOT_PERCENT) return `<${MIN_COST_OF_SPOT_PERCENT}%`;
  // Rounded first, so 9.996 reads 10.0% rather than 10.00%.
  const rounded = Number(percent.toPrecision(3));
  const decimals = Math.max(0, 2 - Math.floor(Math.log10(rounded)));
  return `${rounded.toFixed(decimals)}%`;
}

/** A fraction as a percent: one decimal under 100% (0.0421 reads 4.2%), whole percents above. */
export function formatCarryPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const percent = value * 100;
  return `${percent.toFixed(Math.abs(percent) < 100 ? 1 : 0)}%`;
}
