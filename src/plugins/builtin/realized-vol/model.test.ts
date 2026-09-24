import { describe, expect, test } from "bun:test";
import type { PricePoint } from "../../../types/financials";
import { realizedVolatility, REALIZED_VOLATILITY_WINDOWS } from "../shared/volatility";
import { DEFAULT_SURFACE_SETTINGS, pendingSurfaceExpiry, type SurfaceExpiry, type SurfaceSnapshot } from "../vol-surface/model";
import { projectCurrentAtmIv, projectRealizedVolatility } from "./model";

function history(length = 1400, end = Date.UTC(2026, 8, 22)): PricePoint[] {
  return Array.from({ length }, (_, index) => {
    const close = 100 * Math.exp(index * 0.0001 + Math.sin(index) * 0.02);
    return { date: new Date(end - (length - 1 - index) * 86400000), close,
      open: close * 0.99, high: close * 1.02, low: close * 0.98 };
  });
}
const now = Date.UTC(2026, 8, 22, 14);
function expiry(days: number, overrides: Partial<SurfaceExpiry> = {}): SurfaceExpiry {
  return { ...pendingSurfaceExpiry(now / 1000 + days * 86400, now), years: days / 365, state: "ready", atmIV: 0.3,
    asOf: "2026-09-22T13:45:00Z", source: "test", ...overrides };
}
function surface(expiries: SurfaceExpiry[], overrides: Partial<SurfaceSnapshot> = {}): SurfaceSnapshot {
  return { symbol: "AAPL", spot: 100, spotAsOf: "2026-09-22T13:59:00Z", phase: "ready",
    settings: DEFAULT_SURFACE_SETTINGS, catalogue: expiries.map((value) => value.expiration), requested: expiries.length,
    loaded: expiries.length, failed: 0, expiries, failures: [], warnings: [], rateAsOf: "2026-09-21", fetchedAt: now, ...overrides };
}

