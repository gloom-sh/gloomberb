import { describe, expect, test } from "bun:test";
import {
  BUFFETT_INDICATOR,
  EXCESS_CAPE_YIELD,
  INDICATORS,
  SHILLER_CAPE,
  SP500_DIVIDEND_YIELD,
  TOBINS_Q,
  alignToDenominator,
  buildValuationSeries,
  chartYearLabels,
  classifyZone,
  fitTrend,
  meanRatio,
  niceDomain,
  projectChart,
  projectView,
  resolveIndicatorArg,
  sigmaVsTrend,
  sliceByRange,
  trendAt,
  zoneScaleBands,
  zoneScaleFraction,
  zoneScaleValueAt,
  type DatedSeries,
  type IndicatorBuild,
  type RatioPoint,
  type ScaledObs,
} from "./model";

function scaled(date: string, value: number): ScaledObs {
  return { date, value };
}

function series(observations: Array<{ date: string; value: number | null }>): DatedSeries {
  return { seriesId: "test", observations, provenance: "fred" };
}

function ratioPoint(date: string, ratio: number): RatioPoint {
  return { date, ratio };
}

describe("alignToDenominator", () => {
  const denominator = [scaled("2024-01-01", 20_000), scaled("2024-04-01", 22_000)];

  test("midpoint between two quarterlies is linear", () => {
    const points = alignToDenominator(
      BUFFETT_INDICATOR,
      [scaled("2024-02-15", 40_000)],
      denominator,
      true,
    );
    const t0 = Date.parse("2024-01-01");
    const t1 = Date.parse("2024-04-01");
    const t = Date.parse("2024-02-15");
    const expected = 20_000 + ((t - t0) / (t1 - t0)) * 2_000;
    expect(points[0]!.denominatorBillions).toBeCloseTo(expected, 6);
    expect(points[0]!.ratio).toBeCloseTo((40_000 / expected) * 100, 6);
  });

  test("flat-forwards past the last denominator print", () => {
    const points = alignToDenominator(
      BUFFETT_INDICATOR,
      [scaled("2024-06-01", 44_000)],
      denominator,
      true,
    );
    expect(points[0]!.denominatorBillions).toBe(22_000);
  });

  test("drops numerator dates before the first denominator print", () => {
    const points = alignToDenominator(
      BUFFETT_INDICATOR,
      [scaled("2023-12-01", 39_000), scaled("2024-02-01", 40_000)],
      denominator,
      true,
    );
    expect(points.map((p) => p.date)).toEqual(["2024-02-01"]);
  });

  test("omits dollar levels when the ratio has none worth showing", () => {
    const points = alignToDenominator(
      SP500_DIVIDEND_YIELD,
      [scaled("2024-02-15", 80)],
      [scaled("2024-01-01", 4000)],
      false,
    );
    expect(points[0]!.numeratorBillions).toBeUndefined();
    expect(points[0]!.ratio).toBeCloseTo(2, 6);
  });
});

describe("buildValuationSeries", () => {
  test("scales each leg into billions before dividing", () => {
    const legs = new Map<string, DatedSeries>([
      ["NCBEILQ027S", series([{ date: "2024-01-01", value: 60_000_000 }])],
      ["TNWMVBSNNCB", series([{ date: "2024-01-01", value: 40_000_000 }])],
    ]);
    const built = buildValuationSeries(TOBINS_Q, legs);
    expect(built.points[0]!.numeratorBillions).toBeCloseTo(60_000, 6);
    expect(built.points[0]!.ratio).toBeCloseTo(1.5, 6);
  });

  test("a direct indicator uses its single leg as the value", () => {
    const legs = new Map<string, DatedSeries>([
      ["SHILLER_CAPE", series([
        { date: "2026-07-01", value: 40.6 },
        { date: "2026-08-01", value: 41.2 },
      ])],
    ]);
    const built = buildValuationSeries(SHILLER_CAPE, legs);
    expect(built.points.map((p) => p.ratio)).toEqual([40.6, 41.2]);
    expect(built.points[0]!.numeratorBillions).toBeUndefined();
  });

  test("ratioScale turns a decimal fraction into a percent", () => {
    const legs = new Map<string, DatedSeries>([
      ["SHILLER_ECY", series([{ date: "2026-08-01", value: 0.0097 }])],
    ]);
    expect(buildValuationSeries(EXCESS_CAPE_YIELD, legs).points[0]!.ratio).toBeCloseTo(0.97, 6);
  });

  test("throws when a leg is missing", () => {
    expect(() => buildValuationSeries(SHILLER_CAPE, new Map())).toThrow("missing");
  });
});

