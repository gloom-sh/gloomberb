import { describe, expect, test } from "bun:test";
import type { TickerRecord } from "../types/ticker";
import { isKnownNonUsEquityTicker, mayBeUsEquityOrFundTicker, mayBeUsEquityTicker } from "./sec";
import { createTestTicker } from "../test-support/ticker";

const makeTicker = (overrides: Partial<TickerRecord["metadata"]>) => createTestTicker("AAPL", "Apple Inc.", overrides);
const smart = (primaryExchange?: string) => ({ exchange: "SMART", assetCategory: "STK", broker_contracts: [{
  brokerId: "ibkr", symbol: "AAPL", exchange: "SMART", primaryExchange, secType: "STK", currency: "USD",
}] });

describe("SEC pane eligibility", () => {
  // Unknown is not foreign: a ticker whose venue, currency or type were never
  // filled in (its quote failed) is looked up as a US ticker. A listing known
  // to be abroad, or a type the pane does not cover, gets the notice.
  /** [what, metadata, equity panes (SEC, INS), fund filings view (ETF)] */
  const rows: Array<[string, Partial<TickerRecord["metadata"]>, boolean, boolean]> = [
    ["US equity on NASDAQ", {}, true, true],
    ["US equity, no exchange", { exchange: "" }, true, true],
    ["US equity, no currency", { currency: "" }, true, true],
    ["US equity, no exchange or currency", { exchange: "", currency: "" }, true, true],
    ["SMART-routed with a primary exchange", smart("NASDAQ"), true, true],
    ["SMART-routed, no primary exchange", smart(), true, true],
    ["catalogue ADR", { assetCategory: "ADR" }, true, true],
    ["catalogue common stock on XNYS", { assetCategory: "Common Stock", exchange: "XNYS" }, true, true],
    ["depositary receipt on NGM", { assetCategory: "Depositary Receipt", exchange: "NGM" }, true, true],
    ["share class with a dot, no exchange", { ticker: "BRK.B", exchange: "", currency: "" }, true, true],
    ["London listing", { exchange: "LSE", currency: "GBP" }, false, false],
    ["London listing in USD", { exchange: "LSE" }, false, false],
    ["Toronto listing in USD", { exchange: "TSX" }, false, false],
    ["CAD on a US venue", { currency: "CAD" }, false, false],
    ["EUR, no exchange", { exchange: "", currency: "EUR" }, false, false],
    [".L symbol, no exchange", { ticker: "VOD.L", exchange: "", currency: "" }, false, false],
    [".T symbol, no exchange", { ticker: "7203.T", exchange: "", currency: "" }, false, false],
    [".HK symbol, no exchange", { ticker: "0700.HK", exchange: "", currency: "" }, false, false],
    ["listing key abroad, no exchange", { ticker: "SAN:EPA", exchange: "", currency: "" }, false, false],
    ["listing key in New York, no exchange", { ticker: "SAN:NYSE", exchange: "", currency: "" }, true, true],
    ["ETF on ARCA", { assetCategory: "ETF", exchange: "NYSEARCA" }, false, true],
    ["ETF, no exchange", { assetCategory: "ETF", exchange: "" }, false, true],
    ["mutual fund", { assetCategory: "Mutual Fund" }, false, true],
    ["ETF in London", { assetCategory: "ETF", exchange: "LSE" }, false, false],
    ["crypto", { assetCategory: "CRYPTOCURRENCY", exchange: "CCC" }, false, false],
    ["crypto, no exchange", { assetCategory: "CRYPTOCURRENCY", exchange: "" }, false, false],
    ["option", { assetCategory: "OPT" }, false, false],
    ["preferred stock", { assetCategory: "Preferred Stock" }, false, false],
  ];

  test.each(rows)("%s", (_what, metadata, equity, equityOrFund) => {
    const ticker = makeTicker(metadata);
    expect(mayBeUsEquityTicker(ticker)).toBe(equity);
    expect(mayBeUsEquityOrFundTicker(ticker)).toBe(equityOrFund);
    expect(isKnownNonUsEquityTicker(ticker)).toBe(!equity);
  });
});
