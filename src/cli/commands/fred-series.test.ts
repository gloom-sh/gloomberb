import { expect, test } from "bun:test";
import { fredEmptyMessage, fredHistoryNotes, isSpreadSeries, laggingSeriesNote, spreadBasisPointsCell } from "./fred-series";

test("spreads print in basis points, FRED's other series as they come", () => {
  expect(["t10y2y", "T10Y3M", "BAMLH0A0HYM2", "DGS10", "T10YIE"].map(isSpreadSeries)).toEqual([true, true, true, false, false]);
  expect([0.44, -0.125, 0.07, null, "n/a"].map(spreadBasisPointsCell)).toEqual(["44", "-12.5", "7", "", ""]);
});

test("says where the history starts when the default start hides older data, or the series begins after the start asked for", () => {
  const input = { startDate: "2021-01-01", startGiven: false, seriesStart: "1976-06-01" };
  expect(fredHistoryNotes(input)).toEqual(["Showing from 2021-01-01; earlier: --start YYYY-MM-DD (series begins 1976-06-01)."]);
  // A start the caller chose needs no pointer, but a series that begins later says so.
  expect(fredHistoryNotes({ ...input, startGiven: true })).toEqual([]);
  expect(fredHistoryNotes({ ...input, startDate: "1960-01-01", startGiven: true })).toEqual(["Series begins 1976-06-01."]);
  // A series that begins after the default start is not hidden by it.
  expect(fredHistoryNotes({ ...input, seriesStart: "2023-02-01" })).toEqual(["Series begins 2023-02-01."]);
  // Without metadata nothing is claimed.
  expect(fredHistoryNotes({ ...input, seriesStart: undefined })).toEqual([]);
  expect(fredHistoryNotes({ ...input, seriesStart: "not a date" })).toEqual([]);
});

test("an empty window names the latest observation, or says no results when there is none", () => {
  expect(fredEmptyMessage("2026-10-11", { date: "2026-10-09", value: 5.24 }))
    .toBe("Latest observation: 2026-10-09 (5.24). Nothing on or after 2026-10-11.");
  expect(fredEmptyMessage("2026-10-11", { date: "2026-10-09", value: null })).toBe("Latest observation: 2026-10-09. Nothing on or after 2026-10-11.");
  expect(fredEmptyMessage("2026-10-11", null)).toBe("No results.");
});

test("a lagging series carries its note, in any case", () => {
  expect(laggingSeriesNote("umcsent")).toContain("fn ECO");
  expect(laggingSeriesNote("DGS10")).toBeNull();
});
