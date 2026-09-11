import { describe, expect, test } from "bun:test";
import type { OptionContract } from "../../../types/financials";
import { draftFromParams } from "../options-calculator/model";
import { buildChainCalcParams, resolveCalcSide } from "./calc-seed";
import type { OptionTableRow } from "./types";

const NOW = Date.UTC(2026, 7, 20, 18, 0, 0);
const EXPIRATION = Date.UTC(2026, 8, 19) / 1000;

function contract(overrides: Partial<OptionContract> = {}): OptionContract {
  return {
    contractSymbol: "AAPL260919C00230000",
    strike: 230,
    currency: "USD",
    lastPrice: 7.35,
    change: 0,
    percentChange: 0,
    volume: 10,
    openInterest: 100,
    bid: 7.2,
    ask: 7.5,
    impliedVolatility: 0.284,
    inTheMoney: true,
    expiration: EXPIRATION,
    lastTradeDate: 0,
    ...overrides,
  };
}

function row(overrides: Partial<OptionTableRow> = {}): OptionTableRow {
  return { strike: 230, call: contract(), put: contract(), isPositionStrike: false, ...overrides };
}

describe("resolveCalcSide", () => {
  test("uses the explicit side a call or put cell click chose", () => {
    expect(resolveCalcSide("put", "C", row())).toBe("put");
  });

  test("prefers the side of an option position when nothing was clicked", () => {
    expect(resolveCalcSide(null, "P", row())).toBe("put");
    expect(resolveCalcSide(null, "C", row())).toBe("call");
  });

  test("defaults to the call without a position", () => {
    expect(resolveCalcSide(null, null, row())).toBe("call");
  });

  test("falls back to whichever contract the strike actually has", () => {
    expect(resolveCalcSide("call", null, row({ call: undefined }))).toBe("put");
    expect(resolveCalcSide(null, "P", row({ put: undefined }))).toBe("call");
    expect(resolveCalcSide("call", null, row({ call: undefined, put: undefined }))).toBeNull();
    expect(resolveCalcSide("call", null, null)).toBeNull();
  });
});

describe("buildChainCalcParams", () => {
  test("seeds the calculator from the selected contract", () => {
    const params = buildChainCalcParams({
      symbol: "AAPL",
      row: row(),
      side: "put",
      spot: 231.5,
      dividendYield: 0.0044,
      now: NOW,
    });

    expect(draftFromParams(params!)).toMatchObject({
      symbol: "AAPL",
      side: "put",
      spot: 231.5,
      strike: 230,
      volatility: 0.284,
      marketPrice: 7.35,
      dividendYield: 0.0044,
    });
    expect(draftFromParams(params!).daysToExpiry).toBeCloseTo(30 + 2 / 24, 8);
  });

  test("uses a valid midpoint ahead of an old last trade", () => {
    const params = buildChainCalcParams({
      symbol: "AAPL",
      row: row({ call: contract({ lastPrice: 12, bid: 7, ask: 8 }) }),
      side: "call",
      spot: 231.5,
      dividendYield: null,
      now: NOW,
    });

    expect(draftFromParams(params!)).toMatchObject({marketPrice: 7.5, marketPriceSource: "mid"});
    expect(draftFromParams(params!).marketReference).toMatchObject({
      contractSymbol: "AAPL260919C00230000", expiration: EXPIRATION, bid: 7, ask: 8,
      lastPrice: 12, lastTradeDate: 0,
    });
  });

  test("returns nothing without a contract or a trustworthy underlying spot", () => {
    expect(buildChainCalcParams({
      symbol: "AAPL",
      row: row({ put: undefined }),
      side: "put",
      spot: 231.5,
      dividendYield: null,
      now: NOW,
    })).toBeNull();
    expect(buildChainCalcParams({
      symbol: "AAPL",
      row: null,
      side: null,
      spot: 231.5,
      dividendYield: null,
      now: NOW,
    })).toBeNull();
    expect(buildChainCalcParams({
      symbol: "AAPL",
      row: row(),
      side: "call",
      spot: null,
      dividendYield: null,
      now: NOW,
    })).toBeNull();
  });
});

test("a crossed or one-sided market never becomes a midpoint", () => {
  for (const [bid, ask] of [[8, 7], [0, 8], [7, 0], [NaN, 8], [7, Infinity]]) {
    const params = buildChainCalcParams({symbol: "AAPL", row: row({call: contract({lastPrice: 6, bid, ask})}),
      side: "call", spot: 230, dividendYield: null, now: NOW});
    expect(draftFromParams(params!)).toMatchObject({marketPrice: 6, marketPriceSource: "last"});
  }
});
