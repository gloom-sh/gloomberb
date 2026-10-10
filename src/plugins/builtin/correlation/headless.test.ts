import { expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneEntry, HeadlessPaneLoadArgs, HeadlessSeriesResult } from "../../../types/headless";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { correlationHeadless, relationshipHeadless } from "./headless";
import { buildCorrelationMatrix, buildCorrelationSeries, buildStatusSummary, pairKey } from "./matrix/model";

function args(symbols: string[]): HeadlessPaneLoadArgs {
  return { symbols, argument: symbols, rawArgument: symbols.join(","), options: { range: "ALL", rangePreset: "1Y", correlationWindow: 5 } };
}

function context(missing = "", disjoint = false): HeadlessPaneContext {
  return {
    signal: new AbortController().signal,
    marketData: createTestDataProvider({
      async getPriceHistory(symbol) {
        if (symbol === missing) throw new Error("No history");
        return [100, 110, 105, 115, 111, 118, 130].map((close, index) => ({
          date: new Date(Date.UTC(2026, disjoint && symbol === "SPY" ? 5 : 0, index + 1)),
          close: close * (symbol === "SPY" ? 2 : 1),
        }));
      },
    }),
  } as HeadlessPaneContext;
}

/** The relationship report lists its figures as entries, not as a keyed record. */
function statEntries(result: HeadlessSeriesResult): HeadlessPaneEntry[] {
  if (!Array.isArray(result.stats)) throw new Error("Expected stat entries");
  return result.stats;
}

test("correlation retains usable pairs and marks failed histories without discarding their peers", async () => {
  const result = await correlationHeadless.load(args(["ABC", "SPY", "MISSING"]), context("MISSING"));
  expect(result.rows[0]).toMatchObject({ left: "ABC", right: "SPY", sampleSize: 6 });
  expect(result.rows[0]!.correlation).toBeCloseTo(1);
  expect(result.rows[1]).toMatchObject({ right: "MISSING", correlation: null, sampleSize: 0 });
  expect(result.unavailableSymbols).toEqual(["MISSING"]);
});

test("relationship supplies the default benchmark, ratio history, rolling correlation, and regression", async () => {
  const result = await relationshipHeadless.load(args(["ABC"]), context());
  expect(result.symbols).toEqual(["ABC", "SPY"]);
  expect(result.series[0]!.points).toHaveLength(7);
  expect(result.series[0]!.points.at(-1)?.value).toBe(0.5);
  expect(result.series[1]!.points.at(-1)?.value).toBeCloseTo(1);
  expect(result.metadata).toMatchObject({ right: "SPY", alignedPriceCount: 7, returnCount: 6, regression: { beta: 1, rSquared: 1, sampleSize: 6 } });
  expect(result.unavailableSymbols).toEqual([]);
});

test("relationship notes mixed session closes only, and keeps a small ratio's digits in its figure", async () => {
  const ctx = {
    ...context(),
    resolveInstrument: async (key: string) => ({ symbol: key, exchange: key === "BTC-USD" ? "CCC" : "NASDAQ" }),
    marketData: createTestDataProvider({
      getPriceHistory: async (symbol) => [100, 110, 105, 115, 111, 118, 130].map((close, index) => ({
        date: new Date(Date.UTC(2026, 0, index + 1)), close: close * (symbol === "BTC-USD" ? 150_000 : 1),
      })),
    }),
  } as HeadlessPaneContext;
  const mixed = await relationshipHeadless.load(args(["IBIT", "BTC-USD"]), ctx);
  expect(mixed.metadata?.notices).toEqual(["IBIT closes 21:00 UTC; BTC-USD bar is 00:00 UTC (3 h offset). Daily pairs are matched by date."]);
  expect(statEntries(mixed).find((stat) => stat.key === "latestRatio")?.formatted).toBe("0.000006667");
  expect((await relationshipHeadless.load(args(["IBIT", "MSFT"]), ctx)).metadata?.notices).toBeUndefined();
});

