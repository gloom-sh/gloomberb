import { describe, expect, test } from "bun:test";
import {
  BUFFETT_INDICATOR,
  TOBINS_Q,
  alignToDenominator,
  buildRatioSeries,
  chartYearLabels,
  classifyZone,
  fitLogLinearTrend,
  meanRatio,
  niceDomain,
  projectChart,
  projectView,
  sigmaVsTrend,
  sliceByRange,
  trendAt,
  zoneScaleBands,
  zoneScaleFraction,
  zoneScaleValueAt,
  type IndicatorBuild,
  type RatioPoint,
  type ScaledObs,
} from "./model";

function scaled(date: string, value: number): ScaledObs {
  return { date, value };
}

function series(observations: Array<{ date: string; value: number | null }>) {
  return { seriesId: "test", observations, provenance: "fred" as const };
}

function ratioPoint(date: string, ratio: number): RatioPoint {
  return { date, ratio, numeratorBillions: ratio, denominatorBillions: 100 };
}

describe("alignToDenominator", () => {
  const denominator = [scaled("2024-01-01", 20_000), scaled("2024-04-01", 22_000)];

  test("midpoint between two quarterlies is linear", () => {
    const points = alignToDenominator(BUFFETT_INDICATOR, [scaled("2024-02-15", 40_000)], denominator);
    expect(points).toHaveLength(1);
    const t0 = Date.parse("2024-01-01");
    const t1 = Date.parse("2024-04-01");
    const t = Date.parse("2024-02-15");
    const expected = 20_000 + ((t - t0) / (t1 - t0)) * (22_000 - 20_000);
    expect(points[0]!.denominatorBillions).toBeCloseTo(expected, 6);
    expect(points[0]!.ratio).toBeCloseTo((40_000 / expected) * 100, 6);
  });

  test("flat-forwards past the last denominator print", () => {
    const points = alignToDenominator(BUFFETT_INDICATOR, [scaled("2024-06-01", 44_000)], denominator);
    expect(points[0]!.denominatorBillions).toBe(22_000);
    expect(points[0]!.ratio).toBeCloseTo((44_000 / 22_000) * 100, 6);
  });

  test("drops numerator dates before the first denominator print", () => {
    const points = alignToDenominator(
      BUFFETT_INDICATOR,
      [scaled("2023-12-01", 39_000), scaled("2024-02-01", 40_000)],
      denominator,
    );
    expect(points.map((p) => p.date)).toEqual(["2024-02-01"]);
  });

  test("ratioScale of 1 leaves the quotient a bare ratio", () => {
    const points = alignToDenominator(TOBINS_Q, [scaled("2024-02-15", 40_000)], denominator);
    expect(points[0]!.ratio).toBeCloseTo(40_000 / points[0]!.denominatorBillions, 6);
    expect(points[0]!.ratio).toBeLessThan(10);
  });
});

describe("buildRatioSeries", () => {
  test("applies each leg's scaleToBillions before dividing", () => {
    // Both Z.1 legs arrive in millions, so the levels rescale but the ratio does not.
    const built = buildRatioSeries(
      TOBINS_Q,
      series([{ date: "2024-01-01", value: 60_000_000 }]),
      series([{ date: "2024-01-01", value: 40_000_000 }]),
    );
    expect(built.points).toHaveLength(1);
    expect(built.points[0]!.numeratorBillions).toBeCloseTo(60_000, 6);
    expect(built.points[0]!.denominatorBillions).toBeCloseTo(40_000, 6);
    expect(built.points[0]!.ratio).toBeCloseTo(1.5, 6);
    expect(built.denominatorVintageDate).toBe("2024-01-01");
  });

  test("throws when the two legs never overlap", () => {
    expect(() => buildRatioSeries(
      BUFFETT_INDICATOR,
      series([{ date: "2020-01-01", value: 1 }]),
      series([{ date: "2024-01-01", value: 1 }]),
    )).toThrow("no overlapping observations");
  });
});

