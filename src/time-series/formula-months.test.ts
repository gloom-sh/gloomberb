import { expect, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import type { PricePoint, Quote } from "../types/financials";
import { seedChartResolutionResult } from "./chart-seed";
import { withFormulaNextMonths } from "./formula-months";
import { chartQuoteOverrideKeyForSource, chartQuoteOverrideKeyForTarget, getLiveChartQuoteTargets } from "./live-quotes";
import { resolveChartSpecData } from "./resolve";
import { CHART_SPEC_VERSION, type ChartSeriesSpec, type ChartSpec } from "./types";

const leg = (id: string, symbol: string): ChartSeriesSpec => ({
  id, source: { kind: "security", instrument: { symbol, exchange: "" }, fieldId: "market.close" },
  style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none",
});

/** Gasoline less crude, priced in crude's month: the crack between crude's roll (17 Nov) and gasoline's (25 Nov). */
const crack: ChartSpec = {
  version: CHART_SPEC_VERSION,
  viewport: { range: "1M", resolution: "1d" },
  panels: [{ id: "main" }, { id: "formula" }],
  series: [leg("rb", "RB=F"), leg("cl", "CL=F")],
  studies: [{
    id: "formula", kind: "formula", inputSeriesIds: ["rb", "cl"], panelId: "formula", axis: "auto",
    parameters: { weight1: 42, perBarrel1: 1, weight2: -1, divisor: 1, rollsWith: 2 },
  }],
};

const bars = (contract: (day: number) => string | undefined, closes: Record<number, number>): PricePoint[] => (
  Object.entries(closes).map(([day, close]) => {
    const named = contract(Number(day));
    return { date: new Date(Date.UTC(2026, 10, Number(day))), open: close, high: close, low: close, close, ...(named ? { contract: named } : {}) };
  }));
const histories: Record<string, PricePoint[]> = {
  "CL=F": bars((day) => day < 17 ? "CLZ26" : "CLF27", { 16: 80, 17: 81, 18: 82, 19: 83 }),
  "RB=F": bars(() => "RBZ26", { 16: 2.5, 17: 2.51, 18: 2.52, 19: 2.53 }),
  RB2: bars(() => "RBF27", { 16: 2.45, 17: 2.46, 18: 2.47, 19: 2.48 }),
};
// Friday 20 Nov, before any bar of the day is served.
const now = new Date("2026-11-20T16:00:00Z");
const quote = (symbol: string, price: number): Quote => ({
  symbol, price, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.parse("2026-11-20T15:00:00Z"), instrumentType: "FUTURE",
});
const quotes: Record<string, Quote> = { "CL=F": quote("CL=F", 84), "RB=F": quote("RB=F", 2.54), RB2: quote("RB2", 2.49) };

const resolve = (failing?: string) => {
  const history = async (symbol: string) => {
    if (symbol === failing) throw new Error(`No history for ${symbol}.`);
    return histories[symbol] ?? [];
  };
  return resolveChartSpecData(crack, {
    now,
    loadFuturesPriceUnit: async (symbol) => symbol.startsWith("CL") ? "USD / barrel" : "USD / gallon",
    dataProvider: createTestDataProvider({
      getQuote: async (symbol) => quotes[symbol] ?? quote(symbol, 1),
      getPriceHistory: history,
      getPriceHistoryForResolution: history,
    }),
    quoteOverrides: new Map(getLiveChartQuoteTargets(crack).map((target) => [chartQuoteOverrideKeyForTarget(target), quotes[target.symbol]!])),
  });
};

test("between the rolls the crack's latest value, first paint and live quotes are in crude's month, from gasoline's next month", async () => {
  // The chart follows the next month's quote too, so today's value is not Dec gasoline against Jan crude.
  expect(getLiveChartQuoteTargets(crack).map((target) => target.symbol).sort()).toEqual(["CL=F", "RB2", "RB=F"]);
  const result = await resolve();
  const formula = result.series.find((entry) => entry.id === "formula")!;
  expect(formula.points.at(-1)).toMatchObject({ value: expect.closeTo(42 * 2.49 - 84, 9), legs: [{ contract: "RBF27" }, { contract: "CLF27" }] });
  expect(formula.points.slice(-2, -1)).toMatchObject([{ value: expect.closeTo(42 * 2.48 - 83, 9) }]);
  // Crude's own bars mark the day it rolled, as the formula's do, which an export's Roll column reads.
  expect(result.series.find((entry) => entry.id === "cl")!.points.flatMap((point) => point.roll ? [point.date.toISOString().slice(0, 10)] : []))
    .toEqual(["2026-11-17"]);

  // The first paint reads the next month from the cache as the settled chart does.
  const expanded = withFormulaNextMonths(crack);
  const seeded = seedChartResolutionResult(expanded, new Map(expanded.series.map((entry) => [
    chartQuoteOverrideKeyForSource(entry.source as Extract<ChartSeriesSpec["source"], { kind: "security" }>),
    histories[(entry.source as Extract<ChartSeriesSpec["source"], { kind: "security" }>).instrument.symbol]!,
  ])), now);
  expect(seeded?.series.map((entry) => entry.id)).toEqual(["rb", "cl", "formula"]);
  expect(seeded?.series.find((entry) => entry.id === "formula")?.points.at(-1))
    .toMatchObject({ value: expect.closeTo(42 * 2.48 - 83, 9), legs: [{ contract: "RBF27" }, { contract: "CLF27" }] });
});

test("a next month that does not load is named nowhere: the crack's note says its legs are in different months", async () => {
  const result = await resolve("RB2");
  const said = [...result.errors, ...result.warnings, ...result.coverageNotices ?? []];
  expect(said.filter((message) => message.includes("RB2"))).toEqual([]);
  expect(result.legendSeries?.map((entry) => entry.id)).toEqual(["rb", "cl", "formula"]);
  expect(said).toContainEqual(expect.stringContaining("legs in different months on"));
});
