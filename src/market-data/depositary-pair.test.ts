import { expect, test } from "bun:test";
import type { Quote } from "../types/financials";
import { compareDepositaryPair, listingDepositaryPair, pairPriceInput, pesoImpliedRates, premiumText, type PairPriceInput } from "./depositary-pair";

const FRI_CLOSE = Date.UTC(2026, 9, 23, 20, 0);

function quote(fields: Partial<Quote>): Quote {
  return { symbol: "X", price: 1, currency: "USD", change: 0, changePercent: 0, lastUpdated: FRI_CLOSE, ...fields } as Quote;
}

function input(symbol: string, price: number, currency: string, observedAt: number | null, open = false): PairPriceInput {
  return { symbol, price, currency, observedAt, open };
}

test("the implied rate is home × ratio / ADR, and the premium is the receipt over the shares it holds at spot", () => {
  // GGAL at $37.91 holds ten GGAL.BA at ARS 6,260: 1,651 pesos a dollar, against an official 1,529.
  const ggal = compareDepositaryPair(10, input("GGAL", 37.91, "USD", FRI_CLOSE), input("GGAL.BA", 6260, "ARS", FRI_CLOSE - 60_000),
    { rate: 1529, observedAt: FRI_CLOSE }, FRI_CLOSE)!;
  expect(ggal.impliedFx).toBeCloseTo(1651.28, 2);
  expect(ggal.premiumPercent).toBeCloseTo(-7.4, 1);
  expect(premiumText(ggal.premiumPercent!)).toBe("-7.4% discount");
  expect(ggal.timingNote).toBeNull();
  // TSM at $418.51 holds five 2330.TW at NT$2,385: 28.49 against 32.57, a 14.3% premium.
  const tsm = compareDepositaryPair(5, input("TSM", 418.51, "USD", FRI_CLOSE), input("2330.TW", 2385, "TWD", Date.UTC(2026, 9, 22, 5, 30)),
    { rate: 32.57, observedAt: FRI_CLOSE }, FRI_CLOSE)!;
  expect(tsm.impliedFx).toBeCloseTo(28.494, 3);
  expect(premiumText(tsm.premiumPercent!)).toBe("+14.3% premium");
  expect(tsm.timingNote).toBe("Both markets are closed: 2330.TW from Thu 22 Oct 05:30 UTC, TSM from Fri 23 Oct 20:00 UTC, 1 day 14 h apart.");
  // No spot leaves the rate and drops the premium; a receipt not in dollars is no comparison.
  expect(compareDepositaryPair(5, input("TSM", 418.51, "USD", FRI_CLOSE), input("2330.TW", 2385, "TWD", FRI_CLOSE), null)?.premiumPercent).toBeNull();
  expect(compareDepositaryPair(5, input("TSM", 418.51, "EUR", FRI_CLOSE), input("2330.TW", 2385, "TWD", FRI_CLOSE), null)).toBeNull();
});

test("a closed home market beside a trading receipt says the prices are apart", () => {
  const now = Date.UTC(2026, 9, 26, 15, 0);
  const note = compareDepositaryPair(6, input("BP", 51.3, "USD", now, true), input("BP.L", 6.39, "GBP", Date.UTC(2026, 9, 23, 15, 40)), null, now)!.timingNote;
  expect(note).toBe("BP.L is closed, its price from Fri 23 Oct 15:40 UTC, while BP trades: the prices are 2 days 23 h apart.");
});

test("a price in pence is read in pounds, so it compares with the pound's dollar rate", () => {
  const read = pairPriceInput("BP.L", quote({ price: 639, currency: "GBp", marketState: "REGULAR" }))!;
  expect([read.price, read.currency, read.open]).toEqual([6.39, "GBP", true]);
  expect(pairPriceInput("X", quote({ price: 0 }))).toBeNull();
});

test("the pair is read from the quote, else the fundamentals, and only when it is whole", () => {
  const pair = { receipt: "ggal", ratio: 10, ordinary: ["GGAL.BA"] };
  expect(listingDepositaryPair({ quote: quote({ depositaryPair: pair }) })).toEqual({ receipt: "GGAL", ratio: 10, ordinary: ["GGAL.BA"] });
  expect(listingDepositaryPair({ quote: quote({}), fundamentals: { depositaryPair: pair } })?.receipt).toBe("GGAL");
  expect(listingDepositaryPair({ quote: quote({ depositaryPair: { ...pair, ratio: 0 } }) })).toBeNull();
  expect(listingDepositaryPair({ quote: quote({ depositaryPair: { ...pair, ordinary: [] } }) })).toBeNull();
});

test("the peso's CCL comes from the receipt and the C line, its MEP from the D line, each with its formula", () => {
  const home = input("GGAL.BA", 6260, "ARS", FRI_CLOSE);
  const rates = pesoImpliedRates(10, {
    home,
    receipt: input("GGAL", 37.91, "USD", FRI_CLOSE),
    ccl: input("GGALC.BA", 3.75, "USD", FRI_CLOSE),
    mep: input("GGALD.BA", 4.04, "USD", FRI_CLOSE),
  });
  expect(rates.map((rate) => [rate.label, Math.round(rate.rate), rate.formula])).toEqual([
    ["CCL via GGAL ADR", 1651, "6,260 × 10 / 37.91"],
    ["CCL via GGALC.BA", 1669, "6,260 / 3.75"],
    ["MEP via GGALD.BA", 1550, "6,260 / 4.04"],
  ]);
  // Without a ratio on record the receipt's rate is left out, not guessed; a peso price priced otherwise is no peso rate.
  expect(pesoImpliedRates(null, { home, receipt: input("GGAL", 37.91, "USD", FRI_CLOSE), ccl: null, mep: null })).toEqual([]);
  expect(pesoImpliedRates(10, { home: { ...home, currency: "USD" }, receipt: input("GGAL", 37.91, "USD", FRI_CLOSE), ccl: null, mep: null })).toEqual([]);
});
