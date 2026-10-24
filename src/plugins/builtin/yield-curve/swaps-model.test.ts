import { describe, expect, test } from "bun:test";
import { formatSwapBp, swapCurveSeries, swapHistorySeries, validateSwapCurve } from "./swaps-model";
import { swapFixture } from "./test-fixture-swaps";
import { fetchSwapCurve } from "./client";

describe("SOFR chart observations", () => {
  test("keeps missing tenors in both dated curves and missing history sessions on their actual dates", () => {
    const payload = validateSwapCurve(swapFixture());
    const curves = swapCurveSeries(payload, { current: "green", thin: "amber", ghosts: { "1W": "gray" } });
    expect(curves).toHaveLength(4);
    expect(curves[0]!.points.map((point) => point.id)).toEqual(payload.points.map((point) => point.tenor));
    expect(curves[0]!.points[3]).toMatchObject({ id: "5Y", x: 5, value: null });
    expect(curves[1]).toMatchObject({ id: "1W", asOf: "2026-10-13" });
    expect(curves[1]!.points[3]!.value).toBeNull();
    const history = swapHistorySeries(payload.history, "green", "amber")[0]!;
    expect(history.interpolation).toBe("none");
    expect(history.timeBasis).toBeUndefined();
    expect(history.points.map((point) => [point.date.toISOString().slice(0, 10), point.value])).toEqual([
      ["2026-10-16", 3.95], ["2026-10-19", null], ["2026-10-20", 4],
    ]);
  });

  test("marks thin observations in all curves and plots history as separate points with a gap in the firm line", () => {
    const payload = swapFixture();
    payload.points[0] = { ...payload.points[0]!, tradeCount: 3, quality: "thin" };
    payload.comparisons.week.points[1] = { ...payload.comparisons.week.points[1]!, tradeCount: 4, quality: "thin" };
    payload.history.points[0] = { ...payload.history.points[0]!, tradeCount: 3, quality: "thin" };
    const curves = swapCurveSeries(payload, { current: "green", thin: "amber", ghosts: { "1W": "gray" } });
    expect(curves.filter((series) => series.role === "marker").map((series) => [series.id, series.color, series.points[0]!.id]))
      .toEqual([["sofr-thin", "amber", "1Y"], ["1W-thin", "amber", "2Y"]]);
    const history = swapHistorySeries(payload.history, "green", "amber");
    expect(history[0]!.points[0]!.value).toBeNull();
    expect(history[1]).toMatchObject({ label: "Thin", style: "points", color: "amber", interpolation: "none" });
    expect(history[1]!.points.map((point) => point.value)).toEqual([3.95, null, null]);
    expect(history[1]!.points[0]!.date.toISOString().slice(0, 10)).toBe("2026-10-16");
  });

  test("rejects undated rates, insufficient published samples, fabricated 15Y spreads and unsorted history", () => {
    const undated = swapFixture(); undated.asOf = null;
    const smallSample = swapFixture(); smallSample.points[0]!.tradeCount = 2;
    const interpolated = swapFixture(); interpolated.points[6]!.spreadBp = -10;
    const unsorted = swapFixture(); unsorted.history.points.reverse();
    const duplicates = swapFixture(); duplicates.points[1] = duplicates.points[0]!;
    for (const invalid of [undated, smallSample, interpolated, unsorted, duplicates]) {
      expect(() => validateSwapCurve(invalid)).toThrow("invalid SOFR swap observations");
    }
  });

  test("basis-point values remain in bp with neutral rounded zero", () => {
    expect(formatSwapBp(1.2)).toBe("+1.2bp");
    expect(formatSwapBp(-20.5)).toBe("-20.5bp");
    expect(formatSwapBp(-0.01)).toBe("0.0bp");
  });

  test("a response for a previous tenor cannot enter the selected tenor's cache", async () => {
    await expect(fetchSwapCurve("2Y", { getCloudSwapCurve: async () => swapFixture("10Y") }))
      .rejects.toThrow("different swap tenor");
  });
});
