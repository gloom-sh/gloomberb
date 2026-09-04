import { describe, expect, test } from "bun:test";
import { CHART_COMPOSER_PANE_ID, createDefaultConfig } from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import type { PricePoint, TickerFinancials } from "../../types/financials";
import {
  buildIntradayPriceChartPreset,
  buildPriceChartPreset,
} from "../../plugins/builtin/chart-composer/presets";
import type { MarketContext } from "../types";
import {
  buildDesktopShotPayload,
  intradayChartEvidenceMismatchesFor,
  shotUnusableReasonFor,
} from "./screenshot";
import type { ResolvedPaneFunction } from "./resolver";
import {
  resolveShotIntradaySessionWindow,
  resolveShotIntradayRequest,
} from "./intraday-shot";

function sessionBars(date: string, base: number): PricePoint[] {
  return [
    {
      date: new Date(`${date}T13:30:00.000Z`),
      open: base,
      high: base + 1,
      low: base - 1,
      close: base + 0.25,
      volume: 100,
    },
    {
      date: new Date(`${date}T13:35:00.000Z`),
      open: base + 0.25,
      high: base + 1.25,
      low: base,
      close: base + 0.5,
      volume: 200,
    },
  ];
}

function financials(priceHistory: PricePoint[] = []): TickerFinancials {
  return {
    quote: {
      symbol: "AAPL",
      price: 108,
      currency: "USD",
      change: 1,
      changePercent: 1,
      lastUpdated: Date.parse("2026-09-03T20:00:00.000Z"),
      listingExchangeName: "NASDAQ",
    },
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory,
  };
}

function contextWithProvider(provider: DataProvider): MarketContext {
  return {
    config: createDefaultConfig("/tmp/gloomberb-shot-test"),
    dataDir: "/tmp/gloomberb-shot-test",
    persistence: {
      pluginState: { get: () => null },
    },
    store: {
      loadTicker: async () => ({
        metadata: {
          ticker: "AAPL",
          exchange: "NASDAQ",
          currency: "USD",
          name: "Apple",
          portfolios: [],
          watchlists: [],
          positions: [],
          custom: {},
          tags: [],
        },
      }),
    },
    dataProvider: provider,
  } as unknown as MarketContext;
}

function resolvedChart(
  capabilityId: "intraday-price-chart" | "price-chart",
  spec: ReturnType<typeof buildIntradayPriceChartPreset>,
  options: Record<string, string>,
): ResolvedPaneFunction {
  return {
    pane: { id: CHART_COMPOSER_PANE_ID },
    capability: { id: capabilityId, options: [] },
    options,
    instance: {
      instanceId: `${capabilityId}:test`,
      paneId: CHART_COMPOSER_PANE_ID,
      title: "AAPL",
      binding: { kind: "fixed", symbol: "AAPL" },
      settings: { chartSpec: spec },
    },
    createOptions: { symbol: "AAPL" },
  } as unknown as ResolvedPaneFunction;
}

async function payloadFor(
  resolved: ResolvedPaneFunction,
  provider: DataProvider,
) {
  return buildDesktopShotPayload(
    resolved,
    contextWithProvider(provider),
    "AAPL",
    {},
    1200,
    675,
    "tokyo",
    1.5,
    null,
  );
}

describe("GIP session windows", () => {
  const history = [
    ...sessionBars("2026-08-27", 100),
    ...sessionBars("2026-08-28", 101),
    ...sessionBars("2026-08-31", 102),
    ...sessionBars("2026-09-01", 103),
    ...sessionBars("2026-09-02", 104),
    ...sessionBars("2026-09-03", 105),
  ];

  test("resolves the latest session, latest five sessions, and an explicit session", () => {
    const latest = resolveShotIntradaySessionWindow(history, {
      rangePreset: "1D",
      timeZone: "America/New_York",
    });
    expect(latest.sessionDates).toEqual(["2026-09-03"]);
    expect(latest.points).toHaveLength(2);

    const week = resolveShotIntradaySessionWindow(history, {
      rangePreset: "1W",
      timeZone: "America/New_York",
    });
    expect(week.sessionDates).toEqual([
      "2026-08-28",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
    ]);
    expect(week.points).toHaveLength(10);

    const explicit = resolveShotIntradaySessionWindow(history, {
      rangePreset: "1W",
      session: "2026-09-01",
      timeZone: "America/New_York",
    });
    expect(explicit.sessionDates).toEqual(["2026-09-01"]);
    expect(explicit.points.map((point) => point.close)).toEqual([103.25, 103.5]);
  });

  test("maps Auto to the preset interval and validates explicit dates", () => {
    expect(resolveShotIntradayRequest({ rangePreset: "1D", chartResolution: "auto" }))
      .toEqual({ rangePreset: "1D", resolution: "1m", session: null });
    expect(resolveShotIntradayRequest({ rangePreset: "1W", chartResolution: "auto" }))
      .toEqual({ rangePreset: "1W", resolution: "5m", session: null });
    expect(resolveShotIntradayRequest({
      rangePreset: "1W",
      chartResolution: "15m",
      session: "2026-09-02",
    })).toEqual({ rangePreset: "1D", resolution: "15m", session: "2026-09-02" });
    expect(() => resolveShotIntradayRequest({ session: "2026-02-30" }))
      .toThrow("real calendar date");
  });
});

