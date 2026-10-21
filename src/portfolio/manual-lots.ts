import type { TickerPosition, TickerRecord } from "../types/ticker";
import { normalizeHeldCurrencyCode } from "../utils/currency-units";
import { parseDisplayDate } from "../utils/datetime-format";
import { signedPositionDirection } from "./position-metrics";

/** The ticker's manual lots in one portfolio, in saved order. */
export function manualPortfolioLots(ticker: TickerRecord, portfolioId: string): TickerPosition[] {
  return ticker.metadata.positions.filter((position) =>
    position.portfolio === portfolioId && position.broker === "manual"
  );
}

export interface ManualPortfolioPositionPrefill {
  /** The manual lots the ticker holds in the portfolio. Setting a position replaces every one of them. */
  lotCount: number;
  /**
   * The lot itself, or the total of several: signed shares added up, cost
   * averaged by shares, in their common currency. Null with no lot, and with
   * several that cannot be totalled.
   */
  position: TickerPosition | null;
  /** The currencies of several lots that disagree. They are not totalled across currencies. */
  currencies?: string[];
  /** Why several lots' cost FX rates do not become the position's one rate; the position then has none. */
  costFxConflict?: LotCostFxConflict;
}

/**
 * Why the cost FX rates of several lots cannot become one: some lots convert
 * their cost at the rate they were bought at and some at today's, the lots are
 * in different currencies, or their rates convert into different currencies.
 */
export type LotCostFxConflict = "todays-rate" | "lot-currencies" | "rate-currencies";

export interface MergedLotCostTerms {
  /** The earliest purchase date of the lots that have one. */
  dateAcquired?: string;
  /** One unit of `currency` in `costFx.currency`, weighted so the position's cost converts to what the lots' costs did. */
  costFx?: { rate: number; currency: string };
  /** The lots' common currency, the one `costFx` is a rate of. */
  currency?: string;
  costFxConflict?: LotCostFxConflict;
}

function lotCostFx(lot: TickerPosition): { rate: number; currency: string } | null {
  const rate = lot.costFxRate;
  const currency = lot.costFxCurrency?.trim().toUpperCase();
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 && currency ? { rate, currency } : null;
}

/**
 * The purchase date and cost FX rate several lots keep when they become one
 * position (a set over several lots, or a team's new count collapsing them):
 *
 * - The date is the earliest of the lots': the PF ACQ and HELD columns read the
 *   earliest lot already, so it reads the same after the merge.
 * - The rate is the lots' rates weighted by each lot's cost (shares times
 *   average cost), so the position's cost converts to exactly what the lots'
 *   costs did; by shares when a lot has no cost, there being no cost to keep.
 *
 * A rate is kept only when it is honest: every held lot has one, into one
 * currency, and the lots share a currency. Otherwise `costFxConflict` says why
 * and there is no rate. A lot of no shares weighs nothing and blocks nothing.
 */
export function mergeLotCostTerms(lots: readonly TickerPosition[]): MergedLotCostTerms {
  const dated = lots
    .map((lot) => ({ value: lot.dateAcquired, time: parseDisplayDate(lot.dateAcquired)?.getTime() }))
    .filter((entry): entry is { value: string; time: number } => !!entry.value && entry.time != null)
    .sort((left, right) => left.time - right.time)[0];
  const date = dated ? { dateAcquired: dated.value } : {};
  const nonzero = lots.filter((lot) => lot.shares !== 0);
  const held = nonzero.length > 0 ? nonzero : lots;
  const currencies = new Set(held.map((lot) => normalizeHeldCurrencyCode(lot.currency)));
  const currency = currencies.size === 1 ? { currency: [...currencies][0]! } : {};
  const rates = held.map(lotCostFx);
  const rated = rates.filter((rate): rate is { rate: number; currency: string } => rate !== null);
  if (rated.length === 0) return { ...date, ...currency };
  if (rated.length < held.length) return { ...date, ...currency, costFxConflict: "todays-rate" };
  if (currencies.size > 1) return { ...date, costFxConflict: "lot-currencies" };
  const into = new Set(rated.map((rate) => rate.currency));
  if (into.size > 1) return { ...date, ...currency, costFxConflict: "rate-currencies" };
  const costFxCurrency = rated[0]!.currency;
  if (rated.every((rate) => rate.rate === rated[0]!.rate)) return { ...date, ...currency, costFx: { rate: rated[0]!.rate, currency: costFxCurrency } };
  const costs = held.map((lot) => Math.abs(lot.shares) * (lot.avgCost ?? Number.NaN));
  const costed = costs.every((cost) => Number.isFinite(cost) && cost >= 0) && costs.some((cost) => cost > 0);
  const weights = costed ? costs : held.map((lot) => Math.abs(lot.shares));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const rate = tidyNumber(weights.reduce((sum, weight, index) => sum + weight * rated[index]!.rate, 0) / total);
  return Number.isFinite(rate) && rate > 0
    ? { ...date, ...currency, costFx: { rate, currency: costFxCurrency } }
    : { ...date, ...currency, costFxConflict: "todays-rate" };
}

