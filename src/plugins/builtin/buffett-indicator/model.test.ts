import { describe, expect, test } from "bun:test";
import {
  GDP,
  WILSHIRE_NUMERATOR,
  buildRatioSeries,
  chartYearLabels,
  classifyZone,
  fitLogLinearTrend,
  nicePercentDomain,
  zoneScaleBands,
  zoneScaleMarkerColumn,
  ZONE_SCALE_MAX,
  interpolateGdpAligner,
  projectChart,
  projectView,
  sigmaVsTrend,
  sliceByRange,
  trendAt,
  type BuffettBuild,
  type RatioPoint,
  type ScaledObs,
} from "./model";

function scaled(date: string, value: number): ScaledObs {
  return { date, value };
}

function series(observations: Array<{ date: string; value: number | null }>) {
  return { seriesId: "test", observations, provenance: "fred" as const };
}

describe("interpolateGdpAligner", () => {
  const gdp = [
    scaled("2024-01-01", 20_000),
    scaled("2024-04-01", 22_000),
  ];

  test("midpoint between two quarterlies is linear", () => {
    const market = [scaled("2024-02-15", 40_000)];
    const points = interpolateGdpAligner(market, gdp);
    expect(points).toHaveLength(1);
    const t0 = Date.parse("2024-01-01");
    const t1 = Date.parse("2024-04-01");
    const t = Date.parse("2024-02-15");
    const expectedGdp = 20_000 + ((t - t0) / (t1 - t0)) * (22_000 - 20_000);
    expect(points[0]!.gdpBillions).toBeCloseTo(expectedGdp, 6);
    expect(points[0]!.ratio).toBeCloseTo((40_000 / expectedGdp) * 100, 6);
  });

  test("flat-forwards past the last GDP print", () => {
    const market = [scaled("2024-06-01", 44_000)];
    const points = interpolateGdpAligner(market, gdp);
    expect(points).toHaveLength(1);
    expect(points[0]!.gdpBillions).toBe(22_000);
    expect(points[0]!.ratio).toBeCloseTo((44_000 / 22_000) * 100, 6);
  });

  test("drops market dates before the first GDP", () => {
    const market = [scaled("2023-12-01", 39_000), scaled("2024-02-01", 40_000)];
    const points = interpolateGdpAligner(market, gdp);
    expect(points).toHaveLength(1);
    expect(points[0]!.date).toBe("2024-02-01");
  });
});

describe("ratio alignment", () => {
  test("daily market × quarterly GDP yields one ratio per market obs inside the span", () => {
    const gdp = [
      scaled("2024-01-01", 20_000),
      scaled("2024-04-01", 21_000),
    ];
    const market = [
      scaled("2024-01-02", 30_000),
      scaled("2024-01-03", 30_100),
      scaled("2024-03-15", 31_000),
      scaled("2024-04-01", 31_500),
    ];
    const points = interpolateGdpAligner(market, gdp);
    expect(points.map((p) => p.date)).toEqual(market.map((m) => m.date));
    expect(new Set(points.map((p) => p.date)).size).toBe(points.length);
  });
});

describe("fitLogLinearTrend", () => {
  test("recovers beta and places an outlier at the expected σ", () => {
    const origin = "2000-01-01";
    const originMs = Date.parse(origin);
    const daysPerYear = 365.25;
    const betaPerYear = 0.03;
    const betaPerDay = betaPerYear / daysPerYear;
    const points: RatioPoint[] = [];
    for (let year = 0; year <= 20; year += 1) {
      const date = `${2000 + year}-01-01`;
      const tDays = (Date.parse(date) - originMs) / 86_400_000;
      const ratio = 80 * Math.exp(betaPerDay * tDays);
      points.push({
        date,
        ratio,
        marketCapBillions: ratio,
        gdpBillions: 100,
      });
    }
    const fit = fitLogLinearTrend(points);
    expect(fit.beta).toBeCloseTo(betaPerDay, 8);
    expect(fit.sigma).toBeLessThan(1e-12);

    const outlierDate = points[10]!.date;
    const trend = trendAt(fit, outlierDate);
    const outlierRatio = trend * Math.exp(2);
    const forcedSigma = 0.05;
    const forcedFit = { ...fit, sigma: forcedSigma };
    expect(sigmaVsTrend(forcedFit, outlierRatio, outlierDate)).toBeCloseTo(2 / forcedSigma, 8);
  });
});

describe("classifyZone", () => {
  test("half-open boundaries at 75, 90, 115, 135", () => {
    expect(classifyZone(74.999).id).toBe("significantly-undervalued");
    expect(classifyZone(75).id).toBe("modestly-undervalued");
    expect(classifyZone(89.999).id).toBe("modestly-undervalued");
    expect(classifyZone(90).id).toBe("fair");
    expect(classifyZone(114.999).id).toBe("fair");
    expect(classifyZone(115).id).toBe("modestly-overvalued");
    expect(classifyZone(134.999).id).toBe("modestly-overvalued");
    expect(classifyZone(135).id).toBe("significantly-overvalued");
  });
});

