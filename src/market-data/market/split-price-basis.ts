import type { SplitAction } from "../../types/financials";
import { barCloseDay } from "./period-return";

const DAY_MS = 86_400_000;
const SPLIT_NEIGHBORHOOD_MS = 10 * DAY_MS;
const LARGE_MOVE = 5;

export interface PriceBasisBreak {
  day: string;
  ratio: number;
  kind: "close" | "range";
  split?: SplitAction;
}

interface PriceBasisBar {
  date: string;
  close?: number | null;
  high?: number | null;
  low?: number | null;
}

function positive(price?: number | null): price is number {
  return price != null && Number.isFinite(price) && price > 0;
}

/** Flag inconsistencies in the served prices, without treating an observed discontinuity as a split. */
export function priceBasisBreaks(
  bars: readonly PriceBasisBar[], splits: readonly SplitAction[],
  options: { interval?: string | null; venue?: string; includeUnrecorded?: boolean; includeUnrecordedRange?: boolean } = {},
): PriceBasisBreak[] {
  const dated = splits.filter(({ fromFactor, toFactor }) => Number.isInteger(fromFactor) && Number.isInteger(toFactor)
    && fromFactor! > 0 && toFactor! > 0 && fromFactor !== toFactor)
    .map((split) => ({ split, time: Date.parse(split.date.slice(0, 10)) }));
  if (!dated.length && !options.includeUnrecorded && !options.includeUnrecordedRange) return [];
  const breaks: PriceBasisBreak[] = [];
  let previous: number | null = null;
  for (const bar of bars) {
    const day = bar.date.slice(0, 10);
    const ratio = previous !== null && positive(bar.close) ? bar.close / previous : 1;
    if (positive(bar.close)) previous = bar.close;
    const range = positive(bar.high) && positive(bar.low) ? bar.high / bar.low : 1;
    const closeBreak = ratio > LARGE_MOVE || ratio < 1 / LARGE_MOVE;
    if (!closeBreak && range <= LARGE_MOVE) continue;
    const first = Date.parse(day);
    const last = Date.parse(barCloseDay(day, options.interval ?? undefined, options.venue));
    const split = dated.find(({ time }) => time >= first - SPLIT_NEIGHBORHOOD_MS && time <= last + SPLIT_NEIGHBORHOOD_MS)?.split;
    if (closeBreak && (split || options.includeUnrecorded)) breaks.push({ day, ratio, kind: "close", split });
    else if (range > LARGE_MOVE && (split || options.includeUnrecordedRange)) breaks.push({ day, ratio: range, kind: "range", split });
  }
  return breaks;
}

export function priceBasisFactor(ratio: number): string {
  return String(Number(Math.max(ratio, 1 / ratio).toPrecision(3)));
}
