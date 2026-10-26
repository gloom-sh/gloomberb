import { describe, expect, test } from "bun:test";
import { getListingSymbol, getListingSymbolsToTry, listingSuffixExchange, listingSuffixVenue } from "./listing-symbols";

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

  test("a venue under its own canonical code takes its suffix, and the suffix names it back", () => {
    // Gloom Cloud names Vienna VIE, Madrid MCE, Mexico BMV and Sao Paulo B3; the table keyed them by other codes.
    for (const [symbol, venue, listed] of [["OMV", "VIE", "OMV.VI"], ["WALMEX", "BMV", "WALMEX.MX"], ["PETR4", "B3", "PETR4.SA"]]) {
      expect(getListingSymbol(symbol!, venue!)).toBe(listed!);
      expect(listingSuffixExchange(listed!)).toBe(venue!);
    }
    expect(getListingSymbol("REP", "MCE")).toBe("REP.MC");
  });

  test("a TSX Venture listing takes .V now that VENTURE reads as TSXV, and .V names it back", () => {
    expect(getListingSymbol("FISH", "TSXV")).toBe("FISH.V");
    expect(getListingSymbol("TTS:XTSX", "TSXV")).toBe("TTS.V");
    expect(getListingSymbolsToTry("FISH", "TSXV", { exactExchange: true })).toEqual(["FISH.V"]);
    expect(listingSuffixExchange("FISH.V")).toBe("TSXV");
  });

  test("a vendor's suffix reads as its venue when a venue agrees, or alone when it is two letters or more; a one-letter suffix may be a US class", () => {
    expect(listingSuffixVenue("GARAN.IS")).toEqual({ symbol: "GARAN", exchange: "BIST" });
    expect(listingSuffixVenue("7203.T", "JPX")).toEqual({ symbol: "7203", exchange: "JPX" });
    // A broker's SMART routing names no venue; the suffix does.
    expect(listingSuffixVenue("RY.TO", "SMART")).toEqual({ symbol: "RY", exchange: "TSX" });
    // A venue code the table does not know is no answer: the suffix names the venue.
    expect(listingSuffixVenue("GARAN.IS", "IST")).toEqual({ symbol: "GARAN", exchange: "BIST" });
    expect(listingSuffixVenue("NPN.JO", "JNB")).toEqual({ symbol: "NPN", exchange: "JSE" });
    expect(listingSuffixVenue("GARAN.IS", "NYSE")).toBeNull();
    // McCormick's voting class on NYSE, not a TSX Venture listing; alone, a one-letter suffix waits for a venue.
    expect(listingSuffixVenue("MKC.V", "NYSE")).toBeNull();
    expect(listingSuffixVenue("MKC.V")).toBeNull();
    expect(listingSuffixVenue("7203.T")).toBeNull();
    expect(listingSuffixVenue("BRK.B")).toBeNull();
  });
});
