import { describe, expect, test } from "bun:test";
import { liveTrailingPE } from "../market-data/quotes/live-valuation";
import type { Fundamentals, Quote, TickerFinancials } from "../types/financials";
import { notMeaningfulMultiples, NOT_MEANINGFUL } from "./price-earnings";
import { epsAgainstIncome, notTheShare, withShareMultiples } from "./share-multiples";

type Inputs = Pick<TickerFinancials, "quote" | "profile" | "fundamentals">;

function listing(symbol: string, exchange: string, name: string, fundamentals: Fundamentals = {}, country?: string): Inputs {
  const quote = { symbol, name, listingExchangeName: exchange, exchangeName: exchange, price: 10, currency: "USD" } as Quote;
  return { quote, fundamentals, profile: country ? { country } : undefined };
}

describe("notTheShare", () => {
  test("names a warrant, a right or a unit by its name or its US symbol, never a share's units", () => {
    // BZFDW: BuzzFeed's warrant at $0.0054 over BuzzFeed's EPS read 0.03x.
    expect(notTheShare(listing("BZFDW", "NASDAQ", "BuzzFeed, Inc. - Warrant"))).toBe("a warrant is not the share the EPS is per");
    expect(notTheShare(listing("BZFDW", "NASDAQ", "BuzzFeed"))).toBe("a warrant is not the share the EPS is per");
    expect(notTheShare(listing("SPAC.U", "NYSE", "Spac Acquisition Corp. Units, each consisting of one share")))
      .toBe("a unit is not the share the EPS is per");
    expect(notTheShare(listing("ABCDR", "NASDAQ", "Abc Acquisition Corp - Rights (1/10 share)"))).toBe("a right is not the share the EPS is per");
    expect(notTheShare(listing("JMART-W4", "SET", "Jay Mart Public Company Limited"))).toBe("a warrant is not the share the EPS is per");
    for (const [symbol, exchange, name] of [
      ["ET", "NYSE", "Energy Transfer LP Common Units"],
      ["BEP", "NYSE", "Brookfield Renewable Partners L.P. - Limited Partnership Units"],
      ["UNT", "NYSE", "Unit Corporation"],
      ["REI-UN", "TSX", "RioCan Real Estate Investment Trust"],
      ["ABCDW", "XETRA", "Abcdw AG"],
    ]) expect(notTheShare(listing(symbol!, exchange!, name!))).toBeUndefined();
  });

  test("a Thai receipt of a foreign company has no ratio on record; a Thai company's share is its share", () => {
    // SOFTBANK80: a receipt at 7.85 THB over SoftBank's 203.71 THB a share read 0.04x.
    const softbank = listing("SOFTBANK80:SET", "SET", "SoftBank Group Corp.", {}, "JP");
    expect(notTheShare(softbank)).toBe("a depositary receipt with no ratio on record to the share the EPS is per");
    expect(notTheShare(listing("SCB80", "SET", "SCB X Public Company Limited", {}, "TH"))).toBeUndefined();
    expect(notTheShare(listing("SOFTBANK80:SET", "SET", "SoftBank Group Corp.", { adrRatio: 0.01 }, "JP"))).toBeUndefined();
  });
});

describe("epsAgainstIncome", () => {
  test("an EPS of the other sign than net income over the shares, or ten times off it, is not the company's", () => {
    // STKH: 96.00 beside a 7.01M loss over 605,876 receipts.
    const stkh = { eps: 96, netIncome: -7_010_000, sharesOutstanding: 605_876, isDepositaryReceipt: true, adrRatio: 60_000 };
    expect(epsAgainstIncome(listing("STKH", "NASDAQ", "Steakholder Foods Ltd. ADR", stkh)))
      .toBe("EPS (TTM) 96.00 has the other sign than trailing net income over shares outstanding (-11.57)");
    expect(epsAgainstIncome(listing("APRT", "NYSE", "Apart Inc.", { eps: 25, netIncome: 2e6, sharesOutstanding: 1e6 })))
      .toBe("EPS (TTM) 25.00 is more than 10 times off trailing net income over shares outstanding (2.00)");
    // A receipt's shares can be ordinary ones: only the sign is judged.
    expect(epsAgainstIncome(listing("RCPT", "NYSE", "Receipt plc ADR", { eps: 25, netIncome: 2e6, sharesOutstanding: 1e6, adrRatio: 20 })))
      .toBeUndefined();
    // SNBN: 57.76B CHF over 100,000 shares is 577,618 a share; its 0.01x stands.
    expect(epsAgainstIncome(listing("SNBN", "SWX", "Schweizerische Nationalbank", { eps: 577_618, netIncome: 57_761_800_192, sharesOutstanding: 100_000 })))
      .toBeUndefined();
  });
});

test("withShareMultiples withdraws the multiples it has, every view reads N/M with the reason, and a second pass keeps them", () => {
  const warrant = listing("BZFDW", "NASDAQ", "BuzzFeed, Inc. - Warrant", { eps: 0.165, trailingPE: 0.0327, forwardPE: 0.01 });
  const once = withShareMultiples(warrant);
  expect(once.fundamentals).toMatchObject({
    eps: 0.165,
    notMeaningful: { trailingPE: "a warrant is not the share the EPS is per", forwardPE: "a warrant is not the share the EPS is per" },
  });
  expect(once.fundamentals?.trailingPE).toBeUndefined();
  // No PEG was served, so none is withdrawn.
  expect(once.fundamentals?.notMeaningful?.pegRatio).toBeUndefined();
  expect(withShareMultiples(once)).toEqual(once);
  expect(liveTrailingPE(once.quote, once.fundamentals)).toBe(NOT_MEANINGFUL);
  expect(notMeaningfulMultiples(once.fundamentals).trailingPE).toBe("a warrant is not the share the EPS is per");
  const share = listing("JPM", "NYSE", "JP Morgan Chase & Co.", { eps: 23.84, trailingPE: 14.4, netIncome: 64.5e9, sharesOutstanding: 2.66e9 });
  expect(withShareMultiples(share)).toBe(share);
});
