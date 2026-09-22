import { describe, expect, test } from "bun:test";
import type { PricePoint } from "../../../types/financials";
import { buildVolatilityData, type VolatilityHistoryInput, type VolatilitySeriesInput } from "./model";

function history(rows: Array<[string, number]>, source = "yahoo"): VolatilityHistoryInput {
  return { source, history: rows.map(([date, close]) => ({ date: new Date(date), close })) };
}
function fred(rows: Array<[string, number | null]>, observationEnd?: string): VolatilitySeriesInput {
  return { observations: rows.map(([date, value]) => ({ date, value })), info: observationEnd ? {
    id: "VIXCLS", title: "VIX", units: "Index", frequency: "Daily, Close",
    seasonalAdjustment: "Not Seasonally Adjusted", source: "FRED", notes: "", observationEnd,
  } : null };
}
const row = (input: VolatilityHistoryInput) => buildVolatilityData({ history: { vix: input } }).board.find((item) => item.id === "vix")!;

describe("dated volatility sources", () => {
  test("anchors all cash tenors to the latest shared core date independently of lagging FRED", () => {
    const data = buildVolatilityData({ history: {
      vix9d: history([["2026-09-21", 15]]),
      vix: history([["2026-09-18", 18], ["2026-09-21", 20], ["2026-09-22", 24]]),
      vix3m: history([["2026-09-18", 20], ["2026-09-21", 22]]),
      vix6m: history([["2026-09-18", 24]]),
      vix1y: history([["2026-09-21", 26]]),
    }, fred: { VIXCLS: fred([["2026-09-18", 18]], "2026-09-17"), VXVCLS: fred([["2026-09-18", 20]]) } });
    expect(data.curve.date).toBe("2026-09-21");
    expect(data.curve.points.map((point) => point.value)).toEqual([15, 20, 22, null, 26]);
    expect(data.curve.ratio).toBe(1.1);
    expect(data.curve.slope).toBe(2);
    expect(data.curve.termState).toBe("normal");
    expect(data.curve.source).toBe("market-history");
    expect(data.curve.points.map((point) => point.source)).toEqual(Array(5).fill("yahoo"));
    expect(data.fred.termDate).toBe("2026-09-18");
    expect(data.fred.metrics[0]).toMatchObject({ date: "2026-09-18", observationEnd: "2026-09-17" });
    expect(data.board.find((item) => item.id === "vix")).toMatchObject({ date: "2026-09-22", value: 24 });
    expect(data.board.find((item) => item.id === "vix1y")).toMatchObject({ value: 26, change1d: null, percentile1y: null, sampleSize: 1 });
  });

  test("falls back to a dated FRED pair only when both market core histories are absent", () => {
    const inputs = { fred: { VIXCLS: fred([["2026-09-17", 24], ["2026-09-18", 25]]),
      VXVCLS: fred([["2026-09-17", 20]]) } };
    const fallback = buildVolatilityData({ ...inputs, history: { vix9d: history([["2026-09-21", 19]]) } });
    expect(fallback.curve).toMatchObject({ source: "fred", date: "2026-09-17", ratio: 20 / 24, slope: -4, termState: "inverted" });
    expect(fallback.curve.points.map((point) => [point.sourceId, point.value])).toEqual([["VIXCLS", 24], ["VXVCLS", 20]]);
    const partial = buildVolatilityData({ ...inputs, history: { vix: history([["2026-09-21", 30]]) } });
    expect(partial.curve).toMatchObject({ source: "market-history", date: "2026-09-21", ratio: null, termState: "partial" });
    expect(partial.curve.points.map((point) => point.value)).toEqual([null, 30, null, null, null]);
    const unmatched = buildVolatilityData({ fred: { VIXCLS: fred([["2026-09-18", 18]]), VXVCLS: fred([["2026-09-17", 20]]) } });
    expect(unmatched.fred).toMatchObject({ termDate: null, ratio: null, ratioHistory: [], termState: "partial" });
  });

  test("deduplicates corrections and retains withdrawn dates without bridging daily changes", () => {
    const point = (date: string | Date, close: number) => ({ date, close } as PricePoint);
    const result = row({ source: "router", stale: true, error: "refresh failed", history: [
      point("2026-09-18T14:00:00Z", 18), point("2026-09-18T20:00:00Z", 20),
      point("2026-09-19", 21), point("2026-09-19", 0), point("2026-09-20", -2),
      point("2026-09-21", 25), point("2026-09-22", Number.NaN),
      point("2026-02-30", 999), point("wrong date", 999), point(new Date(NaN), 999),
    ] });
    expect(result.history).toEqual([
      { date: "2026-09-18", observedAt: "2026-09-18T20:00:00.000Z", value: 20 },
      { date: "2026-09-21", observedAt: "2026-09-21T00:00:00.000Z", value: 25 },
    ]);
    expect(result.missingDates).toEqual(["2026-09-19", "2026-09-20", "2026-09-22"]);
    expect(result).toMatchObject({ date: "2026-09-21", value: 25, change1d: null,
      percentile1y: null, status: "limited", stale: true, error: "refresh failed", source: "router" });
    expect(result.warnings.join(" ")).toContain("Latest supplied close unavailable");
    expect(result.warnings.join(" ")).toContain("Malformed observation dates");
  });

  test("retains dates withdrawn by both FRED series so charts can preserve the gap", () => {
    const data = buildVolatilityData({ fred: {
      VIXCLS: fred([["2026-09-17", 10], ["2026-09-18", 15], ["2026-09-18", null], ["2026-09-21", 20], ["2026-02-30", 99]]),
      VXVCLS: fred([["2026-09-17", 15], ["2026-09-18", null], ["2026-09-21", 20]]),
    } });
    expect(data.fred.metrics.map((metric) => metric.missingDates)).toEqual([["2026-09-18"], ["2026-09-18"]]);
    expect(data.fred.ratioHistory).toEqual([{ date: "2026-09-17", value: 1.5 }, { date: "2026-09-21", value: 1 }]);
    expect(data.fred.termState).toBe("flat");
  });
});