describe("fitTrend", () => {
  test("log model recovers a compounding growth rate", () => {
    const originMs = Date.parse("2000-01-01");
    const betaPerDay = 0.03 / 365.25;
    const points: RatioPoint[] = [];
    for (let year = 0; year <= 20; year += 1) {
      const date = `${2000 + year}-01-01`;
      const tDays = (Date.parse(date) - originMs) / 86_400_000;
      points.push(ratioPoint(date, 80 * Math.exp(betaPerDay * tDays)));
    }
    const fit = fitTrend(points, "log");
    expect(fit.beta).toBeCloseTo(betaPerDay, 8);
    const outlierDate = points[10]!.date;
    const outlier = trendAt(fit, outlierDate) * Math.exp(2);
    expect(sigmaVsTrend({ ...fit, sigma: 0.05 }, outlier, outlierDate)).toBeCloseTo(40, 8);
  });

  test("linear model keeps the negative years a log fit would drop", () => {
    const points = [
      ratioPoint("2000-01-01", -2),
      ratioPoint("2001-01-01", 0),
      ratioPoint("2002-01-01", 2),
      ratioPoint("2003-01-01", 4),
    ];
    const linear = fitTrend(points, "linear");
    expect(linear.model).toBe("linear");
    // Leap years make the day spacing uneven, so the fit lands near, not on, the ends.
    expect(trendAt(linear, "2000-01-01")).toBeCloseTo(-2, 1);
    expect(trendAt(linear, "2003-01-01")).toBeCloseTo(4, 1);
    // The log fit sees only the two positive points, so its origin moves.
    expect(fitTrend(points, "log").originMs).toBe(Date.parse("2002-01-01"));
  });

  test("sigma is zero for a value the model cannot place", () => {
    const fit = fitTrend([ratioPoint("2020-01-01", 1), ratioPoint("2021-01-01", 2)], "log");
    expect(sigmaVsTrend(fit, -1, "2021-01-01")).toBe(0);
  });
});

describe("classifyZone", () => {
  test("Buffett boundaries are half-open at 75, 90, 115, 135", () => {
    expect(classifyZone(BUFFETT_INDICATOR, 74.999).id).toBe("significantly-undervalued");
    expect(classifyZone(BUFFETT_INDICATOR, 90).id).toBe("fair");
    expect(classifyZone(BUFFETT_INDICATOR, 135).id).toBe("significantly-overvalued");
  });

  test("a yield-shaped indicator reads the other way round", () => {
    // A high excess yield means stocks are cheap, unlike a high price ratio.
    expect(classifyZone(EXCESS_CAPE_YIELD, 0.5).id).toBe("significantly-overvalued");
    expect(classifyZone(EXCESS_CAPE_YIELD, 3.3).id).toBe("fair");
    expect(classifyZone(EXCESS_CAPE_YIELD, 8).id).toBe("significantly-undervalued");
    expect(classifyZone(SP500_DIVIDEND_YIELD, 1.1).id).toBe("significantly-overvalued");
    expect(classifyZone(SP500_DIVIDEND_YIELD, 7).id).toBe("significantly-undervalued");
  });
});

describe("zone scale geometry", () => {
  test("bands span min to max with classifyZone's colors, for every indicator", () => {
    for (const indicator of INDICATORS) {
      const bands = zoneScaleBands(indicator);
      expect(bands[0]!.from).toBe(indicator.zoneScale.min);
      expect(bands.at(-1)!.to).toBe(indicator.zoneScale.max);
      for (const band of bands) {
        expect(band.color).toBe(classifyZone(indicator, (band.from + band.to) / 2).color);
      }
    }
  });

  test("edges land on equal fractions and round-trip, including a negative floor", () => {
    for (const indicator of INDICATORS) {
      const edges = indicator.zoneScale.edges;
      const bands = edges.length - 1;
      for (let index = 0; index <= bands; index += 1) {
        const edge = edges[index]!;
        expect(zoneScaleFraction(indicator, edge)).toBeCloseTo(index / bands, 8);
        expect(zoneScaleValueAt(indicator, index / bands)).toBeCloseTo(edge, 6);
      }
    }
    expect(zoneScaleFraction(EXCESS_CAPE_YIELD, -3)).toBe(0);
    expect(zoneScaleFraction(EXCESS_CAPE_YIELD, -99)).toBe(0);
  });
});

