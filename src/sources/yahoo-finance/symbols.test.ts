import { describe, expect, test } from "bun:test";
import { getYahooSymbol, getYahooSymbolsToTry } from "./symbols";

describe("Yahoo symbol routing", () => {
  test("canonicalizes MIC aliases before applying exchange suffixes", () => {
    expect(getYahooSymbol("VOD", "XLON")).toBe("VOD.L");
    expect(getYahooSymbol("VOD:XLON", "LSE")).toBe("VOD.L");
    expect(getYahooSymbolsToTry("AAPL:BYMA", "BYMA")).toEqual(["AAPL.BA"]);
    expect(getYahooSymbolsToTry("0700", "XHKG")).toEqual(["0700.HK"]);
    expect(getYahooSymbolsToTry("SHOP", "XTSE")).toEqual(["SHOP.TO"]);
    expect(getYahooSymbol("ASML", "XAMS")).toBe("ASML.AS");
    expect(getYahooSymbol("AIR", "XPAR")).toBe("AIR.PA");
    expect(getYahooSymbol("ABI", "XBRU")).toBe("ABI.BR");
    expect(getYahooSymbol("ENEL", "XMIL")).toBe("ENEL.MI");
    expect(getYahooSymbol("NOKIA", "XHEL")).toBe("NOKIA.HE");
    expect(getYahooSymbol("EQNR", "XOSL")).toBe("EQNR.OL");
  });
});
