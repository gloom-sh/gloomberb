import { expect, test } from "bun:test";
import type { BrokerContractRef } from "../../../types/instrument";
import type { TickerRecord } from "../../../types/ticker";
import { tickerForInstrument } from "./instrument";

const saved = (exchange: string, currency = "USD"): TickerRecord => ({ metadata: {
  ticker: "AAPL", exchange, currency, name: "Apple Inc.", portfolios: [], watchlists: [], positions: [], custom: {}, tags: [],
} });
const contract = (changes: Partial<BrokerContractRef>): BrokerContractRef => ({ brokerId: "ibkr", brokerInstanceId: "paper", symbol: "AAPL", secType: "STK", currency: "USD", ...changes });

// Research tabs and the Equity Diagnostic send this exchange to Cloud, which
// read SMART as a listing abroad: no SEC filings, Form 4 or short interest.
test("a contract routed through SMART reads as its listing, never as the route", () => {
  const listingOf = (ticker: TickerRecord, instrument: BrokerContractRef) => tickerForInstrument(ticker, instrument)?.metadata.exchange;
  expect(listingOf(saved("SMART"), contract({ exchange: "SMART", primaryExchange: "NASDAQ" }))).toBe("NASDAQ");
  expect(listingOf(saved("NASDAQ"), contract({ exchange: "SMART" }))).toBe("NASDAQ");
  // No venue anywhere: the symbol's home listing, not SMART.
  expect(listingOf(saved("SMART"), contract({ exchange: "SMART" }))).toBe("");
  // A saved listing in another currency is another listing.
  expect(listingOf(saved("NYSE"), contract({ exchange: "SMART", currency: "EUR" }))).toBe("");
  expect(listingOf(saved("NASDAQ"), contract({ exchange: "ARCA" }))).toBe("ARCA");
});