test("one usable pair cannot make a matrix with disjoint histories look complete", async () => {
  const result = await correlationHeadless.load(args(["ABC", "DEF", "SPY"]), context("", true));
  expect(result.rows[0]!.correlation).toBeCloseTo(1);
  expect(result.rows.slice(1).every((row) => row.correlation == null)).toBe(true);
  expect(result.errors).toHaveLength(2);
  expect(result.metadata?.unavailablePairs).toEqual([
    { left: "ABC", right: "SPY", sampleSize: 0, reason: "Insufficient shared return observations" },
    { left: "DEF", right: "SPY", sampleSize: 0, reason: "Insufficient shared return observations" },
  ]);
});

test("relationship identifies just the missing benchmark, and both inputs when dates do not overlap", async () => {
  const partial = await relationshipHeadless.load(args(["ABC"]), context("SPY"));
  expect(partial.unavailableSymbols).toEqual(["SPY"]);
  expect(partial.series.every((series) => series.points.length === 0)).toBe(true);
  const disjoint = await relationshipHeadless.load(args(["ABC"]), context("", true));
  expect(disjoint.unavailableSymbols).toEqual(["ABC", "SPY"]);
  expect(disjoint.metadata).toMatchObject({ alignedPriceCount: 0, returnCount: 0, regression: null });
});

test("rolling correlation waits for the entire selected observation window", async () => {
  const request = args(["ABC"]);
  request.options.correlationWindow = 30;
  const result = await relationshipHeadless.load(request, context());
  expect(result.series[0]!.points).toHaveLength(7);
  expect(result.series[1]!.points).toHaveLength(0);
  expect(result.metadata).toMatchObject({ latestCorrelation: null, returnCount: 6 });
  expect(statEntries(result).find((stat) => stat.key === "beta")?.value).toBeCloseTo(1);
});


test("inconsistent OHLC quarantines risk windows, retains original diagnostics and leaves independent pairs usable", async () => {
  const ctx = context();
  const cleanHistory = await ctx.marketData.getPriceHistory("SPY", "", "1Y");
  // Captured SPY contradiction: reported open exceeds reported high.
  const corrupt = { ...cleanHistory[3]!, open: 764.0800, high: 758.555, low: 757.570, close: 758.150, volume: 3461376 };
  const history = cleanHistory.map((point, index) => index === 3 ? corrupt : point);
  ctx.marketData = createTestDataProvider({ getPriceHistory: async (symbol) => symbol === "SPY" ? history : cleanHistory });
  const bySymbol = new Map([
    ["ABC", buildCorrelationSeries("ABC", cleanHistory)],
    ["SPY", buildCorrelationSeries("SPY", history)],
    ["CONSTANT", buildCorrelationSeries("CONSTANT", cleanHistory.map(point => ({ ...point, close: 100 })))],
  ]);
  const matrix = buildCorrelationMatrix([...bySymbol.keys()], bySymbol);
  expect(matrix.results.get(pairKey("ABC", "ABC"))?.correlation).toBeCloseTo(1);
  expect(matrix.results.get(pairKey("SPY", "SPY"))?.correlation).toBeNull();
  expect(matrix.results.get(pairKey("CONSTANT", "CONSTANT"))?.correlation).toBeNull();
  expect(matrix.hasThinPair).toBe(false);
  expect(buildStatusSummary([...bySymbol.keys()], bySymbol, matrix.sampleMin, matrix.sampleMax, matrix.hasThinPair)).toContain("Inconsistent OHLC: SPY");
  const result = await correlationHeadless.load(args(["ABC", "DEF", "SPY"]), ctx);
  expect(result.rows[0]!.correlation).toBeCloseTo(1);
  expect(result.rows.slice(1).every((row) => row.correlation === null && row.sampleSize === 0)).toBe(true);
  expect(result.unavailableSymbols).toEqual(["SPY"]);
  expect(result.errors?.every((error) => error.includes("Inconsistent OHLC"))).toBe(true);
  expect(result.metadata?.availability).toEqual(expect.arrayContaining([expect.objectContaining({
    symbol: "SPY", status: "invalid", integrity: [expect.objectContaining({ sourcePoints: [expect.objectContaining({ open: 764.0800, high: 758.555, close: 758.150 })] })],
  })]));
  const relationship = await relationshipHeadless.load(args(["ABC", "SPY"]), ctx);
  expect(relationship.series.every((series) => series.points.length === 0)).toBe(true);
  expect(statEntries(relationship).filter((stat) => stat.key !== "returnCount").every((stat) => stat.value === null)).toBe(true);
  expect(relationship.unavailableSymbols).toEqual(["SPY"]);
  expect(relationship.errors).toEqual([expect.stringContaining("Inconsistent OHLC")]);
  expect(relationship.metadata?.integrity).toMatchObject({ right: [{ sourcePoints: [expect.objectContaining({ close: corrupt.close })] }] });
  expect(history[3]).toBe(corrupt);
  expect(history[3]!.open).toBe(764.0800);
  ctx.marketData = createTestDataProvider({ getPriceHistory: async () => cleanHistory });
  const recovered = await relationshipHeadless.load(args(["ABC", "SPY"]), ctx);
  expect(statEntries(recovered).find((stat) => stat.key === "rSquared")?.value).toBeCloseTo(1);
  expect(recovered.errors).toEqual([]);
});

