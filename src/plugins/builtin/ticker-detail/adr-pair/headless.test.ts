import { expect, test } from "bun:test";
import { createTestDataProvider, createTestQuote } from "../../../../test-support/data-provider";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../../test-support/headless";
import type { IssuerListings } from "../../../../types/issuer-listings";
import { adrPairHeadless } from "./headless";

test("ADR names the company's lines on other venues as the not-traded message names the company, the first three and how many more", async () => {
  const notes = async (listings: IssuerListings["listings"]) => {
    const pair = { receipt: "HSBC", ratio: 5, ordinary: ["HSBA.L"] };
    const ctx = createTestHeadlessContext({
      marketData: createTestDataProvider({
        getTickerFinancials: async () => ({ quote: createTestQuote({ symbol: "HSBC", depositaryPair: pair, isDepositaryReceipt: true }) }) as never,
        getQuote: async (symbol) => symbol === "HSBC"
          // The receipt's own name has the comma and stop a listing's name can carry; the home line's is the company's.
          ? createTestQuote({ symbol, name: "HSBC Holdings, plc.", price: 89.5, currency: "USD" })
          : createTestQuote({ symbol, name: "HSBC Holdings plc", price: 1354, currency: "GBp" }),
        getExchangeRate: async () => 1.32,
        getIssuerListings: async () => ({ issuer: "cik:1089113", name: "HSBC HOLDINGS PLC", country: "GB", listings }),
      }),
    });
    const result = await adrPairHeadless.load(createTestHeadlessArgs({ symbols: ["HSBC"] }), ctx);
    return ("notes" in result ? result.notes ?? [] : []).filter((note) => note.includes("also lists"));
  };
  const line = (symbol: string, exchange: string) => ({ symbol, exchange, name: "HSBC HOLDINGS", primary: false });
  // The home line (London) and the receipt's US line are the pair's, not other lines.
  expect(await notes([line("HSBA:LSE", "LSE"), line("0005:HKEX", "HKEX"), line("HSBC", "NYSE")]))
    .toEqual(["HSBC Holdings plc also lists 0005:HKEX."]);
  expect(await notes([line("0005:HKEX", "HKEX"), line("HBC1:XETRA", "XETRA"), line("HSBA:BMV", "BMV"), line("HSBC:TSX", "TSX"), line("HSBC:ASX", "ASX")]))
    .toEqual(["HSBC Holdings plc also lists 0005:HKEX, HBC1:XETRA, HSBA:BMV and 2 more."]);
  expect(await notes([line("HSBA:LSE", "LSE")])).toEqual([]);
});
