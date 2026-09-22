import { expect, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import type { PricePoint } from "../types/financials";
import { ChartResolveCache, resolveChartSpecData } from "./resolve";
import type { ChartResolutionSupport, ManualChartResolution } from "./resolution";
import type { ChartSpec } from "./types";

const DAY = 86_400_000;
const monthSupport: ChartResolutionSupport[] = [
  { resolution: "15m", maxRange: "1M" }, { resolution: "1h", maxRange: "3M" },
];
function chart(start: string, end: string, resolution: ChartSpec["viewport"]["resolution"] = "15m"): ChartSpec {
  return {
    version: 2, viewport: { range: "1M", resolution, dateWindow: { start, end } },
    panels: [{ id: "price" }], studies: [],
    series: [{ id: "price", source: { kind: "security", instrument: { symbol: "TEST", exchange: "CCC" }, fieldId: "market.close" },
      style: "line", transform: "raw", axis: "left", panelId: "price", interpolation: "none" }],
  };
}
function providerFor(points: PricePoint[], support: ChartResolutionSupport[] | Promise<ChartResolutionSupport[]>) {
  const requests: { start: string; end: string; resolution: ManualChartResolution }[] = [];
  const provider = createTestDataProvider({
    getChartResolutionSupport: () => support,
    getQuoteMetadata: async (symbol, exchange) => ({ symbol, exchange, currency: "USD", instrumentType: "CRYPTOCURRENCY" }),
    getDetailedPriceHistory: async (_symbol, _exchange, start, end, resolution) => {
      requests.push({ start: start.toISOString(), end: end.toISOString(), resolution: resolution as ManualChartResolution });
      return points.filter(point => point.date >= start && point.date < end);
    },
  });
  return { requests, sources: { dataProvider: provider, now: new Date("2026-04-01T00:00:00Z"),
    loadFredSeries: async () => { throw Error("Unexpected FRED request"); } } };
}

for (const boundary of [
  { start: "2026-02-28", end: "2026-03-31", interval: "15m", expected: "15m", capStart: "2026-02-28T00:00:00.000Z", requestEnd: "2026-04-01T00:00:00.000Z" },
  { start: "2026-02-28T15:45:12.345Z", end: "2026-03-31T15:45:12.345Z", interval: "15m", expected: "15m", capStart: "2026-02-28T15:45:12.345Z", requestEnd: "2026-03-31T15:45:12.346Z" },
  { start: "2026-02-28T15:45:12.344Z", end: "2026-03-31T15:45:12.345Z", interval: "15m", expected: "1h" },
  // An exact timestamp is not reduced to the authored calendar date for support.
  { start: "2026-02-28T00:00:00.000Z", end: "2026-03-31T23:59:59.999Z", interval: "15m", expected: "1h" },
  { start: "2023-02-28", end: "2024-02-29", interval: "1d", expected: "1d", capStart: "2023-02-28T00:00:00.000Z", requestEnd: "2024-03-01T00:00:00.000Z" },
  { start: "2023-02-27T23:59:59.999Z", end: "2024-02-29T00:00:00.000Z", interval: "1d", expected: "1wk" },
] as const) {
  test(`clamped support preserves the exact boundary: ${boundary.start} to ${boundary.end}`, async () => {
    const last = boundary.end.length === 10 ? `${boundary.end}T23:45:00.000Z` : boundary.end;
    const points = [{ date: new Date(boundary.start), close: 100 }, { date: new Date(last), close: 120 }];
    const support: ChartResolutionSupport[] = boundary.interval === "1d"
      ? [{ resolution: "1d", maxRange: "1Y" }, { resolution: "1wk", maxRange: "5Y" }] : monthSupport;
    const { requests, sources } = providerFor(points, support);
    const spec = chart(boundary.start, boundary.end, boundary.interval);
    if (boundary.interval === "1d") spec.viewport.range = "1Y";
    const result = await resolveChartSpecData(spec, sources, undefined, { awaitResolutionSupport: true });
    expect(result.errors).toEqual([]);
    expect(result.resolution).toBe(boundary.expected);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.resolution).toBe(boundary.expected);
    expect(result.series[0]?.points.map(point => point.value)).toEqual([100, 120]);
    if ("capStart" in boundary) {
      expect(requests[0]).toEqual({ start: boundary.capStart, end: boundary.requestEnd, resolution: boundary.expected });
      expect(result.warnings).toEqual([]);
    } else {
      expect(result.warnings.some(warning => warning.includes("data is unavailable for this range"))).toBe(true);
    }
  });
}

for (const cap of ["1M", "1W"] as const) {
  test(`late source support uses the clamped month without extending a ${cap} cap`, async () => {
    let settle!: (value: ChartResolutionSupport[]) => void;
    const support = new Promise<ChartResolutionSupport[]>(resolve => { settle = resolve; });
    const points = [{ date: new Date("2026-02-28"), close: 100 }, { date: new Date("2026-03-31"), close: 120 }];
    const { requests, sources } = providerFor(points, support), cache = new ChartResolveCache();
    const spec = chart("2026-02-28", "2026-03-31", "auto");
    await resolveChartSpecData(spec, sources, cache);
    settle([{ resolution: "15m", maxRange: cap }, { resolution: "1h", maxRange: "3M" }]);
    await support;
    requests.length = 0;
    const settled = await resolveChartSpecData(spec, sources, cache, { awaitResolutionSupport: true });
    const fresh = await resolveChartSpecData(spec, sources, undefined, { awaitResolutionSupport: true });
    expect(settled.resolution).toBe(cap === "1M" ? "15m" : "1h");
    expect(fresh.resolution).toBe(settled.resolution);
    expect(settled.series).toEqual(fresh.series);
    expect(settled.errors).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(request => request.resolution === settled.resolution)).toBe(true);
  });
}

for (const cap of ["3M", "1M"] as const) {
  test(`month-end SMA uses earlier observations only within the source ${cap} cap`, async () => {
    const points = Array.from({ length: 91 }, (_, index) => ({ date: new Date(Date.parse("2025-12-31") + index * DAY), close: 100 + index }));
    const { requests, sources } = providerFor(points, [{ resolution: "1d", maxRange: cap }]);
    const spec = chart("2026-02-28", "2026-03-31", "1d");
    spec.studies = [{ id: "sma", kind: "sma", inputSeriesIds: ["price"], parameters: { period: 20 }, panelId: "price", axis: "left" }];
    const result = await resolveChartSpecData(spec, sources, undefined, { awaitResolutionSupport: true });
    expect(result.errors).toEqual([]);
    expect(result.resolution).toBe("1d");
    expect(requests).toEqual([{ start: cap === "3M" ? "2025-12-31T00:00:00.000Z" : "2026-02-28T00:00:00.000Z",
      end: "2026-04-01T00:00:00.000Z", resolution: "1d" }]);
    expect(result.series.find(series => series.id === "price")?.points[0]?.date.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    const sma = result.series.find(series => series.id === "sma")!;
    const first = sma.points.find(point => typeof point.value === "number" && Number.isFinite(point.value))!;
    expect(first.date.toISOString()).toBe(cap === "3M" ? "2026-02-28T00:00:00.000Z" : "2026-03-19T00:00:00.000Z");
    expect(first.value).toBeCloseTo(cap === "3M" ? 149.5 : 168.5, 10);
    if (cap === "1M") expect(sma.points.filter(point => point.date < first.date).every(point => point.value == null)).toBe(true);
  });
}