test("risk consumers request daily bars, clip oversized buffers, and disclose incomplete rolling windows", async () => {
  const ctx = context();
  const source = await ctx.marketData.getPriceHistory("ABC", "", "1Y");
  const calls: unknown[][] = [];
  ctx.marketData = createTestDataProvider({
    getPriceHistory: async () => { throw new Error("Automatic resolution must not be used"); },
    getPriceHistoryForResolution: async (...request) => {
      calls.push(request);
      return [{ date: new Date("2025-01-01"), close: 1 }, ...source];
    },
  });
  const request = args(["ABC", "SPY"]);
  request.options = { range: "1M", rangePreset: "1M", correlationWindow: 30 };
  const correlation = await correlationHeadless.load(request, ctx);
  const relationship = await relationshipHeadless.load(request, ctx);
  expect(calls.map(call => call.slice(2, 4))).toEqual(Array.from({ length: 4 }, () => ["1M", "1d"]));
  expect(correlation.rows[0]?.sampleSize).toBe(6);
  expect(relationship.metadata).toMatchObject({ firstDate: "2026-01-01", lastDate: "2026-01-07", returnCount: 6 });
  expect(relationship.errors).toEqual(["Rolling correlation needs 30 shared returns; 6 available."]);
  expect(relationship.metadata?.returnAlignment).toContain("cash distributions and FX conversion are excluded");
});

test("a zero-variance latest rolling window never publishes an older correlation as current", async () => {
  const ctx = context();
  ctx.marketData = createTestDataProvider({ getPriceHistory: async () => [100, 110, 105, 120, 115, 130, 130, 130, 130, 130, 130].map((close, i) => ({ date: new Date(Date.UTC(2026, 8, i + 1)), close })) });
  const result = await relationshipHeadless.load(args(["ABC", "SPY"]), ctx);
  expect(result.series[1]?.points.length).toBeGreaterThan(0);
  expect(result.series[1]?.points.at(-1)).toEqual({ date: "2026-09-11T00:00:00.000Z", value: null });
  expect(statEntries(result).find(stat => stat.key === "latestCorrelation")?.value).toBeNull();
  expect(result.metadata?.latestCorrelation).toBeNull();
  expect(result.errors).toEqual([expect.stringContaining("zero return variance in the latest 5 shared returns")]);
  expect(result.metadata?.regression).toMatchObject({ rSquared: 1, sampleSize: 10 });
});
