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

  // `fn G AAPL MSFT` passes "AAPL MSFT": two series, as `fn G AAPL,MSFT` charts them.
  test("tickers typed with spaces between them are a list; a Bloomberg code, a currency pair and a field with spaces are not, and say what to write", () => {
    const symbols = (value: string) => parseChartExpression(value).map((leg) => leg.kind === "security" ? leg.symbol : leg.kind);
    expect(symbols("AAPL MSFT")).toEqual(["AAPL", "MSFT"]);
    expect(symbols("AAPL MSFT, FRED:DGS10")).toEqual(["AAPL", "MSFT", "economic"]);
    expect(() => parseChartExpression("AAPL MSFT:revenu")).toThrow('Invalid chart series "AAPL MSFT:revenu". Separate series with commas: AAPL,MSFT:revenu.');
    // Words that are one thing, not tickers side by side, are told what to write instead of charting each.
    const hint = (value: string) => { try { parseChartExpression(value); return null; } catch (error) { return (error as Error).message.split(" Use SYMBOL")[0]; } };
    expect(hint("AAPL US Equity")).toBe('Invalid chart series "AAPL US Equity". That is a Bloomberg code: write it AAPL.');
    expect(hint("SPX Index")).toBe('Invalid chart series "SPX Index". That is a Bloomberg code: write it ^GSPC.');
    expect(hint("US Govt")).toContain("That is a Bloomberg security: write the ticker alone");
    expect(hint("EUR USD")).toBe('Invalid chart series "EUR USD". EUR USD reads as a currency pair: write it EUR/USD, or separate tickers with commas.');
    // A field with spaces in it is no list, and no list of commas is offered for its words.
    expect(parseSeriesExpression("MSFT:net income")).toMatchObject({ symbol: "MSFT", fieldId: "fundamental.netIncome" });
    expect(hint("AAPL MSFT:net income")).toBe('Invalid chart series "AAPL MSFT:net income".');
    // Two tickers that are not currencies, and a list with a field, are still lists.
    expect(symbols("AAPL USD2")).toEqual(["AAPL", "USD2"]);
    expect(parseChartExpression("AAPL:price MSFT").map((leg) => leg.kind === "security" ? `${leg.symbol}:${leg.fieldId}` : leg.kind)).toEqual(["AAPL:market.ohlcv", "MSFT:market.ohlcv"]);
    // A formula keeps its spaces and is no list.
    expect(buildCustomChartPreset("42*HO=F - CL=F").series.length).toBeGreaterThan(0);
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
    expect(buildCustomChartPreset("CAP:short-volume:ratio/AAPL").series.map((series) => series.source)).toEqual([
      expect.objectContaining({ kind: "capability", capabilityId: "short-volume", seriesId: "ratio/AAPL" }),
    ]);
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
