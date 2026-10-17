import { expect, test } from "bun:test";
import { formatMoveRank, latestMoveRank, MOVE_RANK_MIN_OBSERVATIONS, seriesMoves } from "./move-rank";

const DAY_MS = 86_400_000;
const dayAfter = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

test("a move skips a holiday, never spans a discontinued stretch, and a week is seven calendar days back", () => {
  const observations = [
    { date: "2026-09-01", value: 5 },
    { date: "2026-09-02", value: 5.02 },
    { date: "2026-09-03", value: 5.01 },
    { date: "2026-09-07", value: null }, // Labor Day's blank
    { date: "2026-09-08", value: 4.97 },
    { date: "2026-09-09", value: 4.99 },
    { date: "2026-09-10", value: 5.04 },
  ];
  // 5.02 - 5 is 0.02, not 0.020000000000000462, so equal moves tie.
  expect(seriesMoves(observations, "1D")).toEqual([
    { date: "2026-09-02", from: "2026-09-01", change: 0.02 },
    { date: "2026-09-03", from: "2026-09-02", change: -0.01 },
    { date: "2026-09-08", from: "2026-09-03", change: -0.04 },
    { date: "2026-09-09", from: "2026-09-08", change: 0.02 },
    { date: "2026-09-10", from: "2026-09-09", change: 0.05 },
  ]);
  expect(seriesMoves(observations, "1W")).toEqual([
    { date: "2026-09-08", from: "2026-09-01", change: -0.03 },
    { date: "2026-09-09", from: "2026-09-02", change: -0.03 },
    { date: "2026-09-10", from: "2026-09-03", change: 0.03 },
  ]);
  // Four years without a 30-year bond are no move.
  expect(seriesMoves([{ date: "2002-02-15", value: 5.4 }, { date: "2006-02-09", value: 4.5 }], "1D")).toEqual([]);
});

test("the latest move ranks by size against every move of its horizon, ties counted half, once a year of them exists", () => {
  // 100 flat days, 100 a basis point up or down, 99 three down, then the latest one down.
  const steps = [
    ...Array.from({ length: 100 }, () => 0),
    ...Array.from({ length: 100 }, (_, index) => (index % 2 ? 0.01 : -0.01)),
    ...Array.from({ length: 99 }, () => -0.03),
    -0.01,
  ];
  let value = 5;
  const observations = [{ date: "2025-01-01", value }];
  for (const [index, step] of steps.entries()) {
    value += step;
    observations.push({ date: dayAfter("2025-01-01", index + 1), value });
  }
  const rank = latestMoveRank(observations, "1D")!;
  expect(rank).toMatchObject({ change: -0.01, observations: 300, since: "2025-01-02" });
  // Smaller: the 100 flat days. Ties: the 100 one-bp days and the latest.
  expect(rank.percentile).toBeCloseTo((100 * (100 + 101 / 2)) / 300, 6);
  expect(formatMoveRank(rank)).toBe("50 pctl since 2025");
  // A short history keeps its move but is not ranked.
  const short = latestMoveRank(observations.slice(-MOVE_RANK_MIN_OBSERVATIONS), "1D")!;
  expect(short).toMatchObject({ change: -0.01, percentile: null, observations: MOVE_RANK_MIN_OBSERVATIONS - 1 });
  expect(formatMoveRank(short)).toBeNull();
  // A latest observation with nothing within ten days before it has no move to rank.
  expect(latestMoveRank([...observations, { date: dayAfter("2025-10-28", 30), value: 4 }], "1D")).toBeNull();
});
