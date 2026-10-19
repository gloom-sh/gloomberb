import type { TickerPosition, TickerRecord } from "../types/ticker";
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
  // sizes count different things: neither total is a position to save.
  const directions = new Set(lots.map((lot) => signedPositionDirection(lot)));
  const multipliers = new Set(lots.map((lot) => lot.multiplier));
  if (lots.some((lot) => !Number.isFinite(lot.shares) || lot.shares === 0) || directions.size > 1 || multipliers.size > 1) {
    return { lotCount, position: null };
  }
  const magnitude = lots.reduce((sum, lot) => sum + Math.abs(lot.shares), 0);
  const totalShares = [...directions][0]! * magnitude;
  const costed = lots.every((lot) => Number.isFinite(lot.avgCost));
  const avgCost = costed
    ? tidyNumber(lots.reduce((sum, lot) => sum + Math.abs(lot.shares) * lot.avgCost!, 0) / magnitude)
    : undefined;
  const multiplier = lots[0]!.multiplier;
  return {
    lotCount,
    position: {
      portfolio: portfolioId,
      shares: tidyNumber(totalShares),
      ...(avgCost !== undefined ? { avgCost } : {}),
      // Lots that name no currency stay without one, as a single such lot does.
      ...(currencies[0] && lots.some((lot) => lot.currency?.trim()) ? { currency: currencies[0] } : {}),
      broker: "manual",
      ...(multiplier !== undefined ? { multiplier } : {}),
    },
  };
}
