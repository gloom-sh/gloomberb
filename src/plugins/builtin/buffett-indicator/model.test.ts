import { describe, expect, test } from "bun:test";
import type { FredSeriesData } from "../../../data/fred-series";
import {
  BUFFETT_MODES,
  buildRatioSeries,
  chartYearLabels,
  classifyZone,
  fitLogLinearTrend,
  gaugeSegmentsFromZones,
  interpolateGdpAligner,
  projectChart,
  projectView,
  sameQuarterAligner,
  scaleObservations,
  sigmaVsTrend,
  sliceByRange,
  trendAt,
  Z1_NUMERATOR,
  type ModeBuild,
  type RatioPoint,
  type ScaledObs,
} from "./model";

function scaled(date: string, value: number): ScaledObs {
  return { date, value };
}

function series(observations: Array<{ date: string; value: number | null }>): FredSeriesData {
  return {
    observations,
    info: null,
  };
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

describe("scaleObservations Z.1", () => {
  test("divides millions by 1000 so ratio is 20 not 20000", () => {
    const market = scaleObservations(
      Z1_NUMERATOR,
      series([{ date: "2024-01-01", value: 5_000_000 }]),
    );
    const gdp = scaleObservations(
      BUFFETT_MODES.z1.denominator,
      series([{ date: "2024-01-01", value: 25_000 }]),
    );
    expect(market[0]!.value).toBe(5_000);
    const points = sameQuarterAligner(market, gdp);
    expect(points).toHaveLength(1);
    expect(points[0]!.ratio).toBeCloseTo(20, 10);
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

  test("same-quarter drops unmatched quarters and keeps matches", () => {
    const gdp = [scaled("2024-01-01", 20_000), scaled("2024-07-01", 21_000)];
    const market = [
      scaled("2024-01-01", 4_000),
      scaled("2024-04-01", 4_100),
      scaled("2024-07-01", 4_200),
    ];
    const points = sameQuarterAligner(market, gdp);
    expect(points.map((p) => p.date)).toEqual(["2024-01-01", "2024-07-01"]);
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
      const tDays = year * daysPerYear;
      const date = new Date(originMs + tDays * 86_400_000).toISOString().slice(0, 10);
      // Rebuild tDays from the date string the fitter will see, so the series is exact in log space.
      const exactDays = (Date.parse(date) - originMs) / 86_400_000;
      const ratio = 80 * Math.exp(betaPerDay * exactDays);
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

describe("gaugeSegmentsFromZones", () => {
  test("uses short dial labels and keeps full names on the zone table", () => {
    const segments = gaugeSegmentsFromZones();
    expect(segments.map((segment) => segment.label)).toEqual(["Cheap", "Low", "Fair", "High", "Rich"]);
    expect(classifyZone(238).label).toBe("Significantly Overvalued");
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
    expect(chartYearLabels(long, 5)).toEqual(["2000", "2005", "2010", "2014", "2019"]);
  });
});

describe("projectChart", () => {
  test("leaves trend bands unclamped and pads the y domain around them", () => {
    const points: RatioPoint[] = [
      { date: "2024-01-01", ratio: 200, marketCapBillions: 40_000, gdpBillions: 20_000 },
      { date: "2025-01-01", ratio: 210, marketCapBillions: 42_000, gdpBillions: 20_000 },
      { date: "2026-01-01", ratio: 220, marketCapBillions: 44_000, gdpBillions: 20_000 },
    ];
    const fit = fitLogLinearTrend(points);
    const chart = projectChart(points, fit);
    const lastDate = points[2]!.date;
    const mid = trendAt(fit, lastDate);
    const expectedUpper = mid * Math.exp(2 * fit.sigma);
    const expectedLower = mid * Math.exp(-2 * fit.sigma);
    expect(chart.overlays.bollinger?.upper.at(-1)?.value).toBeCloseTo(expectedUpper);
    expect(chart.overlays.bollinger?.lower.at(-1)?.value).toBeCloseTo(expectedLower);
    expect(chart.yDomain.max).toBeGreaterThan(expectedUpper);
    expect(chart.yDomain.min).toBeLessThan(expectedLower);
    expect(chart.yearLabels).toEqual(["2024", "2025", "2026"]);
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
      mode: "wilshire" as const,
      resolvedNumeratorId: "WILL5000PRFC",
      points,
      gdpVintageDate: points[points.length - 1]!.date,
    };
    const trend = fitLogLinearTrend(points);
    const build: ModeBuild = { series, trend, cacheStale: false };
    const view10 = projectView(build, "wilshire", "10Y", { partial: false });
    const viewAll = projectView(build, "wilshire", "ALL", { partial: false });
    expect(view10.current.ratio).toBe(viewAll.current.ratio);
    expect(view10.sigmaVsTrend).toBe(viewAll.sigmaVsTrend);
    expect(view10.percentile).toBe(viewAll.percentile);
    expect(view10.allTimeHigh).toEqual(viewAll.allTimeHigh);
    expect(view10.chart.points.length).not.toBe(viewAll.chart.points.length);
    expect(sliceByRange(points, "10Y").length).toBeLessThan(points.length);
  });
});

describe("buildRatioSeries", () => {
  test("wires Z.1 scale through same-quarter alignment", () => {
    const built = buildRatioSeries(
      BUFFETT_MODES.z1,
      series([
        { date: "2024-01-01", value: 5_000_000 },
        { date: "2024-04-01", value: 5_100_000 },
      ]),
      series([
        { date: "2024-01-01", value: 25_000 },
        { date: "2024-04-01", value: 25_500 },
      ]),
      "NCBEILQ027S",
    );
    expect(built.points[0]!.ratio).toBeCloseTo(20, 8);
  });
});
