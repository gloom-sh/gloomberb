import { expect, test } from "bun:test";
import type { PricePoint } from "../../../types/financials";
import { estimateKellyHistoryInputs, KELLY_HISTORY_PERIOD_SESSIONS } from "./history";

const DAY_MS = 24 * 60 * 60_000;
const LAST = Date.parse("2026-10-09T20:00:00Z");

/** Daily closes, one a calendar day back from LAST, flat inside each 21-session block and moving `moves` between them, oldest first. */
function closes(moves: number[]): PricePoint[] {
  const blockCloses = moves.reduce((path, move) => [...path, path.at(-1)! * (1 + move)], [100]);
  const sessions = moves.length * KELLY_HISTORY_PERIOD_SESSIONS + 1;
  return Array.from({ length: sessions }, (_, index) => ({
    date: new Date(LAST - (sessions - 1 - index) * DAY_MS),
    close: blockCloses[Math.ceil(index / KELLY_HISTORY_PERIOD_SESSIONS)]!,
  }));
}

test("monthly returns are counted back from the last close, and the lookback cuts the oldest", () => {
  const moves = Array.from({ length: 24 }, (_, index) => index % 3 === 2 ? -0.05 : 0.1);
  const inputs = estimateKellyHistoryInputs(closes(moves), 5)!;
  expect(inputs.periods).toBe(24);
  expect(inputs.wins).toBe(16);
  expect(inputs.winProbability).toBeCloseTo(16 / 24, 10);
  expect(inputs.upsideReturn).toBeCloseTo(0.1, 10);
  expect(inputs.downsideReturn).toBeCloseTo(-0.05, 10);
  expect(inputs.end).toBe("2026-10-09");
  expect(inputs.start).toBe(new Date(LAST - 24 * KELLY_HISTORY_PERIOD_SESSIONS * DAY_MS).toISOString().slice(0, 10));

  // One calendar year of these daily points holds 17 whole blocks back from the last close.
  const year = estimateKellyHistoryInputs(closes(moves), 1)!;
  expect(year.periods).toBe(17);
  expect(Date.parse(year.start)).toBeGreaterThanOrEqual(LAST - 366 * DAY_MS);
  // Out-of-order and unusable points are ignored rather than read as moves.
  const noisy = [...closes(moves)].reverse().concat([{ date: new Date(LAST - DAY_MS / 2), close: Number.NaN }]);
  expect(estimateKellyHistoryInputs(noisy, 5)).toEqual(inputs);
});

test("too few months, or no history, gives no inputs instead of a size", () => {
  expect(estimateKellyHistoryInputs(closes([0.1, -0.05, 0.1, 0.02, -0.01]), 5)).toBeNull();
  expect(estimateKellyHistoryInputs([], 5)).toBeNull();
});
