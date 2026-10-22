import { expect, test } from "bun:test";
import { buildStaticChartSeries } from "../../../components/chart/static/chart-surface";
import { buildCompositeChartScene } from "../../../components/chart/composite/scene";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";

const FIVE_MINUTES = 5 * 60_000;

function bars(): ProjectedChartPoint[] {
  const start = Date.parse("2026-10-05T08:00:00Z");
  return [0, 1, 6, 18].map((step) => {
    const close = 7800 + step;
    return {
      date: new Date(start + step * FIVE_MINUTES),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1,
    };
  });
}

test("the ES session chart reads New York and keeps five-minute gaps", () => {
  const series = buildStaticChartSeries(bars(), "candles", "#00ff00", [], true, {
    timeZone: "America/New_York",
    cadenceMs: FIVE_MINUTES,
  });
  const scene = buildCompositeChartScene(series, [{ id: "main" }], { width: 80, height: 12 });
  expect(scene?.timeZone).toBe("America/New_York");
  expect(series[0]?.timeBasis).toEqual({ kind: "market", timeZone: "America/New_York", cadenceMs: FIVE_MINUTES });
  const points = scene?.panels[0]?.series[0]?.points ?? [];
  const ratios = points.map((point) => point.xRatio);
  const firstGap = ratios[1]! - ratios[0]!;
  const sixSteps = ratios[2]! - ratios[0]!;
  expect(sixSteps / firstGap).toBeCloseTo(6, 5);
});
