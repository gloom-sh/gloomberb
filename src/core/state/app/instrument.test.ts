import { expect, test } from "bun:test";
import type { BrokerContractRef } from "../../../types/instrument";
import type { TickerRecord } from "../../../types/ticker";
import { tickerForInstrument } from "./instrument";
import { brokerContractIdentityKey } from "../../../utils/instrument-identity";

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

// Aries files a held share as routed SMART with no listing; a pane opened on NVDA picked in search
// names XNAS. The position is that pane's: DES listed none and its chart had no average cost.
test("a pane on a listing shows the position its broker holds through SMART, and no other listing's", () => {
  const held = contract({ exchange: "SMART" });
  const record: TickerRecord = { metadata: {
    ...saved("NASDAQ").metadata, broker_contracts: [held],
    positions: [{ portfolio: "broker:paper:U1", shares: 2, broker: "ibkr", brokerInstanceId: "paper", brokerContractIdentity: brokerContractIdentityKey(held) }],
  } };
  const shares = (instrument: BrokerContractRef) => tickerForInstrument(record, instrument)?.metadata.positions.map((position) => position.shares);
  expect(shares(contract({ primaryExchange: "XNAS" }))).toEqual([2]);
  expect(shares(contract({ primaryExchange: "IBIS", currency: "EUR" }))).toEqual([]);
  expect(shares(contract({ primaryExchange: "XNAS", brokerInstanceId: "live" }))).toEqual([]);

  // Picked in search, a pane names the listing and no broker contract: any profile's share there is its.
  const onListing = (exchange: string, currency?: string) => tickerForInstrument(record, null, { name: "Apple Inc.", exchange, currency, type: "Common Stock" })
    ?.metadata.positions.map((position) => position.shares);
  expect(onListing("NasdaqGS", "USD")).toEqual([2]);
  expect(onListing("XETRA", "EUR")).toEqual([]);
  expect(onListing("XETRA")).toEqual([]);
});
