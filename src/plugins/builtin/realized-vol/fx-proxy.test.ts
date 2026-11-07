import { expect, test } from "bun:test";
import type { QueryEntry } from "../../../market-data/result-types";
import type { OptionsChain, PricePoint } from "../../../types/financials";
import type { ImpliedVolatilityApi } from "../iv-history/client";
import { realizedVolSemanticEvidence, realizedVolScreenshotEvidence, type RealizedVolEvidenceStatus } from "./evidence";
import { fxProxyIvLessRv, loadFxVolProxy } from "./fx-proxy";
import { realizedChartSeries } from "./chart-model";

const now = Date.UTC(2026, 10, 7, 2);
const day = 86_400_000;
const ready = <T>(data: T): QueryEntry<T> => ({ phase: "ready", data, lastGoodData: data, source: "test", fetchedAt: now - 1000,
  staleAt: now + 60_000, error: null, attempts: [] });

test("an FX pair's IV is its currency fund's IV30 on the ranked close, with how many of the fund's expiries price at the money", async () => {
  const asked: string[] = [];
  const iv = { impliedVolatility: async (path: string) => {
    asked.push(path);
    return { version: 1, symbol: "FXY", asOf: "2026-11-07", status: "ready", coverage: null, warnings: [],
      stats: { iv30: { value: 0.0807, date: "2026-11-04", method: "trade-close", rank: 29, percentile: 16, low: 0.058, high: 0.135,
        samples: 162, windowStart: "2025-11-04" }, iv90: null },
      // A newer quote with no IV30 is not the proxy: the ranked close is.
      latest: { date: "2026-11-06", method: "quote-mid", capturedAt: "2026-11-06T20:49:00Z", spot: 57.8,
        iv7: null, iv30: null, iv60: null, iv90: null, iv180: null, iv365: null },
      series: [] };
  } } as unknown as ImpliedVolatilityApi;
  // Two listed expiries, neither with a two-sided quote: none prices an ATM IV.
  const expiries = [Math.floor((now + 13 * day) / 1000), Math.floor((now + 41 * day) / 1000)];
  const chain: OptionsChain = { underlyingSymbol: "FXY", expirationDates: expiries, calls: [], puts: [] };
  const surface = { now: () => now, loadYieldCurve: async () => [], loadOptions: async () => ready(chain) };
  const proxy = await loadFxVolProxy({ symbol: "USDJPY=X" }, { iv, surface });
  expect(proxy).toMatchObject({ pair: "USDJPY", fund: "FXY", iv30: { value: 0.0807, date: "2026-11-04", method: "trade-close" },
    expiries: { usable: 0, read: 2 }, error: null });
  expect(asked[0]).toContain("symbol=FXY");
  // The CME yen future is the same pair; a stock is none, and a cross two funds hold has no single proxy.
  expect((await loadFxVolProxy({ symbol: "6J=F" }, { iv, surface }))?.fund).toBe("FXY");
  expect(await loadFxVolProxy({ symbol: "AAPL" }, { iv, surface })).toBeNull();
  expect(await loadFxVolProxy({ symbol: "EURJPY=X" }, { iv, surface })).toBeNull();
  expect(asked).toHaveLength(2);
});

test("IV30 less the pair's HV20 is read on the IV30's close, not on the pair's newer bars", () => {
  // Calm weekdays to the 4th, then two violent sessions after it.
  const history: PricePoint[] = Array.from({ length: 40 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 9, 1) + index * day), close: 150 * (1 + 0.003 * Math.sin(index)) }));
  const after = [{ date: new Date(Date.UTC(2026, 10, 10)), close: 140 }, { date: new Date(Date.UTC(2026, 10, 11)), close: 160 }];
  const proxy = { pair: "USDJPY", fund: "FXY", iv30: { value: 0.08, date: "2026-11-09", method: "trade-close" as const }, expiries: null, error: null };
  const calm = fxProxyIvLessRv(proxy, history);
  expect(fxProxyIvLessRv(proxy, [...history, ...after])).toEqual(calm);
  expect(calm.hv20).toBeGreaterThan(0);
  expect(calm.spread).toBeCloseTo(0.08 - calm.hv20!, 12);
  expect(fxProxyIvLessRv({ ...proxy, iv30: null }, history)).toEqual({ hv20: null, spread: null });
});

test("an FX pair's history chart is whole without an ATM IV, and draws the proxy's IV30 when there is one", () => {
  const history: PricePoint[] = Array.from({ length: 30 }, (_, index) => ({ date: new Date(Date.UTC(2026, 9, 1) + index * day), close: 150 + index }));
  const rolling = history.map((point) => ({ date: point.date as Date, values: { 10: 0.05 } }));
  const base: RealizedVolEvidenceStatus = { symbol: "USDJPY=X", view: "graph", estimator: "close-to-close", windows: [10], lookbackYears: 1,
    showIv: true, loading: false, stale: false, source: "test", asOf: "2026-10-30T00:00:00.000Z", errors: [], currentIv: null };
  const context = { resolved: { createOptions: { symbol: "USDJPY=X" }, options: { windows: "10" } }, payload: { financials: [] } } as never;
  const capture = (status: RealizedVolEvidenceStatus, iv: { value: number; date: Date; label: string } | null) =>
    realizedVolSemanticEvidence(realizedChartSeries({ history, rolling, windows: [10], priceUnit: "JPY", iv }, ["#fff", "#000"]), status);
  // A capture that does not know it is of a pair is partial without an ATM IV; one of the pair, which has no chain, is not.
  expect(realizedVolScreenshotEvidence.unavailable(capture(base, null), context)).toEqual(["USDJPY=X current ATM IV"]);
  const pair = capture({ ...base, fxPair: true, proxyIv: null }, null);
  expect(pair.complete).toBe(true);
  expect(realizedVolScreenshotEvidence.unavailable(realizedVolScreenshotEvidence.read(pair), context)).toEqual([]);
  // The proxy point drawn is the one the capture states.
  const date = new Date(Date.UTC(2026, 9, 28));
  const drawn = capture({ ...base, fxPair: true, proxyIv: { fund: "FXY", value: 8.07, date: date.toISOString() } },
    { value: 0.0807, date, label: "FXY IV30" });
  expect(realizedVolScreenshotEvidence.read(drawn)?.complete).toBe(true);
  expect(realizedVolScreenshotEvidence.read({ ...drawn, proxyIv: { fund: "FXY", value: 9, date: date.toISOString() } })).toBeNull();
});
