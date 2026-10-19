import { expect, test } from "bun:test";
import type { Quote } from "../../../types/financials";
import type { BrokerOrderLeg } from "../../../types/trading";
import { strategyFromLegs, strategyName, strategyQuote } from "./strategy";

const contract = (osi: string) => ({ brokerId: "demo", symbol: osi.slice(0, osi.search(/\d/)), localSymbol: osi, secType: "OPT" });
const leg = (osi: string, action: "BUY" | "SELL", ratio = 1): BrokerOrderLeg => ({ contract: contract(osi), action, ratio });
const quote = (bid: number, ask: number): Quote => ({ symbol: "", price: (bid + ask) / 2, bid, ask, currency: "USD", change: 0, changePercent: 0, lastUpdated: 1, dataSource: "live" });

test("a builder's legs become one order: the common contract count is the spread quantity, and the premiums say debit or credit", () => {
  expect(strategyFromLegs([
    { contractSymbol: "AAPL261026C00345000", quantity: 2, price: 3.4 },
    { contractSymbol: "AAPL261026C00350000", quantity: -2, price: 1.6 },
  ])).toEqual({ action: "BUY", quantity: 2, legs: [
    { contractSymbol: "AAPL261026C00345000", action: "BUY", ratio: 1 }, { contractSymbol: "AAPL261026C00350000", action: "SELL", ratio: 1 }] });
  // A short put vertical receives a credit; a 1x2 keeps its ratio.
  expect(strategyFromLegs([{ contractSymbol: "SPY261218P00450000", quantity: -1, price: 5 }, { contractSymbol: "SPY261218P00440000", quantity: 1, price: 1 }])?.action).toBe("SELL");
  expect(strategyFromLegs([{ contractSymbol: "SPY261218C00450000", quantity: 1 }, { contractSymbol: "SPY261218C00460000", quantity: -2 }])?.legs.map((value) => value.ratio)).toEqual([1, 2]);
  expect(strategyFromLegs([{ contractSymbol: "SPY261218C00450000", quantity: 0.5 }])).toBeNull();
});

test("a spread's quote is its debit side's: buying pays the ask legs and the bid legs back, a credit order reads the same market", () => {
  const legs = [leg("AAPL261026C00345000", "BUY"), leg("AAPL261026C00350000", "SELL")];
  const quotes = [quote(3.3, 3.5), quote(1.5, 1.65)];
  const base = { contract: { brokerId: "demo", symbol: "AAPL", secType: "BAG", currency: "USD" } };
  expect(strategyQuote({ ...base, action: "BUY", legs }, quotes)).toMatchObject({ bid: 1.65, ask: 2, price: 1.825 });
  // Selling the vertical is the credit order with every leg turned over: the same market, read from its bid.
  const reversed = legs.map((value) => ({ ...value, action: value.action === "BUY" ? "SELL" as const : "BUY" as const }));
  expect(strategyQuote({ ...base, action: "SELL", legs: reversed }, quotes)).toMatchObject({ bid: 1.65, ask: 2 });
  expect(strategyQuote({ ...base, action: "BUY", legs }, [quotes[0]!, { ...quotes[1]!, bid: undefined }])).toBeNull();
});

test("common shapes have their names, and anything else says how many legs it has", () => {
  expect(strategyName([leg("AAPL261026C00345000", "BUY"), leg("AAPL261026C00350000", "SELL")])).toBe("AAPL call vertical");
  expect(strategyName([leg("AAPL261026P00340000", "SELL"), leg("AAPL261120P00340000", "BUY")])).toBe("AAPL put calendar");
  expect(strategyName([leg("SPY261218P00430000", "BUY"), leg("SPY261218P00440000", "SELL"), leg("SPY261218C00470000", "SELL"), leg("SPY261218C00480000", "BUY")])).toBe("SPY iron condor");
  expect(strategyName([leg("SPY261218C00450000", "BUY"), leg("SPY261218C00460000", "SELL", 2), leg("SPY261218C00470000", "BUY")])).toBe("SPY call butterfly");
  expect(strategyName([leg("SPY261218C00450000", "BUY"), leg("SPY261218P00450000", "BUY")])).toBe("SPY straddle");
  expect(strategyName([leg("SPY261218C00450000", "BUY"), leg("SPY261218P00440000", "SELL"), leg("SPY261218P00430000", "SELL")])).toBe("SPY 3-leg spread");
});
