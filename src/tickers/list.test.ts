import { describe, expect, test } from "bun:test";
import { parseTickerListInput } from "./list";

describe("parseTickerListInput", () => {
  test("normalizes, de-duplicates, and preserves order", () => {
    expect(parseTickerListInput(" msft, aapl,\nMSFT, nvda ")).toEqual(["MSFT", "AAPL", "NVDA"]);
    expect(parseTickerListInput("AAPL TSM, SAP.DE\t7203.T AAPL")).toEqual(["AAPL", "TSM", "SAP.DE", "7203.T"]);
  });

  test("rejects empty ticker lists", () => {
    expect(() => parseTickerListInput(" , \n ")).toThrow("Enter at least one ticker.");
  });

  test("rejects lists beyond the maximum size", () => {
    expect(() => parseTickerListInput("A,B,C,D,E,F,G,H,I,J,K", 10)).toThrow("You can compare up to 10 tickers.");
  });
});