describe("realized-volatility projection", () => {
  test("computes all cone windows with pre-lookback warmup before clipping selected chart series", () => {
    const points = history();
    const result = projectRealizedVolatility(points, { symbol: "aapl", windows: [10, 30], lookbackYears: 2 });
    expect(result.symbol).toBe("AAPL");
    expect(result.history).toHaveLength(730);
    expect(result.series).toHaveLength(730);
    expect(result.cone.map((row) => row.window)).toEqual([...REALIZED_VOLATILITY_WINDOWS]);
    expect(Object.keys(result.series[0]!.values)).toEqual(["10", "30"]);
    expect(result.cone.every((row) => row.sampleSize === 730)).toBe(true);
    expect(result.warnings).toHaveLength(0);
    for (const row of result.cone) expect(row.current).toBeCloseTo(realizedVolatility(points, row.window)!, 12);
    expect(result.series[0]!.values[30]).toBeCloseTo(realizedVolatility(points.slice(0, 671), 30)!, 12);
  });

  test("applies estimator and leap-year cutoff, and anchors on the source's last date", () => {
    const points = history(1200, Date.UTC(2024, 1, 29));
    const result = projectRealizedVolatility(points, { symbol: "AAPL", estimator: "yang-zhang", windows: [30] });
    expect(result.history[0]!.date.toISOString()).toBe("2023-03-01T00:00:00.000Z");
    expect(result.history).toHaveLength(366);
    expect(result.asOf!.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(result.series.at(-1)!.values[30]).toBeCloseTo(realizedVolatility(points, 30, "yang-zhang")!, 12);
  });

  test("retains rejected bars as gaps and deduplicates later corrections without mutating input", () => {
    const points = history(100);
    const bad = { ...points[80]!, high: 1 };
    const result = projectRealizedVolatility([...points, bad], { symbol: "AAPL", windows: [10] });
    expect(result.history).toHaveLength(100);
    expect(result.series[80]!.values[10]).toBeNull();
    expect(result.series[90]!.values[10]).toBeNull();
    expect(result.series[91]!.values[10]).toBeNumber();
    expect(result.cone.find((row) => row.window === 30)!.current).toBeNull();
    expect(result.warnings.some((warning) => warning.includes("inconsistent ohlc"))).toBe(true);
    expect(points[80]!.high).toBeGreaterThan(100);
    const corrected = projectRealizedVolatility([...points].reverse(), { symbol: "AAPL", windows: [10] });
    expect(corrected.series.at(-1)!.values[10]).toBeCloseTo(realizedVolatility(points, 10)!, 12);
    expect(result.warnings.some((warning) => warning.includes("complete lookback"))).toBe(true);
  });

  test("reports incomplete cone coverage after latest estimates recover from an old rejected bar", () => {
    const points = history();
    const baseline = projectRealizedVolatility(points, { symbol: "AAPL", lookbackYears: 2 });
    // Inside the displayed lookback, but more than 260 observations before the latest bar.
    const broken = points.map((point, index) => index === 750 ? { ...point, high: 1 } : point);
    const result = projectRealizedVolatility(broken, { symbol: "AAPL", lookbackYears: 2 });
    expect(result.history).toHaveLength(baseline.history.length);
    expect(result.series.at(-1)!.values).toEqual(baseline.series.at(-1)!.values);
    for (const row of result.cone) {
      expect(row.current).toBeNumber();
      expect(row.sampleSize).toBeLessThan(result.history.length);
      expect(row.sampleSize).toBe(result.history.length - row.window - 1);
    }
    expect(baseline.warnings).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("cone sample coverage");
  });

  test("does not infer chronology from a history containing invalid dates or substitute OHLC", () => {
    const points = history(50).map(({ date, close }) => ({ date, close }));
    const range = projectRealizedVolatility(points, { symbol: "AAPL", estimator: "parkinson" });
    expect(range.cone.every((row) => row.current === null)).toBe(true);
    expect(range.warnings.some((warning) => warning.includes("missing ohlc"))).toBe(true);
    const invalid = projectRealizedVolatility([...points, { date: new Date(NaN), close: 100 }], { symbol: "AAPL" });
    expect(invalid.history).toHaveLength(0);
    expect(invalid.series).toHaveLength(0);
    expect(invalid.asOf).toBeNull();
    expect(invalid.warnings.some((warning) => warning.includes("invalid history date"))).toBe(true);
  });

  test("withholds annualized daily estimates on weekly or intraday fallback bars but retains price", () => {
    for (const interval of [7 * 86400000, 3600000]) {
      const points = history(100).map((point, index) => ({ ...point, date: new Date(now - (99 - index) * interval) }));
      const result = projectRealizedVolatility(points, { symbol: "AAPL", windows: [30] });
      expect(result.history.length).toBeGreaterThan(0);
      expect(result.series.length).toBe(result.history.length);
      expect(result.series.every((point) => point.values[30] === null)).toBe(true);
      expect(result.cone.every((row) => row.current === null && row.sampleSize === 0)).toBe(true);
      expect(result.warnings.some((warning) => warning.includes("Daily history unavailable"))).toBe(true);
    }
    // Corrections at exactly the same timestamp remain one daily observation.
    const daily = history(100);
    const corrected = projectRealizedVolatility([...daily, daily[50]!], { symbol: "AAPL", windows: [30] });
    expect(corrected.series.at(-1)!.values[30]).toBeNumber();
    expect(corrected.warnings.some((warning) => warning.includes("Daily history unavailable"))).toBe(false);
  });
});

describe("current ATM IV reference", () => {
  test("selects the listed tenor nearest 30 days and keeps only its own and surface-wide caveats", () => {
    const selected = expiry(31, { atmIV: 0.27, warnings: ["9 butterfly arbitrage warnings"] });
    const leaps = expiry(800, { warnings: ["SVI did not converge"] });
    const result = projectCurrentAtmIv(surface([expiry(7), selected, expiry(60), leaps], {
      phase: "partial", failures: [{ expiration: 100, message: "unrelated expiry offline" }],
      warnings: ["SVI did not converge", "9 butterfly arbitrage warnings", "2 calendar arbitrage warnings"],
    }));
    expect(result.reference!.value).toBe(0.27);
    expect(result.reference!.expiration).toBe(selected.expiration);
    expect(result.reference!.daysToExpiry).toBeCloseTo(31, 12);
    expect(result.reference!.date.toISOString()).toBe(new Date(selected.asOf!).toISOString());
    expect(result.reference!.source).toBe("test");
    expect(result.reference!.ivSource).toBe("recomputed");
    expect(result.error).toBeNull();
    expect(result.warnings).toEqual(["9 butterfly arbitrage warnings"]);
    const offline = projectCurrentAtmIv(surface([selected], { failures: [{ expiration: null, message: "Treasury: offline" }] }));
    expect(offline.error).toBe("Treasury: offline");
  });

  test("says when nearer expiries without usable quotes pushed the reference to a farther tenor", () => {
    const result = projectCurrentAtmIv(surface([expiry(1), expiry(29, { atmIV: null, state: "empty" }), expiry(60, { atmIV: null, state: "error" })]));
    expect(result.reference!.daysToExpiry).toBeCloseTo(1, 12);
    expect(result.warnings).toContain("Expiries nearer 30 days have no usable ATM quotes; reference uses the 1d expiry");
    expect(projectCurrentAtmIv(surface([expiry(29), expiry(60, { atmIV: null, state: "empty" })])).warnings).toEqual([]);
  });

  test("withholds stale, failed and undated observations and chooses the next eligible expiry", () => {
    const stale = expiry(30, { stale: true });
    const failed = expiry(29, { error: "refresh failed" });
    const undated = expiry(31, { asOf: null });
    const result = projectCurrentAtmIv(surface([stale, failed, undated, expiry(40)]));
    expect(result.reference!.daysToExpiry).toBeCloseTo(40, 12);
    expect(result.reference!.stale).toBe(false);
    expect(result.warnings).toHaveLength(2);
    const missing = projectCurrentAtmIv(surface([stale, failed, undated]));
    expect(missing.reference).toBeNull();
    expect(missing.error).toBeTruthy();
    expect(projectCurrentAtmIv(surface([expiry(30, { atmIV: NaN })])).reference).toBeNull();
    // With every short expiry withheld, a LEAPS was the nearest to 30 days.
    expect(projectCurrentAtmIv(surface([stale, expiry(451)])).reference).toBeNull();
  });
});
