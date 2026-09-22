import { expect, test } from "bun:test";
import { buildCompositeChartScene } from "../../../components/chart/composite/scene";
import { buildStaticChartSeries } from "../../../components/chart/static/chart-surface";
import { volatilityCurveChartModel, volatilityHistoryChartModel, volatilityIndexHistoryPoints, volatilityRatioChartModel } from "./chart-model";

test("VIX curve uses elapsed tenor days and leaves absent interior and endpoint observations as gaps", () => {
  const curve = [9, 30, 91, 182, 365].map((days, index) => ({ days, tenor: `${days}d`, value: [17, 18, null, 22, null][index]! }));
  const model = volatilityCurveChartModel(curve);
  const scene = buildCompositeChartScene(buildStaticChartSeries(model.points, "line", "green", [], true),
    [{ id: "main" }], { width: 90, height: 12, rightOffsetRatio: 0 })!;
  const projected = scene.panels[0]!.series[0]!.points;
  expect(scene.timeScale.kind).toBe("calendar");
  expect(projected.map((point) => point.value)).toEqual([17, 18, 22]);
  expect(projected.map((point) => point.breakBefore)).toEqual([true, false, true]);
  for (const [index, days] of [9, 30, 182].entries()) {
    expect(projected[index]!.xRatio).toBeCloseTo((days - 9) / (365 - 9), 12);
  }
  expect(model.ticks.map((tick) => tick.ratio)).toEqual([9, 30, 91, 182, 365].map((days) => (days - 9) / 356));
  expect(model.formatCursor(1)).toBe("365 days");
});

test("FRED history aligns observations by date and breaks each curve where the peer has a missing close", () => {
  const fred = { metrics: [
    { seriesId: "VIXCLS", history: [{ date: "2026-09-01", value: 20 }, { date: "2026-09-03", value: 22 }, { date: "2026-09-04", value: 23 }] },
    { seriesId: "VXVCLS", history: [{ date: "2026-09-01", value: 24 }, { date: "2026-09-02", value: 25 }, { date: "2026-09-04", value: 26 }] },
  ], ratioHistory: [{ date: "2026-09-01", value: 1.2 }, { date: "2026-09-04", value: 26 / 23 }] };
  const model = volatilityHistoryChartModel(fred, "orange");
  const scene = buildCompositeChartScene(buildStaticChartSeries(model.points, "line", "green", model.overlays, true),
    [{ id: "main" }], { width: 90, height: 12, rightOffsetRatio: 0 })!;
  expect(model.points.map((point) => point.date.toISOString().slice(0, 10))).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
  expect(scene.panels[0]!.series[0]!.points.map((point) => point.breakBefore)).toEqual([true, true, false]);
  expect(model.overlays.map((overlay) => overlay.points.map((point) => point.index))).toEqual([[0, 1], [3]]);
  expect(model.overlays[1]!.style).toBe("points");
  const ratio = volatilityRatioChartModel(fred, "gray");
  const ratioScene = buildCompositeChartScene(buildStaticChartSeries(ratio.points, "line", "green", ratio.overlays, true),
    [{ id: "main" }], { width: 90, height: 8, rightOffsetRatio: 0 })!;
  expect(ratioScene.panels[0]!.series[0]!.points.map((point) => point.breakBefore)).toEqual([true, true]);
  expect(ratio.overlays[0]!.points).toEqual([{ index: 0, value: 1 }, { index: 3, value: 1 }]);
});

test("withdrawn dates missing from both histories still break the curves and board history", () => {
  const history = [{ date: "2026-09-01", value: 20 }, { date: "2026-09-03", value: 22 }];
  const missingDates = ["2026-09-02"];
  const fred = { metrics: ["VIXCLS", "VXVCLS"].map((seriesId) => ({ seriesId, history, missingDates })),
    ratioHistory: history.map(({ date }) => ({ date, value: 1 })),
  };
  const model = volatilityHistoryChartModel(fred, "orange");
  expect(model.points).toHaveLength(3);
  expect(Number.isNaN(model.points[1]!.close)).toBe(true);
  expect(model.overlays.map((overlay) => overlay.points.map((point) => point.index))).toEqual([[0], [2]]);
  expect(Number.isNaN(volatilityRatioChartModel(fred, "gray").points[1]!.close)).toBe(true);
  expect(Number.isNaN(volatilityIndexHistoryPoints(history, missingDates)[1]!.close)).toBe(true);
});
