import { describe, expect, test } from "bun:test";
import type { CompositeChartScene } from "./types";
import {
  formatChartLegendValue,
  formatCompositeAxisValue,
  formatCompositeCursorDate,
  formatCompositeCursorValue,
  formatCompositePointDetails,
  formatCompositeSeriesValue,
  formatCompositeTimeAxisDate,
} from "./format";
import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import {
  renderCompositeTimeAxis,
  renderCompositeViewportTimeAxis,
} from "./text-renderer";

function scene(start: string, end: string): CompositeChartScene {
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  return {
    width: 80,
    height: 10,
    startTime,
    endTime,
    timeScale: { kind: "calendar", startTime, endTime },
    dates: [],
    dateRatios: [],
    panels: [],
    cursorDate: null,
    cursorXRatio: null,
    cursorValues: [],
  };
}

describe("composite chart timestamp formatting", () => {
  test("shows UTC times on a same-day intraday chart", () => {
    const intraday = scene("2025-01-02T09:30:00Z", "2025-01-02T16:00:00Z");
    const cursor = new Date("2025-01-02T12:05:00Z");

    expect(formatCompositeCursorDate(cursor, intraday.startTime, intraday.endTime))
      .toBe("2025-01-02 12:05 UTC");
    expect(formatCompositeTimeAxisDate(cursor, intraday.startTime, intraday.endTime))
      .toBe("12:05 UTC");
    expect(renderCompositeTimeAxis(intraday, 60)).toContain("09:30 UTC");
    expect(renderCompositeTimeAxis(intraday, 60)).toContain("12:00");
    expect(renderCompositeTimeAxis(intraday, 60)).toContain("16:00 UTC");
  });

  test("adds the date to UTC time ticks when an intraday span crosses days", () => {
    const overnight = scene("2025-01-01T23:30:00Z", "2025-01-02T00:30:00Z");

    expect(formatCompositeTimeAxisDate(
      new Date("2025-01-02T00:15:00Z"),
      overnight.startTime,
      overnight.endTime,
    )).toBe("01-02 00:15 UTC");
    const axis = renderCompositeTimeAxis(overnight, 80);
    expect(axis).toContain("Jan 1 23:30 UTC");
    expect(axis).toContain("Jan 2 00:00");
    expect(axis).toContain("Jan 2 00:30 UTC");
  });

  test("keeps longer chart spans as concise UTC calendar dates", () => {
    const weekly = scene("2025-01-01T09:30:00Z", "2025-01-08T16:00:00Z");
    const cursor = new Date("2025-01-04T12:05:00Z");

    expect(formatCompositeCursorDate(cursor, weekly.startTime, weekly.endTime)).toBe("2025-01-04");
    expect(formatCompositeTimeAxisDate(cursor, weekly.startTime, weekly.endTime)).toBe("2025-01-04");
    expect(renderCompositeTimeAxis(weekly, 60)).toContain("Jan 1");
    expect(renderCompositeTimeAxis(weekly, 60)).toContain("Jan 8");
  });

  test("renders recovery-shell dates directly from a viewport", () => {
    const axis = renderCompositeViewportTimeAxis({
      start: new Date("2025-01-01T00:00:00.000Z"),
      end: new Date("2025-01-08T00:00:00.000Z"),
    }, 60);

    expect(axis).toContain("Jan 1");
    expect(axis).toContain("Jan 8");
  });
});

