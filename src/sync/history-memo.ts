import type { PricePoint } from "../types/financials";

export function pricePointTimeOrNull(point: PricePoint): number | null {
  const value = point.date;
  if (value == null) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/**
 * Work derived from a bar history, kept with the history. Every sync values
 * every portfolio and quotes every filed ticker (each 15 s poll, and after
 * each workspace change), and redoing that work from each holding's bars
 * blocked the view for a quarter of a second on a few hundred holdings.
 * Bars change when a history loads again, which replaces the
 * array; a last bar extended or revised in place, or one appended, is caught
 * by its length, time and close.
 */
export function historyMemo<T>(derive: (history: PricePoint[]) => T): (history: PricePoint[] | undefined) => T {
  const kept = new WeakMap<PricePoint[], { length: number; lastTime: number | null; lastClose: number | undefined; value: T }>();
  const empty = derive([]);
  return (history) => {
    if (!history || history.length === 0) return empty;
    const last = history[history.length - 1]!;
    const lastTime = pricePointTimeOrNull(last);
    const cached = kept.get(history);
    if (cached && cached.length === history.length && cached.lastTime === lastTime && cached.lastClose === last.close) return cached.value;
    const value = derive(history);
    kept.set(history, { length: history.length, lastTime, lastClose: last.close, value });
    return value;
  };
}