describe("niceDomain", () => {
  test("snaps up to whole grid steps", () => {
    expect(niceDomain(0, 142, 150)).toEqual({ min: 0, max: 150 });
    expect(niceDomain(0, 214, 150)).toEqual({ min: 0, max: 300 });
    expect(niceDomain(0, 1.82, 0.5)).toEqual({ min: 0, max: 2 });
  });

  test("opens a floor when the measure goes negative", () => {
    expect(niceDomain(-2.6, 12, 5)).toEqual({ min: -5, max: 15 });
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
    expect(chart.referenceLines.map((line) => line.value)).toEqual([100, mean]);
    expect(mean).not.toBeCloseTo(100, 6);
  });

  test("colors each segment from its own zone", () => {
    const chart = projectChart(BUFFETT_INDICATOR, points, meanRatio(points));
    expect(chart.lineColors)
      .toEqual(points.map((p) => classifyZone(BUFFETT_INDICATOR, p.ratio).color));
  });

  test("keeps a negative reference on screen", () => {
    const negative = [ratioPoint("2020-01-01", -2), ratioPoint("2021-01-01", 1)];
    const chart = projectChart(EXCESS_CAPE_YIELD, negative, meanRatio(negative));
    expect(chart.yDomain.min).toBeLessThan(0);
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
    series: { indicatorId: "buffett", points, vintageDate: "2026-01-01" },
    trend: fitTrend(points, "log"),
  };

  test("range changes the chart window but not the headline stats", () => {
    const short = projectView(build, "10Y", { nowMs: Date.parse("2026-02-01") });
    const all = projectView(build, "ALL", { nowMs: Date.parse("2026-02-01") });
    expect(short.current).toEqual(all.current);
    expect(short.percentile).toBe(all.percentile);
    expect(short.allTimeHigh).toEqual(all.allTimeHigh);
    expect(short.chart.points.length).toBeLessThan(all.chart.points.length);
  });

  test("staleness uses the indicator's own cadence", () => {
    // Three months past the last print: overdue daily, normal for quarterly Z.1.
    const nowMs = Date.parse("2026-04-01");
    expect(projectView(build, "ALL", { nowMs }).observationStale).toBe(true);
    const quarterly: IndicatorBuild = { ...build, indicator: TOBINS_Q };
    expect(projectView(quarterly, "ALL", { nowMs }).observationStale).toBe(false);
    expect(projectView(quarterly, "ALL", { nowMs: Date.parse("2026-09-02") }).observationStale)
      .toBe(false);
    expect(projectView(quarterly, "ALL", { nowMs: Date.parse("2027-02-01") }).observationStale)
      .toBe(true);
  });

  test("a direct indicator has no vintage label to show", () => {
    const direct: IndicatorBuild = { ...build, indicator: SHILLER_CAPE };
    expect(projectView(direct, "ALL").vintageLabel).toBeNull();
    expect(projectView(build, "ALL").vintageLabel).toContain("GDP as of");
  });
});

describe("richness normalisation", () => {
  const rising: RatioPoint[] = [];
  for (let year = 2000; year <= 2026; year += 1) {
    rising.push(ratioPoint(`${year}-01-01`, 1 + (year - 2000) * 0.2));
  }

  test("a yield at its historic low reads as the richest, not the cheapest", () => {
    // Same rising series, read as a price ratio and as a yield.
    const asPrice = projectView({
      indicator: BUFFETT_INDICATOR,
      series: { indicatorId: "b", points: rising, vintageDate: "2026-01-01" },
      trend: fitTrend(rising, "log"),
    }, "ALL");
    const asYield = projectView({
      indicator: SP500_DIVIDEND_YIELD,
      series: { indicatorId: "d", points: rising, vintageDate: "2026-01-01" },
      trend: fitTrend(rising, "log"),
    }, "ALL");

    expect(asPrice.percentile).toBeCloseTo(asYield.percentile, 8);
    // The raw percentile is identical, but a high yield is cheap.
    expect(asPrice.richPercentile).toBeCloseTo(100, 6);
    expect(asYield.richPercentile).toBeCloseTo(0, 6);
    expect(Math.sign(asPrice.richSigma)).toBe(-Math.sign(asYield.richSigma));
    expect(asYield.richSigma).toBeCloseTo(-asYield.sigmaVsTrend, 8);
  });
});

describe("sliceByRange", () => {
  test("falls back to the whole series when a window leaves under two points", () => {
    expect(sliceByRange([ratioPoint("1990-01-01", 60), ratioPoint("1991-01-01", 62)], "10Y"))
      .toHaveLength(2);
  });
});

describe("resolveIndicatorArg", () => {
  test("matches ids, short labels and prefixes so VAL <name> deep-links", () => {
    expect(resolveIndicatorArg("cape")?.id).toBe("shiller-cape");
    expect(resolveIndicatorArg("buffett")?.id).toBe("buffett");
    expect(resolveIndicatorArg("tobin q")?.id).toBe("tobins-q");
    expect(resolveIndicatorArg("")).toBeNull();
    expect(resolveIndicatorArg("nonsense")).toBeNull();
  });
});
