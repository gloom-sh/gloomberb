import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { MarketDataCoordinator } from "../../market-data/coordinator";
import { resolveDatedReturns } from "../../plugins/builtin/analytics/metrics";
import { loadChartPaneModel } from "../../plugins/builtin/chart-composer/headless";
import { buildCompositeChartScene, applyCompositeChartCursor } from "../../components/chart/composite/scene";
import type { HeadlessPaneContext } from "../../types/headless";
import { CHART_SPEC_VERSION, type ChartSpec } from "../../time-series/types";
import type { PricePoint } from "../../types/financials";
import { AssetDataRouter } from "./index";
import { fallbackProvider } from "../../test-support/data-provider";
import { createTempDbPath, removeTempDbFiles } from "../../test-support/temp-db";

afterEach(removeTempDbFiles);

test("reported gaps survive router persistence, coordinator reuse and the actual chart consumer", async () => {
  const path = createTempDbPath("reported-history-gaps");
  let persistence = new AppPersistence(path);
  const history: PricePoint[] = [
    { date: new Date("2026-06-01"), close: 100 },
    { date: new Date("2026-06-02"), close: Number.NaN },
    { date: new Date("2026-06-03"), close: 110 },
    { date: new Date("2026-06-04"), close: 111 },
    { date: new Date("2026-06-05"), close: Number.NaN },
  ];
  persistence.resources.set({ namespace: "market", kind: "price-history", entityKey: "GAP",
    variantKey: "exchange=NYSE;range=1Y;version=4", sourceKey: "provider:test-gap" },
  history.filter((point) => Number.isFinite(point.close)), { cachePolicy: { staleMs: 60_000, expireMs: 60_000 } });
  let calls = 0;
  const provider = { ...fallbackProvider, id: "test-gap", name: "Controlled gaps",
    async getPriceHistory() { calls++; return history; },
    async getPriceHistoryForResolution() { calls++; return history; },
  };
  const request = { instrument: { symbol: "GAP", exchange: "NYSE" }, bufferRange: "1Y" as const, granularity: "range" as const };
  let coordinator: MarketDataCoordinator | undefined;
  try {
    let router = new AssetDataRouter(provider, [], persistence.resources);
    expect(await router.getPriceHistory("GAP", "NYSE", "1Y")).toHaveLength(5);
    expect(calls).toBe(1);
    persistence.close(); persistence = new AppPersistence(path);
    router = new AssetDataRouter(provider, [], persistence.resources);
    coordinator = new MarketDataCoordinator(router);
    const entry = await coordinator.loadChart(request);
    expect(entry.data).toHaveLength(5);
    expect(calls).toBe(1);
    expect(resolveDatedReturns(entry.data!).returns).toEqual([
      { startDateKey: "2026-06-03", dateKey: "2026-06-04", value: 1 / 110 },
    ]);
    expect((await coordinator.loadChart(request)).data).toHaveLength(5);
    expect(calls).toBe(1);
    const spec: ChartSpec = { version: CHART_SPEC_VERSION,
      viewport: { range: "1Y", resolution: "1d", dateWindow: { start: "2026-06-01", end: "2026-06-05" } },
      panels: [{ id: "main" }], studies: [],
      series: [{ id: "price", source: { kind: "security", instrument: request.instrument, fieldId: "market.close" },
        style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none" }],
    };
    const model = await loadChartPaneModel(spec, { marketData: router } as HeadlessPaneContext);
    const points = model.series[0]!.points;
    expect(points.map((point) => point.value)).toEqual([100, null, 110, 111, null]);
    const scene = buildCompositeChartScene(model.series, spec.panels, { width: 80, height: 16 })!;
    expect(scene.endTime).toBe(history[4]!.date.getTime());
    expect(scene.cursorValues[0]!.value).toBeNull();
    expect(scene.panels[0]!.lastPrice).toBeUndefined();
    expect(applyCompositeChartCursor(scene, history[1]!.date).cursorValues[0]!.value).toBeNull();
    expect(applyCompositeChartCursor(scene, history[2]!.date).cursorValues[0]!.value).toBe(110);
    expect(Number.isNaN(history[1]!.close)).toBe(true);
  } finally { coordinator?.destroy(); persistence.close(); }
});

test("alternate and persisted histories retain missing dates without treating them as usable prices", async () => {
  const path = createTempDbPath("all-missing-history-fallback");
  let persistence = new AppPersistence(path);
  const dates = ["2025-09-10", "2026-08-10", "2026-09-10"];
  const missing = dates.map((date) => ({ date: new Date(date), close: Number.NaN }));
  const older = ["2025-09-09", "2026-08-07", "2026-09-10"]
    .map((date) => ({ date: new Date(date), close: 100 }));
  const calls = { missing: 0, values: 0 };
  const primary = { ...fallbackProvider, id: "missing-source", name: "Missing source",
    async getPriceHistory() { calls.missing++; return missing; } };
  const secondary = { ...fallbackProvider, id: "values-source", name: "Values source",
    async getPriceHistory() { calls.values++; return older; } };
  let coordinator: MarketDataCoordinator | undefined;
  try {
    let router = new AssetDataRouter(secondary, [primary], persistence.resources);
    const check = (points: PricePoint[]) => {
      expect(points).toHaveLength(5);
      expect(points.map((point) => new Date(point.date).toISOString().slice(0, 10)))
        .toEqual(["2025-09-09", "2025-09-10", "2026-08-07", "2026-08-10", "2026-09-10"]);
      expect(Number.isFinite(points[1]!.close)).toBe(false);
      expect(Number.isFinite(points[3]!.close)).toBe(false);
      // The alternate source explicitly recovers the ending observation.
      expect(points[4]!.close).toBe(100);
    };
    check(await router.getPriceHistory("GAP", "NYSE", "1Y"));
    expect(calls).toEqual({ missing: 1, values: 1 });
    persistence.close(); persistence = new AppPersistence(path);
    router = new AssetDataRouter(secondary, [primary], persistence.resources);
    check(await router.getPriceHistory("GAP", "NYSE", "1Y"));
    expect(calls).toEqual({ missing: 1, values: 1 });

    let response: PricePoint[] = older;
    const direct = { ...fallbackProvider, getPriceHistory: async () => response,
      getPriceHistoryForResolution: async () => response };
    coordinator = new MarketDataCoordinator(direct);
    const request = { instrument: { symbol: "DIRECT", exchange: "NYSE" }, bufferRange: "1Y" as const };
    expect((await coordinator.loadChart(request)).error).toBeNull();
    response = missing;
    const unavailable = await coordinator.loadChart(request, { forceRefresh: true });
    expect(unavailable.data).toEqual(missing);
    expect(unavailable.lastGoodData).toEqual(missing);
    expect(unavailable.error).toMatchObject({ reasonCode: "NO_DATA" });
    expect(unavailable.attempts[0]).toMatchObject({ status: "empty", reasonCode: "NO_DATA" });
    expect(resolveDatedReturns(unavailable.data!).returns).toEqual([]);
    const emptyModel = await loadChartPaneModel({
      version: CHART_SPEC_VERSION,
      viewport: { range: "1Y", resolution: "1d", dateWindow: { start: dates[0]!, end: dates[2]! } },
      panels: [{ id: "main" }], studies: [],
      series: [{ id: "price", source: { kind: "security", instrument: request.instrument, fieldId: "market.close" },
        style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none" }],
    }, { marketData: new AssetDataRouter(direct, []) } as HeadlessPaneContext);
    expect(emptyModel.series[0]!.points.map((point) => point.value)).toEqual([null, null, null]);
    expect(emptyModel.unavailableSymbols).toEqual(["DIRECT:XNYS"]);
    expect(emptyModel.snapshot.financials[0]![1].priceHistory.map((point) => point.date.toISOString().slice(0, 10))).toEqual(dates);
    response = dates.map((date, index) => ({ date: new Date(date), close: 100 + index }));
    const recovered = await coordinator.loadChart(request, { forceRefresh: true });
    expect(recovered.error).toBeNull();
    expect(recovered.attempts[0]?.status).toBe("success");
    expect(resolveDatedReturns(recovered.data!).returns).toHaveLength(2);
  } finally { coordinator?.destroy(); persistence.close(); }
});

test("all unavailable providers keep their reported dates while searching for usable fallback", async () => {
  const calls: string[] = [];
  const provider = (id: string, date: string) => ({ ...fallbackProvider, id, name: id,
    getPriceHistory: async () => { calls.push(id); return [{ date: new Date(date), close: Number.NaN }]; } });
  const router = new AssetDataRouter(provider("second", "2026-08-10"), [provider("first", "2025-09-10")]);
  const result = await router.getPriceHistory("GAP", "NYSE", "1Y");
  expect(calls).toEqual(["first", "second"]);
  expect(result.map((point) => new Date(point.date).toISOString().slice(0, 10)))
    .toEqual(["2025-09-10", "2026-08-10"]);
  expect(result.every((point) => !Number.isFinite(point.close))).toBe(true);
});
