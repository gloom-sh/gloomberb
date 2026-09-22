import { expect, test } from "bun:test";
import type {
  EstimateObservation,
  EstimateSurprise,
} from "../../../api-client/estimate-revisions";
import {
  nextEstimateSort,
  sortEstimateHistory,
  sortEstimateSurprises,
} from "./sorting";

const observation = (
  date: string,
  average: number | null,
  source: EstimateObservation["source"] = "yahoo",
): EstimateObservation => ({
  date,
  average,
  source,
  recordedAt: null,
  low: null,
  high: null,
  analysts: null,
  range: null,
  relativeRange: null,
});

test("history sorts numerically with unavailable observations last in both directions and deterministic ties", () => {
  const rows = [
    observation("2026-09-21", null),
    observation("2026-09-20", 0),
    observation("2026-09-19", -2),
    observation("2026-09-20", 0, "yahoo-eps-trend"),
  ];
  expect(
    sortEstimateHistory(rows, { column: "average", direction: "asc" }).map(
      (row) => row.average,
    ),
  ).toEqual([-2, 0, 0, null]);
  const descending = sortEstimateHistory(rows, {
    column: "average",
    direction: "desc",
  });
  expect(descending.map((row) => row.average)).toEqual([0, 0, -2, null]);
  expect(descending.slice(0, 2).map((row) => row.source)).toEqual([
    "yahoo",
    "yahoo-eps-trend",
  ]);
  expect(rows[0]?.average).toBeNull();
  expect(
    sortEstimateHistory(rows, { column: "unknown", direction: "desc" })[0]
      ?.date,
  ).toBe("2026-09-21");
});

test("surprise sorting preserves a measured zero, negative surprise, missing ranks and header direction changes", () => {
  const row = (date: string, percent: number | null): EstimateSurprise => ({
    date,
    percent,
    dateType: "announcement",
    currency: "USD",
    estimate: 1,
    actual: null,
    difference: null,
    percentile: null,
    samples: 1,
    source: "Yahoo",
  });
  const rows = [
    row("2026-09-21", null),
    row("2026-09-20", -10),
    row("2026-09-19", 0),
  ];
  const descending = nextEstimateSort(
    { column: "date", direction: "desc" },
    "percent",
  );
  expect(
    sortEstimateSurprises(rows, descending).map((value) => value.percent),
  ).toEqual([0, -10, null]);
  const ascending = nextEstimateSort(descending, "percent");
  expect(
    sortEstimateSurprises(rows, ascending).map((value) => value.percent),
  ).toEqual([-10, 0, null]);
  expect(
    sortEstimateSurprises(rows, {
      column: "percentile",
      direction: "desc",
    }).map((value) => value.date),
  ).toEqual(["2026-09-19", "2026-09-20", "2026-09-21"]);
});
