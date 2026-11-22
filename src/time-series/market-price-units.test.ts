import { expect, test } from "bun:test";
import { createTestDataProvider } from "../test-support/data-provider";
import { resolveChartSpecData } from "./resolve";
import { seedChartResolutionResult } from "./chart-seed";
import { summarizeResolvedSeries } from "./reporting";
import { chartQuoteOverrideKeyForSource } from "./live-quotes";
import { CHART_SPEC_VERSION, type ChartSpec, type SeriesTransform } from "./types";

const history = [
  { date: new Date("2026-09-09"), open: 0.000004, high: 0.000006, low: 0.000003, close: 0.000005, volume: 100 },
  { date: new Date("2026-09-10"), open: 0.000005, high: 0.000007, low: 0.000004, close: 0.000006, volume: 120 },
];
const spec = (transform: SeriesTransform = "raw"): ChartSpec => ({
  version: CHART_SPEC_VERSION, viewport: { range: "1M", resolution: "1d" }, panels: [{ id: "main" }], studies: [],
  series: ["ohlcv", "open", "high", "low", "close"].map((field) => ({
    id: field, source: { kind: "security", instrument: { symbol: "SHIB-USD", exchange: "CCC" }, fieldId: `market.${field}` },
    style: field === "ohlcv" ? "candles" : "line", transform, axis: "left", panelId: "main", interpolation: "none",
  })),
});
const resolve = (instrumentType?: string, transform: SeriesTransform = "raw", chart = spec(transform)) => resolveChartSpecData(chart, {
  now: new Date("2026-09-11"),
  dataProvider: createTestDataProvider({
    getQuote: async () => ({ symbol: "SHIB-USD", listingExchangeName: "CCC", currency: "USD", instrumentType, price: 999, change: 0, changePercent: 0, lastUpdated: Date.parse("2026-09-11") }),
    getPriceHistory: async () => history,
    getPriceHistoryForResolution: async () => history,
  }),
});

test("crypto price units use source type across OHLCV and scalar fields without inferring volume or changing prices", async () => {
  for (const type of ["CRYPTOCURRENCY", "Digital Currency"]) {
    const result = await resolve(type);
    expect(result.errors).toEqual([]);
    expect(result.series.map((entry) => entry.unit)).toEqual(Array(5).fill("USD/unit"));
    expect(result.series.map((entry) => summarizeResolvedSeries(entry).unit)).toEqual(Array(5).fill("USD/unit"));
    expect(result.series.every((entry) => entry.unitGroup === "price:USD" && entry.volumeUnit === undefined)).toBe(true);
    expect(result.series.find((entry) => entry.id === "close")?.points.map((point) => point.value)).toEqual([0.000005, 0.000006]);
  }
});

test("share denominations require equity metadata; crypto-shaped symbols cannot establish instrument type", async () => {
  for (const type of ["EQUITY", "ETF"]) {
    expect((await resolve(type)).series.map((entry) => entry.unit)).toEqual(Array(5).fill("USD/share"));
  }
  for (const type of [undefined, "", "CURRENCY"]) {
    expect((await resolve(type)).series.map((entry) => entry.unit)).toEqual(Array(5).fill("USD"));
  }
  // A loading seed draws with what the last settled chart of the listing knew
  // (USD, no instrument type), never with a type read from the symbol's shape.
  const chart = spec();
  const seeded = seedChartResolutionResult(chart, new Map(chart.series.map((entry) => [chartQuoteOverrideKeyForSource(entry.source), history])));
  expect(seeded?.series.map((entry) => entry.unit)).toEqual(Array(5).fill("USD"));
});

test("normalized crypto prices keep the original unit in raw-value provenance", async () => {
  const result = await resolve("CRYPTOCURRENCY", "index100");
  const close = result.series.find((entry) => entry.id === "close")!;
  expect(close.rawUnit).toBe("USD/unit");
  expect(close.unit).toBe("index");
  expect(close.points.map((point) => point.value)).toEqual([100, 120]);
  expect(close.points.map((point) => point.rawValue)).toEqual([0.000005, 0.000006]);
});

