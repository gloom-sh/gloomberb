import { expect, test } from "bun:test";
import { startAtOldestObservation } from "./chart-bounds";
import type { ResolvedSeries } from "./types";

const DAY = 86_400_000;
const series = (start: string, count: number, stepDays: number) => ({
  id: start, label: start, unit: "bp", unitGroup: "series:bp",
  points: Array.from({ length: count }, (_, index) => ({ date: new Date(Date.parse(`${start}T00:00:00Z`) + index * stepDays * DAY), value: 100 + index })),
}) as unknown as ResolvedSeries;

test("a dataset chart opens at its oldest observation when every series starts well inside the range", () => {
  // 5Y from Sun 8 Nov 2026; FRED keeps the ICE spreads from Nov 2023.
  const fiveYears = { start: Date.parse("2021-11-08T00:00:00Z"), end: Date.parse("2026-11-06T00:00:00Z") };
  const ice = series("2023-11-06", 1_000, 1);
  expect(startAtOldestObservation(fiveYears, [ice])).toEqual({ start: Date.parse("2023-11-06T00:00:00Z"), end: fiveYears.end });
  // The earliest series sets it: CDX from Sep 2024 beside the spreads.
  expect(startAtOldestObservation(fiveYears, [series("2024-09-30", 500, 1), ice]).start).toBe(Date.parse("2023-11-06T00:00:00Z"));
  // A quarterly series whose first quarter in the range falls a month in, or one with history before it, is left alone.
  expect(startAtOldestObservation(fiveYears, [series("2022-01-01", 20, 91)])).toBe(fiveYears);
  expect(startAtOldestObservation(fiveYears, [series("2020-01-01", 2_000, 1)])).toBe(fiveYears);
  // ALL has no start to move.
  expect(startAtOldestObservation({ start: null, end: fiveYears.end }, [ice])).toEqual({ start: null, end: fiveYears.end });
});