describe("fitLogLinearTrend", () => {
  test("recovers beta and places an outlier at the expected σ", () => {
    const originMs = Date.parse("2000-01-01");
    const betaPerDay = 0.03 / 365.25;
    const points: RatioPoint[] = [];
    for (let year = 0; year <= 20; year += 1) {
      const date = `${2000 + year}-01-01`;
      const tDays = (Date.parse(date) - originMs) / 86_400_000;
      points.push(ratioPoint(date, 80 * Math.exp(betaPerDay * tDays)));
    }
    const fit = fitLogLinearTrend(points);
    expect(fit.beta).toBeCloseTo(betaPerDay, 8);
    expect(fit.sigma).toBeLessThan(1e-12);

    const outlierDate = points[10]!.date;
    const outlierRatio = trendAt(fit, outlierDate) * Math.exp(2);
    expect(sigmaVsTrend({ ...fit, sigma: 0.05 }, outlierRatio, outlierDate)).toBeCloseTo(2 / 0.05, 8);
  });
});

describe("classifyZone", () => {
  test("Buffett boundaries are half-open at 75, 90, 115, 135", () => {
    expect(classifyZone(BUFFETT_INDICATOR, 74.999).id).toBe("significantly-undervalued");
    expect(classifyZone(BUFFETT_INDICATOR, 75).id).toBe("modestly-undervalued");
    expect(classifyZone(BUFFETT_INDICATOR, 89.999).id).toBe("modestly-undervalued");
    expect(classifyZone(BUFFETT_INDICATOR, 90).id).toBe("fair");
    expect(classifyZone(BUFFETT_INDICATOR, 114.999).id).toBe("fair");
    expect(classifyZone(BUFFETT_INDICATOR, 115).id).toBe("modestly-overvalued");
    expect(classifyZone(BUFFETT_INDICATOR, 135).id).toBe("significantly-overvalued");
  });

  test("each indicator classifies in its own units", () => {
    expect(classifyZone(TOBINS_Q, 0.4).id).toBe("significantly-undervalued");
    expect(classifyZone(TOBINS_Q, 0.95).id).toBe("fair");
    expect(classifyZone(TOBINS_Q, 1.82).id).toBe("significantly-overvalued");
    // The same number means opposite things across indicators.
    expect(classifyZone(BUFFETT_INDICATOR, 0.4).id).toBe("significantly-undervalued");
    expect(classifyZone(BUFFETT_INDICATOR, 140).id).toBe("significantly-overvalued");
  });
});

describe("zone scale geometry", () => {
  test("bands cover the full scale with classifyZone's colors", () => {
    for (const indicator of [BUFFETT_INDICATOR, TOBINS_Q]) {
      const bands = zoneScaleBands(indicator);
      expect(bands[0]!.from).toBe(0);
      expect(bands.at(-1)!.to).toBe(indicator.zoneScale.max);
      for (const band of bands) {
        const probe = (band.from + band.to) / 2;
        expect(band.color).toBe(classifyZone(indicator, probe).color);
      }
    }
  });

  test("each band gets equal width so fair sits near center", () => {
    const bands = BUFFETT_INDICATOR.zones.length;
    for (let index = 0; index <= bands; index += 1) {
      const edge = BUFFETT_INDICATOR.zoneScale.edges[index]!;
      expect(zoneScaleFraction(BUFFETT_INDICATOR, edge)).toBeCloseTo(index / bands, 8);
    }
    // Parity lands inside the middle fifth rather than being pushed left by the long top band.
    const parity = zoneScaleFraction(BUFFETT_INDICATOR, 100);
    expect(parity).toBeGreaterThan(0.4);
    expect(parity).toBeLessThan(0.6);
  });

  test("fraction and value round-trip", () => {
    for (const indicator of [BUFFETT_INDICATOR, TOBINS_Q]) {
      for (const value of [0, indicator.zoneScale.max / 3, indicator.zoneScale.max]) {
        const back = zoneScaleValueAt(indicator, zoneScaleFraction(indicator, value));
        expect(back).toBeCloseTo(value, 6);
      }
    }
  });

  test("values past the top of the scale clamp to the end", () => {
    expect(zoneScaleFraction(BUFFETT_INDICATOR, 10_000)).toBe(1);
    expect(zoneScaleFraction(BUFFETT_INDICATOR, -50)).toBe(0);
  });
});

describe("niceDomain", () => {
  test("snaps up to whole grid steps in the indicator's units", () => {
    expect(niceDomain(142, 150)).toEqual({ min: 0, max: 150 });
    expect(niceDomain(214, 150)).toEqual({ min: 0, max: 300 });
    expect(niceDomain(1.82, 0.5)).toEqual({ min: 0, max: 2 });
    expect(niceDomain(0, 0.5)).toEqual({ min: 0, max: 0.5 });
  });
});

