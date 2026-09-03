import { describe, expect, test } from "bun:test";
import { buildScatterChartModel } from "./scatter-chart-surface";

const palette = {
  bgColor: "#000000",
  gridColor: "#333333",
  axisColor: "#777777",
  pointColor: "#b197fc",
  highlightColor: "#ff0000",
};

describe("buildScatterChartModel", () => {
  test("splits highlights, marks the zero axes, and clips the fit line to the data", () => {
    const model = buildScatterChartModel(
      [{ x: -2, y: -1 }, { x: 1, y: 0.5 }, { x: 2, y: 3, highlight: true }],
      { slope: 2, intercept: 1, color: "#ffd43b" },
      palette,
    )!;
    const ids = model.series.map((series) => series.id);
    expect(ids).toEqual(["zero-y", "regression", "points", "highlight"]);
    expect(model.markers).toEqual([{ id: "zero-x", xRatio: 0.5, color: "#777777" }]);

    const fit = model.series.find((series) => series.id === "regression")!;
    const values = fit.points.map((point) => point.value);
    // y = 2x + 1 leaves the data's [-1, 3] range at x = -1 and x = 1.
    expect(values).toEqual([-1, 3]);
    expect(fit.points.map((point) => point.date.getTime() / 1_000_000)).toEqual([-1, 1]);
    expect(model.series.find((series) => series.id === "highlight")?.points).toHaveLength(1);
  });
});
