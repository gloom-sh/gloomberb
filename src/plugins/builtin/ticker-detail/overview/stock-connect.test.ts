import { expect, test } from "bun:test";
import { stockConnectListing } from "./stock-connect";

test("route lookup keeps the exact trading counter and derives the venue from qualified tickers", () => {
  expect(stockConnectListing("700.HK")).toEqual({ symbol: "0700", exchange: "HKEX" });
  expect(stockConnectListing("80700:HKEX")).toEqual({ symbol: "80700", exchange: "HKEX" });
  expect(stockConnectListing("002594.SZ")).toEqual({ symbol: "002594", exchange: "SZSE" });
  expect(stockConnectListing("600519", "SSE")).toEqual({ symbol: "600519", exchange: "SSE" });
  expect(stockConnectListing("BYDDY", "OTC")).toBeNull();
  expect(stockConnectListing("7203", "JPX")).toBeNull();
});