describe("projectChart", () => {
  const points = [
    ratioPoint("2020-01-01", 70),
    ratioPoint("2021-01-01", 100),
    ratioPoint("2022-01-01", 160),
  ];

  test("draws the reference and the mean as separate labelled lines", () => {
    const mean = meanRatio(points);
    const chart = projectChart(BUFFETT_INDICATOR, points, mean);
    expect(chart.markers.map((marker) => marker.label)).toEqual(["parity", "mean"]);
    const values = chart.overlays.referenceLines!.map((line) => line.value);
    expect(values).toEqual([100, mean]);
    // The mean of this window is not parity, so the two lines must not coincide.
    expect(mean).not.toBeCloseTo(100, 6);
  });

  test("colors each segment from its own zone", () => {
    const chart = projectChart(BUFFETT_INDICATOR, points, meanRatio(points));
    expect(chart.lineColors).toEqual(points.map((p) => classifyZone(BUFFETT_INDICATOR, p.ratio).color));
  });

  test("domain keeps the reference and mean on screen", () => {
    const low = [ratioPoint("2020-01-01", 10), ratioPoint("2021-01-01", 12)];
    const chart = projectChart(BUFFETT_INDICATOR, low, meanRatio(low));
    expect(chart.yDomain.max).toBeGreaterThanOrEqual(100);
  });
});

describe("chartYearLabels", () => {
  test("keeps unique years in order and thins long spans", () => {
    const points = Array.from({ length: 60 }, (_, index) => ({
      date: new Date(`${1970 + index}-06-01`),
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 0,
    }));
    const labels = chartYearLabels(points);
    expect(labels.length).toBeLessThanOrEqual(8);
    expect(labels[0]).toBe("1970");
    expect(labels.at(-1)).toBe("2029");
    expect([...labels]).toEqual([...new Set(labels)]);
  });
});

describe("projectView", () => {
  const points: RatioPoint[] = [];
  for (let year = 1990; year <= 2026; year += 1) {
    points.push(ratioPoint(`${year}-01-01`, 60 + (year - 1990) * 3));
  }
  const build: IndicatorBuild = {
    indicator: BUFFETT_INDICATOR,
    series: { indicatorId: "buffett", points, denominatorVintageDate: "2026-01-01" },
    trend: fitLogLinearTrend(points),
    cacheStale: false,
  };

  test("range changes the chart window but not the headline stats", () => {
    const short = projectView(build, "10Y", { nowMs: Date.parse("2026-02-01") });
    const all = projectView(build, "ALL", { nowMs: Date.parse("2026-02-01") });
    expect(short.current).toEqual(all.current);
    expect(short.percentile).toBe(all.percentile);
    expect(short.allTimeHigh).toEqual(all.allTimeHigh);
    expect(short.mean).toBeCloseTo(all.mean, 8);
    expect(short.chart.points.length).toBeLessThan(all.chart.points.length);
  });

  test("staleness uses the indicator's own cadence", () => {
    // Three months past the last print: overdue for a daily series, normal for Z.1,
    // whose newest observation is routinely months old by design.
    const nowMs = Date.parse("2026-04-01");
    expect(projectView(build, "ALL", { nowMs }).observationStale).toBe(true);
    const quarterly: IndicatorBuild = { ...build, indicator: TOBINS_Q };
    expect(projectView(quarterly, "ALL", { nowMs }).observationStale).toBe(false);
    // Still fresh at eight months, the real gap between consecutive Z.1 releases.
    expect(projectView(quarterly, "ALL", { nowMs: Date.parse("2026-09-02") }).observationStale)
      .toBe(false);
    // A full year with no new print is genuinely stale.
    expect(projectView(quarterly, "ALL", { nowMs: Date.parse("2027-02-01") }).observationStale)
      .toBe(true);
  });
});

describe("sliceByRange", () => {
  test("falls back to the whole series when a window leaves under two points", () => {
    const points = [ratioPoint("1990-01-01", 60), ratioPoint("1991-01-01", 62)];
    expect(sliceByRange(points, "10Y")).toHaveLength(2);
  });
});
