import { describe, expect, test } from "bun:test";
import { getListingSymbol, getListingSymbolsToTry } from "./listing-symbols";

describe("Listing symbol aliases", () => {
  test("canonicalizes MIC aliases before applying exchange suffixes", () => {
    expect(getListingSymbol("VOD", "XLON")).toBe("VOD.L");
    expect(getListingSymbol("VOD:XLON", "LSE")).toBe("VOD.L");
    expect(getListingSymbolsToTry("AAPL:BYMA", "BYMA")).toEqual(["AAPL.BA"]);
    expect(getListingSymbolsToTry("0700", "XHKG")).toEqual(["0700.HK"]);
    expect(getListingSymbolsToTry("SHOP", "XTSE")).toEqual(["SHOP.TO"]);
    expect(getListingSymbolsToTry("3105", "TPEX")).toEqual(["3105.TWO", "3105.TW"]);
    expect(getListingSymbolsToTry("HY9H", "FWB2")).toEqual(["HY9H.F", "HY9H.DE"]);
    expect(getListingSymbol("ASML", "XAMS")).toBe("ASML.AS");
    expect(getListingSymbol("AIR", "XPAR")).toBe("AIR.PA");
    expect(getListingSymbol("ABI", "XBRU")).toBe("ABI.BR");
    expect(getListingSymbol("ENEL", "XMIL")).toBe("ENEL.MI");
    expect(getListingSymbol("NOKIA", "XHEL")).toBe("NOKIA.HE");
    expect(getListingSymbol("EQNR", "XOSL")).toBe("EQNR.OL");
  });
});
