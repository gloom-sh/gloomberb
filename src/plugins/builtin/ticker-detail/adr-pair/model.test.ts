import { expect, test } from "bun:test";
import type { Quote } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { adrPairComparison, adrPairInputRows, adrPairLegs } from "./model";

const GSK = { receipt: "GSK", ratio: 2, ordinary: ["GSK.L"] };

function records(isDepositaryReceipt: boolean, pair = GSK) {
  return { quote: { depositaryPair: pair, isDepositaryReceipt } as Quote, fundamentals: undefined };
}

function saved(ticker: string, exchange: string) {
  return { metadata: { ticker, exchange } } as TickerRecord;
}

test("a home line finds itself among the pair's lines however its listing is keyed, a one-letter suffix too", () => {
  // The receipt compares with the first home line.
  expect(adrPairLegs(records(true), null, "GSK")).toMatchObject({ receiptSide: true, receiptKey: "GSK", homeKey: "GSK.L", otherKey: "GSK.L" });
  // GSK saved on LSE, GSK:LSE and GSK.L are all the GSK.L line.
  for (const [ticker, symbol] of [[saved("GSK", "LSE"), "GSK"], [null, "GSK:LSE"], [null, "GSK.L"]] as const) {
    expect(adrPairLegs(records(false), ticker, symbol)).toMatchObject({ receiptSide: false, homeKey: "GSK.L", otherKey: "GSK" });
  }
  // A second home line (BHP in Sydney and London) is compared as itself, not as the first.
  const bhp = { receipt: "BHP", ratio: 2, ordinary: ["BHP.AX", "BHP.L"] };
  expect(adrPairLegs(records(false, bhp), saved("BHP", "LSE"), "BHP")?.homeKey).toBe("BHP.L");
  expect(adrPairLegs({ quote: {} as Quote }, null, "AAPL")).toBeNull();
});

test("both legs' prices keep their instrument's decimals, as the quote monitor writes them", () => {
  const FRI_CLOSE = Date.UTC(2026, 9, 23, 20, 0);
  const quote = (fields: Partial<Quote>) => ({ symbol: "X", change: 0, changePercent: 0, lastUpdated: FRI_CLOSE, marketState: "CLOSED", ...fields }) as Quote;
  const prices = (receipt: Quote, home: Quote, pair = { receipt: "TSM", ratio: 5, ordinary: ["2330.TW"] }) => {
    const legs = adrPairLegs(records(true, pair), null, "TSM")!;
    const comparison = adrPairComparison(legs, { receipt, home }, null)!;
    return adrPairInputRows(comparison, { receipt, home }).map((row) => row.price);
  };
  // $419.5 is $419.50, as QQ and the Overview write it; a whole-number home price keeps its cents too.
  expect(prices(
    quote({ price: 419.5, currency: "USD", previousClose: 418.51 }),
    quote({ price: 2370, currency: "TWD", previousClose: 2385 }),
  )).toEqual(["2,370.00 TWD", "$419.50"]);
  // A London line in pence is read in pounds, with the pounds' decimals: 16.5 is 16.50.
  expect(prices(
    quote({ price: 48.1, currency: "USD", previousClose: 47.9 }),
    quote({ price: 1650, currency: "GBp", previousClose: 1648.5 }),
    { receipt: "GSK", ratio: 2, ordinary: ["GSK.L"] },
  )).toEqual(["16.50 GBP", "$48.10"]);
});
