import { expect, test } from "bun:test";
import { optionMarketReference, optionMarketReferenceLines, parseOptionMarketReference } from "./market-reference";

const recorded = {
  contractSymbol: "COST260925P01020000", expiration: 1790294400, currency: "USD",
  bid: 114.8, ask: 120.55, lastPrice: 72.55, lastTradeDate: 1786630795,
};

test("keeps historical trades distinct and never substitutes retrieval time for a quote clock", () => {
  const reference = optionMarketReference({ ...recorded, asOf: "2026-09-11T14:51:16Z" })!;
  const lines = optionMarketReferenceLines(reference).join("\n");
  expect(lines).toContain("spread 5.75 (4.89% of mid)");
  expect(lines).toContain("Quote time unavailable");
  expect(lines).toContain("Last 72.55 · trade 2026-08-13 14:19:55 UTC");
  expect(lines).not.toContain("14:51:16");
  const updated = optionMarketReferenceLines({ ...reference, lastUpdated: 1789140000123 }).join("\n");
  expect(updated).toContain("Quote 2026-09-11 15:20:00 UTC");
  expect(updated).toContain("trade 2026-08-13 14:19:55 UTC");
});

test("does not fabricate a midpoint for one-sided, crossed, missing or malformed quotes", () => {
  for (const [bid, ask, result] of [[0, 0.19, "one-sided"], [2, 1, "crossed"], [NaN, Infinity, "bid/ask unavailable"]] as const) {
    const lines = optionMarketReferenceLines(optionMarketReference({ ...recorded, bid, ask, lastPrice: 0, lastTradeDate: 0 })!).join("\n");
    expect(lines).toContain(result);
    expect(lines).not.toContain("% of mid");
    expect(lines).toContain("Last — · trade time unavailable");
  }
  expect(optionMarketReferenceLines({ ...recorded, bid: 1, ask: 1 }).join("\n")).toContain("spread 0 (0.00% of mid)");
});

test("round-trips only valid optional reference metadata across saved pane params", () => {
  expect(parseOptionMarketReference(JSON.stringify(recorded))).toEqual(recorded);
  for (const malformed of ["not JSON", "null", "42", "[]", JSON.stringify({ ...recorded, expiration: 1e100 })]) {
    expect(parseOptionMarketReference(malformed)).toBeUndefined();
  }
});