describe("zoneScaleBands", () => {
  test("covers 0–250 with the same colors as classifyZone", () => {
    const bands = zoneScaleBands();
    expect(bands.map((band) => [band.from, band.to])).toEqual([
      [0, 75],
      [75, 90],
      [90, 115],
      [115, 135],
      [135, ZONE_SCALE_MAX],
    ]);
    expect(bands.map((band) => band.color)).toEqual([
      classifyZone(0).color,
      classifyZone(75).color,
      classifyZone(90).color,
      classifyZone(115).color,
      classifyZone(135).color,
    ]);
  });

  test("pins the marker to the right edge at and above the scale max", () => {
    expect(zoneScaleMarkerColumn(0, 51)).toBe(0);
    expect(zoneScaleMarkerColumn(125, 51)).toBe(25);
    expect(zoneScaleMarkerColumn(ZONE_SCALE_MAX, 51)).toBe(50);
    expect(zoneScaleMarkerColumn(400, 51)).toBe(50);
  });
});

describe("chartYearLabels", () => {
  test("keeps unique years in order and thins long spans", () => {
    const points = [2020, 2021, 2022, 2023, 2024].map((year) => ({
      date: new Date(`${year}-06-01`),
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 0,
    }));
    expect(chartYearLabels(points)).toEqual(["2020", "2021", "2022", "2023", "2024"]);
    const long = Array.from({ length: 20 }, (_, index) => ({
      date: new Date(`${2000 + index}-01-01`),
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 0,
    }));
    expect(chartYearLabels(long, 5)).toEqual(["2000", "2005", "2010", "2015", "2019"]);
  });
});

describe("nicePercentDomain", () => {
  test("snaps to 150-point spans so grid ticks land on round percents", () => {
    expect(nicePercentDomain(40)).toEqual({ min: 0, max: 150 });
    expect(nicePercentDomain(151)).toEqual({ min: 0, max: 300 });
    expect(nicePercentDomain(300)).toEqual({ min: 0, max: 300 });
  });
});

describe("projectChart", () => {
  test("pins parity at 100% and colors the series from classifyZone", () => {
    const points: RatioPoint[] = [
      { date: "2024-01-01", ratio: 50, marketCapBillions: 10_000, gdpBillions: 20_000 },
      { date: "2025-01-01", ratio: 100, marketCapBillions: 20_000, gdpBillions: 20_000 },
      { date: "2026-01-01", ratio: 200, marketCapBillions: 40_000, gdpBillions: 20_000 },
    ];
    const chart = projectChart(points);
    expect(chart.overlays.bollinger).toBeNull();
    expect(chart.overlays.smaLines).toEqual([]);
    expect(chart.overlays.referenceLines).toEqual([{ value: 100, color: expect.any(String) }]);
    expect(chart.yDomain).toEqual({ min: 0, max: 300 });
    expect(chart.yearLabels).toEqual(["2024", "2025", "2026"]);
    expect(chart.lineColors).toEqual(points.map((point) => classifyZone(point.ratio).color));
    expect(new Set(chart.lineColors).size).toBe(3);
  });
});

describe("projectView range independence", () => {
  test("10Y vs ALL keep the same current, sigma, percentile, and ATH", () => {
    const points: RatioPoint[] = [];
    const start = Date.parse("2005-01-01");
    for (let i = 0; i < 400; i += 1) {
      const date = new Date(start + i * 30 * 86_400_000).toISOString().slice(0, 10);
      const ratio = 80 + i * 0.2;
      points.push({
        date,
        ratio,
        marketCapBillions: ratio * 200,
        gdpBillions: 20_000,
      });
    }
    const series = {
      resolvedNumeratorId: "WILL5000PRFC",
      points,
      gdpVintageDate: points[points.length - 1]!.date,
    };
    const trend = fitLogLinearTrend(points);
    const build: BuffettBuild = { series, trend, cacheStale: false };
    const view10 = projectView(build, "10Y");
    const viewAll = projectView(build, "ALL");
    expect(view10.current.ratio).toBe(viewAll.current.ratio);
    expect(view10.sigmaVsTrend).toBe(viewAll.sigmaVsTrend);
    expect(view10.percentile).toBe(viewAll.percentile);
    expect(view10.allTimeHigh).toEqual(viewAll.allTimeHigh);
    expect(view10.chart.points.length).not.toBe(viewAll.chart.points.length);
    expect(sliceByRange(points, "10Y").length).toBeLessThan(points.length);
  });
});

describe("buildRatioSeries", () => {
  test("wires Wilshire through interpolated GDP", () => {
    const built = buildRatioSeries(
      WILSHIRE_NUMERATOR,
      series([
        { date: "2024-01-01", value: 40_000 },
        { date: "2024-04-01", value: 42_000 },
      ]),
      GDP,
      series([
        { date: "2024-01-01", value: 20_000 },
        { date: "2024-04-01", value: 21_000 },
      ]),
    );
    expect(built.resolvedNumeratorId).toBe("WILL5000PRFC");
    expect(built.points[0]!.ratio).toBeCloseTo(200, 8);
  });
});