test("futures and unknown price bases stay available as raw prices but cannot establish a spread", async () => {
  for (const instrumentType of ["FUTURE", undefined]) {
    const chart = spec();
    chart.series = chart.series.slice(0, 2);
    chart.studies = ["ratio", "spread"].map((kind) => ({
      id: kind, kind: kind as "ratio" | "spread", inputSeriesIds: chart.series.map(({ id }) => id), color: "#fff",
      parameters: {}, panelId: "main", axis: "auto",
    }));
    const before = await resolve(instrumentType, "raw", { ...chart, studies: [chart.studies[0]!] });
    const result = await resolve(instrumentType, "raw", chart);
    expect(result.series.filter(({ id }) => id !== "spread")).toEqual(before.series);
    expect(result.series.some(({ id }) => id === "spread")).toBe(false);
    expect(result.series.find(({ id }) => id === "ratio")?.unit).toBe("unknown");
    expect(result.errors).toEqual([expect.stringContaining("a spread needs both in one known unit.")]);
  }
});

test("a future's price counts what its contract terms say, asked once per symbol, and a seed states the same unit", async () => {
  const asked: string[] = [];
  const units: Record<string, string | null> = { "HO=F": "USD / gallon", "ZC=F": "US cents / bushel", "TTF=F": "USD / MWh" };
  const currencies: Record<string, string> = { "HO=F": "USD", "ZC=F": "USX", "TTF=F": "EUR", "ES=F": "USD", AAPL: "USD" };
  const chart: ChartSpec = {
    version: CHART_SPEC_VERSION, viewport: { range: "1M", resolution: "1d" }, panels: [{ id: "main" }], studies: [],
    series: [["HO=F", "ohlcv"], ["HO=F", "close"], ["ZC=F", "close"], ["TTF=F", "close"], ["ES=F", "close"], ["AAPL", "close"]].map(([symbol, field]) => ({
      id: `${symbol}:${field}`, source: { kind: "security", instrument: { symbol: symbol! }, fieldId: `market.${field}` },
      style: "line", transform: "raw", axis: "left", panelId: "main", interpolation: "none",
    })),
  };
  const result = await resolveChartSpecData(chart, {
    now: new Date("2026-09-11"),
    loadFuturesPriceUnit: async (symbol) => {
      asked.push(symbol);
      return units[symbol] ?? null;
    },
    dataProvider: createTestDataProvider({
      getQuote: async (symbol) => ({ symbol, currency: currencies[symbol], instrumentType: symbol === "AAPL" ? "EQUITY" : "FUTURE",
        price: 1, change: 0, changePercent: 0, lastUpdated: Date.parse("2026-09-11") }),
      getPriceHistory: async () => history,
      getPriceHistoryForResolution: async () => history,
    }),
  });
  // A unit in another currency than the quote's is not the price's; index futures read in points.
  expect(result.series.map(({ unit, statedUnit }) => [unit, statedUnit])).toEqual([
    ["USD / gallon", "USD / gallon"], ["USD / gallon", "USD / gallon"], ["US cents / bushel", "US cents / bushel"],
    ["unknown", undefined], ["points", undefined], ["USD/share", undefined],
  ]);
  expect(asked.sort()).toEqual(["HO=F", "TTF=F", "ZC=F"]);
  const seeded = seedChartResolutionResult(chart, new Map(chart.series.map((entry) => [chartQuoteOverrideKeyForSource(entry.source), history])));
  expect(seeded?.series.slice(0, 3).map(({ unit }) => unit)).toEqual(["USD / gallon", "USD / gallon", "US cents / bushel"]);
});

test("a currency pair counts its quote currency per unit of its base, and prices per different quantities take their own axes", async () => {
  const units: Record<string, string> = { "HO=F": "USD / gallon", "BZ=F": "USD / barrel", "RB=F": "USD / gallon" };
  const chart: ChartSpec = {
    version: CHART_SPEC_VERSION, viewport: { range: "1M", resolution: "1d" }, panels: [{ id: "main" }], studies: [],
    series: ["HO=F", "BZ=F", "RB=F", "EURUSD=X", "USDJPY=X"].map((symbol) => ({
      id: symbol, source: { kind: "security", instrument: { symbol }, fieldId: "market.close" },
      style: "line", transform: "raw", axis: "auto", panelId: symbol.endsWith("=X") ? "fx" : "main", interpolation: "none",
    })),
  };
  const result = await resolveChartSpecData(chart, {
    now: new Date("2026-09-11"),
    loadFuturesPriceUnit: async (symbol) => units[symbol] ?? null,
    dataProvider: createTestDataProvider({
      getQuote: async (symbol) => ({ symbol, currency: symbol === "USDJPY=X" ? "JPY" : "USD", instrumentType: symbol.endsWith("=X") ? "CURRENCY" : "FUTURE",
        price: 1, change: 0, changePercent: 0, lastUpdated: Date.parse("2026-09-11") }),
      getPriceHistory: async () => history,
      getPriceHistoryForResolution: async () => history,
    }),
  });
  expect(result.series.map(({ id, unit, axis }) => [id, unit, axis])).toEqual([
    // Heating oil and gasoline share the per-gallon axis; Brent per barrel reads on the other.
    ["HO=F", "USD / gallon", "left"], ["BZ=F", "USD / barrel", "right"], ["RB=F", "USD / gallon", "left"],
    // Two rates in their own panel: dollars per euro, yen per dollar.
    ["EURUSD=X", "USD / EUR", "left"], ["USDJPY=X", "JPY / USD", "right"],
  ]);
  expect(result.warnings.filter((warning) => warning.includes("axis"))).toEqual([]);
});

