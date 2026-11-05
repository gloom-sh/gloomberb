import { expect, test } from "bun:test";
import type { PricePoint } from "../../../types/financials";
import { estimateKellyHistoryInputs } from "./history";

const DAY_MS = 24 * 60 * 60_000;
/** 9 Oct 2026: September is the newest month that has ended. */
const NOW = Date.parse("2026-10-09T12:00:00Z");

/**
 * Daily closes at 00:00 UTC from 1 Jan 2024 through 8 Oct 2026, every day or
 * weekdays only: month n (January 2024 is 0, at 100) trades `moves(n)` above
 * the month before, flat inside the month. October is in progress and moves
 * too, which must not count.
 */
function closes(moves: (month: number) => number, weekdaysOnly = false): PricePoint[] {
  const points: PricePoint[] = [];
  let close = 100;
  let month = -1;
  for (let time = Date.parse("2024-01-01T00:00:00Z"); time < NOW - DAY_MS / 2; time += DAY_MS) {
    const date = new Date(time);
    const index = (date.getUTCFullYear() - 2024) * 12 + date.getUTCMonth();
    if (index !== month) {
      if (month >= 0) close *= 1 + moves(index);
      month = index;
    }
    if (weekdaysOnly && (date.getUTCDay() === 0 || date.getUTCDay() === 6)) continue;
    points.push({ date, close });
  }
  return points;
}

test("returns are calendar months, month-end close to month-end close, whether the asset trades every day or on weekdays", () => {
  // Up 10% two months in three, down 5% the third; the month in progress (October) jumps 50%.
  const moves = (month: number) => month === 33 ? 0.5 : month % 3 === 2 ? -0.05 : 0.1;
  const coin = estimateKellyHistoryInputs(closes(moves), 5, { now: NOW })!;
  // January 2024 to September 2026 is 33 month-ends, so 32 returns: none of October's.
  expect(coin).toMatchObject({ periods: 32, start: "2024-01-31", end: "2026-09-30" });
  expect(coin.wins).toBe(21);
  expect(coin.upsideReturn).toBeCloseTo(0.1, 10);
  expect(coin.downsideReturn).toBeCloseTo(-0.05, 10);
  // A weekday-only listing is sized on the same months, its month-ends the last weekday.
  const stock = estimateKellyHistoryInputs(closes(moves, true), 5, { now: NOW })!;
  expect(stock).toMatchObject({ periods: 32, wins: 21, start: "2024-01-31", end: "2026-09-30" });
  // A one-year lookback is the newest 12 months.
  expect(estimateKellyHistoryInputs(closes(moves), 1, { now: NOW })).toMatchObject({ periods: 12, start: "2025-09-30" });
  // Out-of-order and unusable points are ignored rather than read as moves.
  const noisy = [...closes(moves)].reverse().concat([{ date: new Date(NOW - DAY_MS), close: Number.NaN }]);
  expect(estimateKellyHistoryInputs(noisy, 5, { now: NOW })).toEqual(coin);
});

test("too few months, or no history, or no gain or no loss gives no inputs instead of a size", () => {
  const recent = closes((month) => (month % 2 ? 0.1 : -0.05)).filter((point) => point.date.getTime() >= Date.parse("2026-04-01"));
  // April to September: five returns.
  expect(estimateKellyHistoryInputs(recent, 5, { now: NOW })).toBeNull();
  expect(estimateKellyHistoryInputs([], 5, { now: NOW })).toBeNull();
  expect(estimateKellyHistoryInputs(closes(() => 0.1), 5, { now: NOW })).toBeNull();
  expect(estimateKellyHistoryInputs(closes(() => -0.05), 5, { now: NOW })).toBeNull();
});