/** Drops the float noise of a sum (0.1 + 0.2) without losing a digit anyone entered. */
function tidyNumber(value: number): number {
  return Number(value.toPrecision(15));
}

/**
 * A ticker's manual holding in one portfolio as a single position, for what
 * starts from it: the position form (so an unchanged save keeps the holding)
 * and team collection sync (the quantity it sends and compares). One lot is
 * itself; several are consolidated into the position a save would leave,
 * instead of whichever lot came first.
 */
export function getManualPortfolioPositionPrefill(ticker: TickerRecord, portfolioId: string): ManualPortfolioPositionPrefill {
  const lots = manualPortfolioLots(ticker, portfolioId);
  if (lots.length <= 1) {
    const lot = lots[0];
    // A lot marked short with a positive count is the same short as a negative count, which is how it is entered and sent.
    if (!lot || lot.side !== "short" || !(lot.shares > 0)) return { lotCount: lots.length, position: lot ?? null };
    const { side: _side, ...rest } = lot;
    return { lotCount: 1, position: { ...rest, shares: -lot.shares } };
  }

  const lotCount = lots.length;
  const currencies = [...new Set(lots.map((lot) => lot.currency?.trim() || ticker.metadata.currency?.trim() || ""))];
  if (currencies.length > 1) return { lotCount, position: null, currencies };

  // A long and a short lot offset each other, and lots of different contract
  // sizes count different things: neither total is a position to save. A lot
  // of no shares adds nothing to a total, so it decides neither.
  const held = lots.filter((lot) => lot.shares !== 0);
  const directions = new Set(held.map((lot) => signedPositionDirection(lot)));
  const multipliers = new Set(held.map((lot) => lot.multiplier));
  if (lots.some((lot) => !Number.isFinite(lot.shares)) || held.length === 0 || directions.size > 1 || multipliers.size > 1) {
    return { lotCount, position: null };
  }
  const magnitude = held.reduce((sum, lot) => sum + Math.abs(lot.shares), 0);
  const totalShares = [...directions][0]! * magnitude;
  const costed = lots.every((lot) => Number.isFinite(lot.avgCost));
  const avgCost = costed
    ? tidyNumber(lots.reduce((sum, lot) => sum + Math.abs(lot.shares) * lot.avgCost!, 0) / magnitude)
    : undefined;
  const multiplier = held[0]!.multiplier;
  // The purchase date and the rate the cost was bought at carry over as mergeLotCostTerms keeps them.
  const terms = mergeLotCostTerms(lots);
  return {
    lotCount,
    position: {
      portfolio: portfolioId,
      shares: tidyNumber(totalShares),
      ...(avgCost !== undefined ? { avgCost } : {}),
      // Lots that name no currency stay without one, as a single such lot does.
      ...(currencies[0] && lots.some((lot) => lot.currency?.trim()) ? { currency: currencies[0] } : {}),
      broker: "manual",
      ...(terms.dateAcquired ? { dateAcquired: terms.dateAcquired } : {}),
      ...(terms.costFx ? { costFxRate: terms.costFx.rate, costFxCurrency: terms.costFx.currency } : {}),
      ...(multiplier !== undefined ? { multiplier } : {}),
    },
    ...(terms.costFxConflict ? { costFxConflict: terms.costFxConflict } : {}),
  };
}
