import { describe, expect, test } from "bun:test";
import type { OptionContract, OptionsChain } from "../../../types/financials";
import { DEFAULT_OPTION_CALC_DRAFT, draftFromParams } from "../options-calculator/model";
import { chainIvText } from "../options-calculator/valuation";
import { daysToExpiryFrom, solveImpliedVolatility, valueOption, type OptionSide } from "../shared/volatility";
import { solveChainVolatilities } from "./analytics";
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
  return { strike: 230, call: contract(), put: contract(), impliedVolatility: 0.284, isPositionStrike: false, ...overrides };
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

describe("a chain handed to the calculator after the close", () => {
  // Monday's last quotes, read Tuesday premarket: the chain values them at their own time.
  const QUOTED = Date.UTC(2026, 7, 17, 20, 0, 0);
  const READ = QUOTED + 14 * 3_600_000;
  const SPOT = 230;
  const rate = DEFAULT_OPTION_CALC_DRAFT.rate;
  const years = daysToExpiryFrom(EXPIRATION, QUOTED) / 365;
  /** Quotes a penny either side of the model price, with the market carrying a dividend the reader does not know of. */
  function chain(dividendYield: number): OptionsChain {
    const quote = (side: OptionSide, strike: number) => {
      const price = valueOption({ side, spot: SPOT, strike, daysToExpiry: years * 365, rate, volatility: 0.3, dividendYield }).price;
      return contract({ contractSymbol: `AAPL260919${side === "call" ? "C" : "P"}${strike}`, strike, bid: price - 0.01, ask: price + 0.01 });
    };
    const strikes = [210, 220, 230, 240, 250];
    return { underlyingSymbol: "AAPL", expirationDates: [EXPIRATION], asOf: new Date(QUOTED).toISOString(),
      calls: strikes.map((strike) => quote("call", strike)), puts: strikes.map((strike) => quote("put", strike)) };
  }
  function handoff(dividendYield: number) {
    const quotes = chain(dividendYield);
    const volatilities = solveChainVolatilities(quotes, SPOT, 0, READ);
    const call = quotes.calls.find((entry) => entry.strike === 240)!;
    const params = buildChainCalcParams({ symbol: "AAPL", row: row({ strike: 240, call, put: quotes.puts[3],
      impliedVolatility: volatilities.byStrike.get(240)! }), side: "call", spot: SPOT, dividendYield: 0, now: READ,
    valuation: { time: volatilities.valuationTime, spotLabel: "close Mon 17 Aug", forward: volatilities.forwards.get(EXPIRATION) } });
    const draft = draftFromParams(params!);
    const implied = solveImpliedVolatility(draft, draft.marketPrice).volatility;
    return { draft, implied, chainIv: volatilities.byStrike.get(240)! };
  }

  test("counts its days from the quotes, so the same mid solves to the chain's IV", () => {
    const { draft, implied, chainIv } = handoff(0);
    expect(draft.valuation).toEqual({ at: QUOTED, spot: SPOT, spotLabel: "close Mon 17 Aug" });
    expect(draft.daysToExpiry).toBeCloseTo(years * 365, 8);
    expect(implied!).toBeCloseTo(chainIv, 4);
    expect(chainIvText(draft.chainIv!, 240, implied, true)).toBeNull();
  });

  test("says the chain solved against the parity forward when the two IVs part", () => {
    const { draft, implied, chainIv } = handoff(0.03);
    expect(Math.abs(implied! - chainIv)).toBeGreaterThan(0.0001);
    expect(draft.chainIv).toMatchObject({ kind: "forward" });
    expect(chainIvText(draft.chainIv!, 240, implied, true)).toMatch(/^Chain IV 30\.\d\d% solves this mid against the expiry's parity forward, 2\d\d\.\d+, not spot\.$/);
  });
});
