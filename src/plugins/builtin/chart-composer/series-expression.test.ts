import { describe, expect, test } from "bun:test";
import {
  formatSeriesExpression,
  GEO_SERIES_CAPABILITY_ID,
  parseChartExpression,
  parseSeriesExpression,
  resolveChartFieldAlias,
} from "./series-expression";
import { buildSeriesSpec } from "./chart-spec-edit";
import { buildCustomChartPreset, buildPriceChartPreset } from "./presets";
import { getSelectedPairStudies } from "./studies";

describe("chart composer expressions", () => {
  test("round-trips bounded provider-neutral capability expressions", () => {
    const expression = {
      kind: "capability" as const,
      capabilityId: "prediction-markets.series",
      seriesId: "polymarket/event-1/market-1",
      label: "Will it happen?",
    };
    const series = buildSeriesSpec(expression, 0);
    expect(parseSeriesExpression(formatSeriesExpression(series))).toEqual({
      kind: "capability",
      capabilityId: expression.capabilityId,
      seriesId: expression.seriesId,
    });
    expect(parseSeriesExpression("CAP:provider:series?params=%7B%7D")).toBeNull();
    expect(parseSeriesExpression(`CAP:${"x".repeat(81)}:series`)).toBeNull();
    expect(parseSeriesExpression(`CAP:provider:${"x".repeat(241)}`)).toBeNull();
  });

  test("maps futures and Treasury aliases onto existing core source kinds", () => {
    expect(parseSeriesExpression("fut:es")).toEqual({
      kind: "security",
      symbol: "ES=F",
      fieldId: "market.ohlcv",
      label: "E-Mini S&P 500",
    });
    expect(parseSeriesExpression("ust:10y")).toEqual({
      kind: "economic",
      provider: "fred",
      seriesId: "DGS10",
      label: "10Y Treasury Yield",
    });
    expect(parseSeriesExpression("FUT:UNKNOWN")).toBeNull();
    expect(parseSeriesExpression("UST:4Y")).toBeNull();
  });

  test("accepts catalog aliases and FRED series in one expression", () => {
    expect(parseChartExpression(
      "aapl:price; msft:Free Cash Flow Margin\nFRED:CPIAUCSL",
    )).toEqual([
      { kind: "security", symbol: "AAPL", fieldId: "market.ohlcv" },
      { kind: "security", symbol: "MSFT", fieldId: "fundamental.freeCashFlowMargin" },
      { kind: "economic", provider: "fred", seriesId: "CPIAUCSL" },
    ]);
    expect(resolveChartFieldAlias("EV / EBITDA")).toBe("valuation.evEbitda");
  });

  test("reads map series as GEO legs beside tickers and writes them back the same way", () => {
    const [stock, transits] = parseChartExpression("XOM, geo:HORMUZ");
    expect(stock).toEqual({ kind: "security", symbol: "XOM", fieldId: "market.ohlcv" });
    expect(transits).toEqual({ kind: "capability", capabilityId: GEO_SERIES_CAPABILITY_ID, seriesId: "HORMUZ" });
    expect(formatSeriesExpression(buildSeriesSpec(transits!, 1))).toBe("GEO:HORMUZ");
    expect(parseSeriesExpression("GEO:chokepoints.suez.transits")).toMatchObject({ seriesId: "chokepoints.suez.transits" });
    expect(parseSeriesExpression("GEO:")).toBeNull();
    expect(parseSeriesExpression("GEO:a b")).toBeNull();
  });

  test("rejects an invalid leg instead of silently building a partial chart", () => {
    expect(() => buildCustomChartPreset("AAPL:price, MSFT:revenu"))
      .toThrow('Invalid chart series "MSFT:revenu"');
  });

  test("a stray separator in a pasted list adds no series: trailing, leading and doubled commas", () => {
    const symbols = (value: string) => parseChartExpression(value).map((leg) => leg.kind === "security" ? leg.symbol : leg.kind);
    for (const value of ["BRK.B,SPY,", ",BRK.B,SPY", "BRK.B,,SPY", " BRK.B , ; SPY ,\n"]) expect(symbols(value), value).toEqual(["BRK.B", "SPY"]);
    // Separators alone are an error, as an empty leg was; no input at all is no chart yet.
    expect(() => parseChartExpression(" , ;")).toThrow('Invalid chart series ", ;": no series between its separators.');
    expect(parseChartExpression("  ")).toEqual([]);
  });

  test("an unspaced slash between two tickers is their ratio, and a real pair stays one series", () => {
    const ratio = buildCustomChartPreset("GAA/VOO");
    expect(ratio.series.map((series) => series.source)).toEqual([
      expect.objectContaining({ kind: "security", instrument: { symbol: "GAA" }, fieldId: "market.ohlcv" }),
      expect.objectContaining({ kind: "security", instrument: { symbol: "VOO" }, fieldId: "market.ohlcv" }),
    ]);
    expect(getSelectedPairStudies(ratio)).toEqual(["ratio"]);
    expect(getSelectedPairStudies(buildCustomChartPreset("MSFT:revenue/AAPL:revenue"))).toEqual(["ratio"]);
    expect(getSelectedPairStudies(buildCustomChartPreset("GAA / VOO"))).toEqual(["ratio"]);
    expect(getSelectedPairStudies(buildCustomChartPreset("CL=F - ES=F"))).toEqual(["spread"]);

    expect(buildCustomChartPreset("EUR/USD").series).toHaveLength(1);
    expect(getSelectedPairStudies(buildCustomChartPreset("EUR/USD"))).toEqual([]);
    expect(buildCustomChartPreset("BTC/USD").series).toHaveLength(1);
    expect(buildCustomChartPreset("AAPL:EV/EBITDA").series[0]?.source).toMatchObject({
      kind: "security",
      instrument: { symbol: "AAPL" },
      fieldId: "valuation.evEbitda",
    });
    expect(getSelectedPairStudies(buildCustomChartPreset("AAPL, MSFT"))).toEqual([]);
  });

  test("preserves futures and forex identifiers in direct and custom chart presets", () => {
    for (const symbol of ["ES=F", "6J=F", "JPY=X", "EURUSD=X", "EUR/USD"]) {
      const spec = buildPriceChartPreset(symbol);
      expect(spec.series[0]?.source).toMatchObject({ kind: "security", instrument: { symbol } });
      expect(parseSeriesExpression(formatSeriesExpression(spec.series[0]!)))
        .toMatchObject({ kind: "security", symbol });
      expect(buildCustomChartPreset(`${symbol}:price`).series[0]?.source)
        .toMatchObject({ kind: "security", instrument: { symbol } });
    }
  });

  test("parses exchange-qualified tickers without confusing the exchange for a field", () => {
    const spec = buildCustomChartPreset("3hnx:lse, 3HNX:LSE:revenue");

    expect(spec.series.map((series) => series.source)).toEqual([
      expect.objectContaining({
        kind: "security",
        instrument: { symbol: "3HNX", exchange: "LSE" },
        fieldId: "market.ohlcv",
      }),
      expect.objectContaining({
        kind: "security",
        instrument: { symbol: "3HNX", exchange: "LSE" },
        fieldId: "fundamental.totalRevenue",
      }),
    ]);
  });
});
