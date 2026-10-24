import { expect, test } from "bun:test";
import type { Quote } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { adrPairLegs } from "./model";

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