describe("cross-asset daily statistics", () => {
  test("requires broad coverage for a percentile and uses midrank for ties", () => {
    const start = Date.UTC(2025, 9, 20);
    const spaced = (count: number, span: number, flat = false) => ({ source: "yahoo", history: Array.from({ length: count }, (_, index) => ({
      date: new Date(start + Math.round(index * span / (count - 1)) * 86400000), close: flat ? 20 : index + 1,
    })) });
    expect(row(spaced(199, 300)).percentile1y).toBeNull();
    expect(row(spaced(200, 299)).percentile1y).toBeNull();
    expect(row(spaced(200, 300)).percentile1y).toBe(99.75);
    expect(row(spaced(200, 300, true)).percentile1y).toBe(50);
    const broad = spaced(220, 335);
    broad.history.unshift({ date: new Date("2024-01-01"), close: 999 });
    expect(row(broad)).toMatchObject({ sampleSize: 220, coverageDays: 335, percentile1y: 100 * 219.5 / 220 });
  });

  test("permits a weekend daily change but not a long missing interval or invalid previous close", () => {
    expect(row(history([["2026-09-18", 20], ["2026-09-21", 22]])))
      .toMatchObject({ change1d: 2, change1dPercent: 10, previousDate: "2026-09-18" });
    expect(row(history([["2026-09-14", 20], ["2026-09-21", 22]])).change1d).toBeNull();
    expect(row(history([["2026-09-18", 20], ["2026-09-20", 0], ["2026-09-21", 22]])).change1d).toBeNull();
    expect(row(history([["2026-09-18", 0], ["2026-09-21", Infinity]])))
      .toMatchObject({ value: null, date: null, change1d: null, percentile1y: null, status: "unavailable" });
  });
});
