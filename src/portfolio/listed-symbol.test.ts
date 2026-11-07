import { expect, test } from "bun:test";
import { createTestTicker } from "../test-support/ticker";
import { exportedListingKey, listedSymbol, listHomeMarket } from "./listed-symbol";

const listing = (symbol: string, exchange: string, assetCategory = "STK") => createTestTicker(symbol, symbol, { exchange, assetCategory });

test("a row outside its list's home market shows its venue, so BA on LSE never reads as Boeing in a US list", () => {
  // A shock view saved from BA.L, RHM.DE and 0005.HK listed them as BA, RHM and 0005 beside LMT and NOC.
  const us = [listing("LMT", "NYSE"), listing("NOC", "NYSE"), listing("RTX", "NYSE"), listing("BA", "LSE"), listing("RHM", "XETRA"),
    listing("0005", "HKEX"), listing("^HSI", "HKEX", "INDEX"), listing("CL=F", "NYMEX", "FUT")];
  const home = listHomeMarket(us);
  expect(home).toBe("US");
  expect(us.map((ticker) => listedSymbol(ticker, ticker.metadata.ticker, home)))
    .toEqual(["LMT", "NOC", "RTX", "BA:LSE", "RHM:XETRA", "0005:HKEX", "^HSI", "CL=F"]);
  // A London list keeps its own rows bare and names the US one.
  const london = [listing("BA", "LSE"), listing("VOD", "LSE"), listing("AAPL", "NASDAQ")];
  expect(london.map((ticker) => listedSymbol(ticker, ticker.metadata.ticker, listHomeMarket(london)))).toEqual(["BA", "VOD", "AAPL:NASDAQ"]);
  // An export always names the venue of a listing; an index or a future is its symbol.
  expect(us.map(exportedListingKey)).toEqual(["LMT:NYSE", "NOC:NYSE", "RTX:NYSE", "BA:LSE", "RHM:XETRA", "0005:HKEX", "^HSI", "CL=F"]);
  // A row saved by its vendor symbol (BA.L) is the listing it names, and a broker's SMART routing and OTC are US.
  const saved = [listing("BA.L", "LSE"), listing("TSM", "SMART"), listing("NSRGY", "OTC"), listing("AAPL", "NASDAQ")];
  expect(listHomeMarket(saved)).toBe("US");
  expect(saved.map((ticker) => listedSymbol(ticker, ticker.metadata.ticker, "US"))).toEqual(["BA:LSE", "TSM", "NSRGY", "AAPL"]);
  expect(exportedListingKey(saved[0]!)).toBe("BA:LSE");
});
