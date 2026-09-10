import { expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/headless";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { correlationHeadless, relationshipHeadless } from "./headless";

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
  expect(result.stats?.find((stat) => stat.key === "beta")?.value).toBeCloseTo(1);
});