describe("GIP screenshot payload", () => {
  test("injects resolution-aware intraday bars for GIP", async () => {
    const calls: Array<{ range: string; resolution: string }> = [];
    const history = [
      ...sessionBars("2026-09-02", 100),
      ...sessionBars("2026-09-03", 105),
    ];
    const provider = {
      id: "test",
      name: "Test",
      getTickerFinancials: async () => financials([
        { date: new Date("2026-09-03T00:00:00.000Z"), close: 105 },
      ]),
      getPriceHistory: async () => [],
      getPriceHistoryForResolution: async (_symbol, _exchange, range, resolution) => {
        calls.push({ range, resolution });
        return history;
      },
      getDetailedPriceHistory: async () => [],
    } as DataProvider;
    const spec = buildIntradayPriceChartPreset("AAPL");
    spec.viewport.resolution = "auto";
    const payload = await payloadFor(
      resolvedChart("intraday-price-chart", spec, {
        rangePreset: "1D",
        chartResolution: "auto",
      }),
      provider,
    );

    expect(calls).toEqual([{ range: "1W", resolution: "1m" }]);
    expect(payload.intradayHistories).toHaveLength(1);
    expect(payload.intradayHistories[0]).toMatchObject({
      symbol: "AAPL",
      exchange: "NASDAQ",
      rangePreset: "1D",
      resolution: "1m",
      requestedSession: null,
      sessionDates: ["2026-09-03"],
      unavailableReason: null,
    });
    expect(payload.intradayHistories[0]?.points).toHaveLength(2);
    expect(payload.financials[0]?.[1].priceHistory).toHaveLength(2);

    const renderedEvidence = [{
      role: "chart-data",
      metadata: {
        kind: "chart-composer",
        projectedPointCount: 2,
        baseSeries: [{
          pointCount: 2,
          first: { date: "2026-09-03T13:30:00.000Z", value: 105.25 },
          last: { date: "2026-09-03T13:35:00.000Z", value: 105.5 },
        }],
      },
    }];
    const resolved = resolvedChart("intraday-price-chart", spec, {
      rangePreset: "1D",
      chartResolution: "auto",
    });
    expect(intradayChartEvidenceMismatchesFor(resolved, payload, renderedEvidence as never))
      .toEqual([]);
    renderedEvidence[0]!.metadata.baseSeries[0]!.pointCount = 1;
    expect(intradayChartEvidenceMismatchesFor(resolved, payload, renderedEvidence as never))
      .toContain("rendered intraday point count does not match");
  });

  test("keeps GP on daily history without an intraday payload", async () => {
    let intradayCalls = 0;
    const daily = [
      { date: new Date("2026-09-02T00:00:00.000Z"), close: 100 },
      { date: new Date("2026-09-03T00:00:00.000Z"), close: 105 },
    ];
    const provider = {
      id: "test",
      name: "Test",
      getTickerFinancials: async () => financials(),
      getPriceHistory: async () => daily,
      getPriceHistoryForResolution: async () => {
        intradayCalls += 1;
        return [];
      },
    } as DataProvider;
    const payload = await payloadFor(
      resolvedChart("price-chart", buildPriceChartPreset("AAPL"), { rangePreset: "3M" }),
      provider,
    );

    expect(intradayCalls).toBe(0);
    expect(payload.intradayHistories).toEqual([]);
    expect(payload.financials[0]?.[1].priceHistory).toEqual(daily);
  });

  test("records an explicit unusable reason when no intraday bars exist", async () => {
    const provider = {
      id: "test",
      name: "Test",
      getTickerFinancials: async () => financials([
        { date: new Date("2026-09-03T00:00:00.000Z"), close: 105 },
      ]),
      getPriceHistory: async () => [],
      getPriceHistoryForResolution: async () => [],
      getDetailedPriceHistory: async () => [],
    } as DataProvider;
    const spec = buildIntradayPriceChartPreset("AAPL");
    spec.viewport.resolution = "auto";
    const resolved = resolvedChart("intraday-price-chart", spec, {
      rangePreset: "1D",
      chartResolution: "auto",
      session: "2020-01-02",
    });
    const payload = await payloadFor(resolved, provider);

    expect(payload.intradayHistories[0]?.points).toEqual([]);
    expect(payload.intradayHistories[0]?.start).toBe("2020-01-02T05:00:00.000Z");
    expect(payload.intradayHistories[0]?.end).toBe("2020-01-03T05:00:00.000Z");
    expect(payload.intradayHistories[0]?.unavailableReason)
      .toBe("No intraday price history is available for AAPL for session 2020-01-02.");
    expect(shotUnusableReasonFor(
      resolved,
      payload,
      {
        loadingStateDetected: false,
        errorStateDetected: false,
        emptyStateDetected: true,
      },
      ["AAPL"],
      false,
    )).toBe("No intraday price history is available for AAPL for session 2020-01-02.");
  });
});
