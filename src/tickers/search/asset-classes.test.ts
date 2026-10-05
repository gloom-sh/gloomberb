import { describe, expect, test } from "bun:test";
import { assetClassMarketSymbol, instrumentClassCode, parseAssetClassQuery } from "./asset-classes";

describe("asset class query", () => {
  test("a class code filters only after a symbol or name", () => {
    expect(parseAssetClassQuery("es fut")).toEqual({ code: "FUT", symbolQuery: "es" });
    expect(parseAssetClassQuery("Vanguard Total ETF")).toEqual({ code: "ETF", symbolQuery: "Vanguard Total" });
    // A code alone is a symbol (EQ) or a command (FUT, ETF), and a leading
    // code is a command with its argument (ETF SPY opens ETF Filings).
    for (const query of ["EQ", "FUT", "ETF", "ETF SPY", "FUT ES", "ES FUTURE"]) {
      expect(parseAssetClassQuery(query)).toBeNull();
    }
  });

  test("gives a bare symbol the market spelling of its class", () => {
    const spell = (query: string) => assetClassMarketSymbol(parseAssetClassQuery(query)!);
    expect(spell("ES FUT")).toBe("ES=F");
    expect(spell("eurusd CUR")).toBe("EURUSD=X");
    expect(spell("BTC CUR")).toBe("BTC-USD");
    expect(spell("GSPC IDX")).toBe("^GSPC");
    expect(spell("AAPL EQ")).toBeNull();
    expect(spell("S&P 500 IDX")).toBeNull();
  });
});

describe("instrument class code", () => {
  // Types as Cloud search and the brokers send them.
  test.each([
    ["Common Stock", "EQ"],
    ["EQUITY", "EQ"],
    ["Preferred Stock", "EQ"],
    ["Depositary Receipt", "EQ"],
    ["American Depositary Receipt", "EQ"],
    ["Limited Partnership", "EQ"],
    ["STK", "EQ"],
    ["ETF", "ETF"],
    ["MUTUALFUND", null],
    ["Closed-end Fund", null],
    ["CURRENCY", "CUR"],
    ["CASH", "CUR"],
    ["CRYPTOCURRENCY", "CUR"],
    ["Digital Currency", "CUR"],
    ["FUTURE", "FUT"],
    ["CONTFUT", "FUT"],
    ["INDEX", "IDX"],
    ["IND", "IDX"],
    ["OPT", "OPT"],
    ["FOP", "OPT"],
    ["Warrant", null],
  ])("%s is %p", (instrumentType, code) => {
    expect(instrumentClassCode({ instrumentType, symbol: "X" })).toBe(code as never);
  });

  test("an untyped row falls back to its listing syntax", () => {
    expect(instrumentClassCode({ symbol: "ES=F" })).toBe("FUT");
    expect(instrumentClassCode({ symbol: "EURUSD=X" })).toBe("CUR");
    expect(instrumentClassCode({ symbol: "^GSPC" })).toBe("IDX");
    expect(instrumentClassCode({ symbol: "BTC-USD", exchange: "CCC" })).toBe("CUR");
    expect(instrumentClassCode({ symbol: "XYZ" })).toBeNull();
  });
});