describe("composite chart point details", () => {
  test("shows explicit financial period ends once and keeps their later availability", () => {
    for (const period of ["Quarter", "Year", "TTM"]) {
      expect(formatCompositePointDetails({
        date: new Date("2025-07-30"), observedAt: new Date("2025-06-30"),
        availableAt: new Date("2025-07-30"), value: 76_441_000_000,
        periodLabel: `${period} ended 2025-06-30`, provenance: { quality: "reported" },
      })).toBe(`${period} ended 2025-06-30 · Available 2025-07-30 · Reported`);
    }
  });

  test("disambiguates fiscal period, availability, and provenance", () => {
    const point: TimeSeriesPoint = {
      date: new Date("2025-03-14T00:00:00.000Z"),
      observedAt: new Date("2025-01-26T00:00:00.000Z"),
      availableAt: new Date("2025-03-14T00:00:00.000Z"),
      value: 42,
      periodLabel: "FY2025",
      provenance: {
        providerId: "sec-filings",
        quality: "reported",
      },
    };

    expect(formatCompositePointDetails(point)).toBe(
      "FY2025 · Period ended 2025-01-26 · Available 2025-03-14 · Reported · Source sec-filings",
    );
  });

  test("omits a duplicate availability date for ordinary observations", () => {
    const observedAt = new Date("2025-01-02T00:00:00.000Z");
    expect(formatCompositePointDetails({
      date: observedAt,
      observedAt,
      availableAt: observedAt,
      value: 10,
    })).toBe("Observed 2025-01-02");
  });

  test("retains non-midnight observation and availability times", () => {
    expect(formatCompositePointDetails({
      date: new Date("2025-01-02T12:05:00.000Z"),
      observedAt: new Date("2025-01-02T09:30:00.000Z"),
      availableAt: new Date("2025-01-02T12:05:00.000Z"),
      value: 10,
    })).toBe("Observed 2025-01-02 09:30 UTC · Available 2025-01-02 12:05 UTC");
  });
});

describe("composite chart unit formatting", () => {
  test("keeps derived ratio dimensions visible instead of labeling them as multiples", () => {
    const derived: ResolvedSeries = {
      id: "ratio",
      label: "Price / Revenue",
      color: "#ffffff",
      unit: "1/share",
      unitGroup: "derived-unit:1/share",
      nativeFrequency: "quarterly",
      dataShape: "scalar",
      style: "step",
      transform: "raw",
      axis: "left",
      panelId: "formula",
      interpolation: "step-after",
      points: [],
    };
    expect(formatCompositeSeriesValue(0.000000003, derived)).toBe("3.00e-9 1/share");
    expect(formatCompositeAxisValue(0.5, {
      side: "left",
      min: 0,
      max: 1,
      scale: "linear",
      unit: "USD/JPY",
      unitGroup: "derived-unit:usd/jpy",
      seriesIds: ["ratio"],
    })).toBe("0.500");
  });

  test("shows full price precision in the legend and cursor, not compact axis ticks", () => {
    const btc: ResolvedSeries = {
      id: "btc",
      label: "BTC-USD Price",
      color: "#ffffff",
      unit: "USD",
      unitGroup: "price:USD",
      nativeFrequency: "daily",
      dataShape: "ohlcv",
      style: "candles",
      transform: "raw",
      axis: "left",
      panelId: "main",
      interpolation: "none",
      points: [],
    };
    const domain = {
      side: "left" as const,
      min: 70_000,
      max: 80_000,
      scale: "linear" as const,
      unit: "USD",
      unitGroup: "price:USD",
      seriesIds: ["btc"],
    };

    expect(formatCompositeSeriesValue(79_432.18, btc)).toBe("$79,432.18");
    expect(formatChartLegendValue(79_432.18, "USD", "price:USD")).toBe("$79,432.18");
    expect(formatCompositeCursorValue(79_432.18, domain)).toBe("$79,432.18");
    expect(formatCompositeAxisValue(79_432.18, domain)).toBe("$79K");
    expect(formatChartLegendValue(1_234_567.89, "USD", "price:USD")).toBe("$1,234,567.89");
    expect(formatChartLegendValue(90_007_000_000, "USD", "currency-total:USD")).toBe("$90.01B");
    expect(formatChartLegendValue(-12_345_600_000, "EUR", "currency-total")).toBe("€-12.35B");
    expect(formatChartLegendValue(123_456_000, "CAD", "currency-total:CAD")).toBe("123.46M CAD");
    expect(formatCompositeCursorValue(90_007_000_000, { ...domain, unitGroup: "currency-total:USD" })).toBe("$90.01B");
    expect(formatCompositeCursorValue(-12_345_600_000, { ...domain, unit: "EUR", unitGroup: "currency-total" })).toBe("€-12.35B");
    expect(formatCompositeCursorValue(123_456_000, { ...domain, unit: "CAD", unitGroup: "currency-total:CAD" })).toBe("123.46M CAD");
  });
});