test("a series whose history fails keeps the unit its quote, contract terms or symbol give, never a bare currency", async () => {
  const chart: ChartSpec = {
    version: CHART_SPEC_VERSION, viewport: { range: "1D", resolution: "5m" }, panels: [{ id: "main" }], studies: [],
    series: ["^VIX", "DX-Y.NYB", "GC=F", "^RUT"].map((symbol) => ({
      id: symbol, source: { kind: "security", instrument: { symbol }, fieldId: "market.price" },
      style: "line", transform: "raw", axis: "auto", panelId: "main", interpolation: "none",
    })),
  };
  const result = await resolveChartSpecData(chart, {
    now: new Date("2026-11-22T06:29:00Z"),
    loadFuturesPriceUnit: async (symbol) => symbol === "GC=F" ? "USD / troy oz" : null,
    dataProvider: createTestDataProvider({
      // ^RUT's quote fails too: its symbol still says it is an index.
      getTickerFinancials: async (symbol) => {
        if (symbol === "^RUT") throw new Error("No quote");
        return { annualStatements: [], quarterlyStatements: [], priceHistory: [], quote: { symbol, currency: "USD",
          instrumentType: symbol === "GC=F" ? "FUTURE" : "INDEX", price: 1, change: 0, changePercent: 0, lastUpdated: Date.parse("2026-11-20T22:00:00Z") } };
      },
      getPriceHistory: async () => { throw new Error("No bars"); },
      getPriceHistoryForResolution: async () => { throw new Error("No bars"); },
    }),
  });
  expect(result.series.map(({ id, unit, points }) => [id, unit, points.length])).toEqual([
    ["^VIX", "points", 0], ["DX-Y.NYB", "points", 0], ["GC=F", "USD / troy oz", 0], ["^RUT", "points", 0],
  ]);
});

test("a day chart whose first listing has no bars shows the next listing's last session, not a weekend's rolling day", async () => {
  const step = 5 * 60_000, open = Date.parse("2026-11-19T23:00:00Z");
  // Gold's Globex day to Friday's 17:00 Chicago close; read on Sunday morning.
  const gold = Array.from({ length: 277 }, (_, index) => ({ date: new Date(open + index * step), open: 3500, high: 3501, low: 3499, close: 3500, volume: 10 }));
  const chart: ChartSpec = {
    version: CHART_SPEC_VERSION, viewport: { range: "1D", resolution: "5m" }, panels: [{ id: "main" }], studies: [],
    series: [{ symbol: "^VIX", exchange: "CBOE INDICES" }, { symbol: "GC=F", exchange: "CMX" }].map((instrument) => ({
      id: instrument.symbol, source: { kind: "security", instrument, fieldId: "market.price" },
      style: "line", transform: "raw", axis: "auto", panelId: "main", interpolation: "none",
    })),
  };
  const history = async (symbol: string) => {
    if (symbol === "^VIX") throw new Error("No bars");
    return gold;
  };
  const result = await resolveChartSpecData(chart, {
    now: new Date("2026-11-22T07:48:00Z"),
    dataProvider: createTestDataProvider({
      getTickerFinancials: async (symbol) => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [], quote: { symbol, currency: "USD",
        instrumentType: symbol === "GC=F" ? "FUTURE" : "INDEX", price: 3500, change: 0, changePercent: 0, lastUpdated: Date.parse("2026-11-20T22:00:00Z") } }),
      getPriceHistory: history,
      getPriceHistoryForResolution: history,
    }),
  });
  expect(result.series.find((entry) => entry.id === "^VIX")?.points).toEqual([]);
  expect([result.viewport.start?.toISOString(), result.viewport.end?.toISOString()]).toEqual(["2026-11-19T23:00:00.000Z", "2026-11-20T22:00:00.000Z"]);
});
