import { describe, expect, test } from "bun:test";
import { asksFirstRunTickers, tickerStepRows, tickerSuggestions, toggleTickerPick, type TickerPick } from "./tickers-step-model";

const pick = (symbol: string): TickerPick => ({ symbol, name: symbol });

describe("Which tickers do you follow?", () => {
  test("offers the picked desks' names in turn, and the general ones without a desk", () => {
    expect(tickerSuggestions(["futures", "fx"]).map((seed) => seed.ticker)).toEqual([
      "ES=F", "EURUSD=X", "NQ=F", "USDJPY=X", "CL=F", "GBPUSD=X",
    ]);
    // A name two desks share is offered once.
    expect(tickerSuggestions(["options", "active"]).map((seed) => seed.ticker)).toEqual(["SPY", "QQQ", "TSLA", "IWM", "NVDA", "AMD"]);
    expect(tickerSuggestions([])).toEqual(tickerSuggestions(["not-a-desk"]));
  });

  test("keeps every pick in view, and a fourth is ignored", () => {
    const suggestions = tickerSuggestions(["equities"]);
    const picks = [pick("ES=F"), pick("AAPL"), pick("9992")];
    const rows = tickerStepRows(picks, suggestions);
    expect(rows).toHaveLength(6);
    // Search's picks come first; a suggestion picked keeps its place.
    expect(rows.map((row) => row.symbol)).toEqual(["ES=F", "9992", "NVDA", "AAPL", "MSFT", "PLTR"]);
    expect(toggleTickerPick(picks, pick("MSFT"))).toEqual(picks);
    expect(toggleTickerPick(picks, pick("AAPL")).map((entry) => entry.symbol)).toEqual(["ES=F", "9992"]);
  });

  test("is asked only on a first run that left the holdings step holding nothing on this build", () => {
    const skipped = { version: 1 as const, stage: "desks" as const, path: "manual" as const, positionsImported: 0, asksTickers: true };
    expect(asksFirstRunTickers(skipped)).toBe(true);
    // Begun on an earlier build, holding something, from a broker, or from Settings.
    expect(asksFirstRunTickers({ ...skipped, asksTickers: undefined })).toBe(false);
    expect(asksFirstRunTickers({ ...skipped, positionsImported: 2 })).toBe(false);
    expect(asksFirstRunTickers({ ...skipped, path: "broker" })).toBe(false);
    expect(asksFirstRunTickers({ ...skipped, rerun: true })).toBe(false);
  });
});
