import { describe, expect, test } from "bun:test";
import {
  DEFAULT_OPTION_CALC_DRAFT,
  buildOptionCalcParams,
  describeDraftProblem,
  draftFromParams,
  updateOptionCalcDraft,
  reconcileOptionCalcDraft,
  type OptionCalcDraft,
} from "./model";

const CANONICAL: OptionCalcDraft = {
  ...DEFAULT_OPTION_CALC_DRAFT,
  side: "call",
  spot: 100,
  strike: 100,
  daysToExpiry: 365,
  rate: 0.05,
  volatility: 0.2,
  dividendYield: 0,
};

test("contract edits retain numeric what-if inputs without borrowing market attribution", () => {
  const original: OptionCalcDraft = { ...CANONICAL, marketPrice: 20.425, marketPriceSource: "mid",
    marketReference: { contractSymbol: "COST260925C00900000", currency: "USD", expiration: 1790294400,
      bid: 19.75, ask: 21.1, lastPrice: 21.34, lastTradeDate: 1789136721 } };
  for (const patch of [{ side: "put" as const }, { strike: 105 }, { daysToExpiry: 14 }, { symbol: "COST" }]) {
    const changed = updateOptionCalcDraft(original, patch);
    expect(changed.marketPrice).toBe(20.425);
    expect(changed.marketPriceSource).toBeUndefined();
    expect(changed.marketReference).toBeUndefined();
    const restored = updateOptionCalcDraft(changed, { side: original.side, strike: original.strike,
      daysToExpiry: original.daysToExpiry, symbol: original.symbol });
    expect(restored.marketPriceSource).toBeUndefined();
  }
  expect(updateOptionCalcDraft(original, { side: original.side })).toEqual(original);
  expect(updateOptionCalcDraft(original, { volatility: 0.4, spot: 120 }).marketReference).toEqual(original.marketReference);
  expect(updateOptionCalcDraft(original, { marketPrice: 20.425 }).marketPriceSource).toBeUndefined();
  expect(updateOptionCalcDraft({ ...CANONICAL, marketPrice: 5 }, { side: "put" }).marketPrice).toBe(5);
});

test("restored legacy changed-contract drafts lose stale source attribution before interaction", () => {
  const seed = { ...CANONICAL, marketPrice: 20.425, marketPriceSource: "mid" as const };
  const legacyPut = { ...seed, side: "put" as const };
  expect(reconcileOptionCalcDraft(legacyPut, seed)).toMatchObject({
    side: "put", marketPrice: 20.425, marketPriceSource: undefined, marketReference: undefined,
  });
  expect(reconcileOptionCalcDraft(seed, seed).marketPriceSource).toBe("mid");
  expect(reconcileOptionCalcDraft({ ...seed, marketPrice: 5 }, seed).marketPriceSource).toBeUndefined();
  const manual = updateOptionCalcDraft(legacyPut, { side: "call" });
  expect(reconcileOptionCalcDraft(manual, seed).marketPriceSource).toBeUndefined();
});

describe("seeding", () => {
  const now = Date.UTC(2026, 7, 20, 18, 0, 0);

  test("round-trips a seeded contract through pane params", () => {
    const params = buildOptionCalcParams({
      symbol: "aapl",
      side: "put",
      spot: 231.5,
      strike: 230,
      expiration: Date.UTC(2026, 8, 19) / 1000,
      volatility: 0.284,
      marketPrice: 7.35,
      dividendYield: 0.0044,
    }, now);

    expect(draftFromParams(params)).toEqual({
      symbol: "AAPL",
      side: "put",
      spot: 231.5,
      strike: 230,
      daysToExpiry: 30 + 2 / 24,
      rate: DEFAULT_OPTION_CALC_DRAFT.rate,
      volatility: 0.284,
      dividendYield: 0.0044,
      marketPrice: 7.35,
    });
  });

  test("drops seed values a chain reports as zero rather than seeding zeros", () => {
    const params = buildOptionCalcParams({ symbol: "MSFT", spot: 400, volatility: 0, marketPrice: 0 }, now);

    expect(params.volatility).toBeUndefined();
    expect(params.marketPrice).toBeUndefined();
    expect(draftFromParams(params).volatility).toBe(DEFAULT_OPTION_CALC_DRAFT.volatility);
  });
});

describe("describeDraftProblem", () => {
  test("names the first unusable input", () => {
    expect(describeDraftProblem(CANONICAL)).toBeNull();
    expect(describeDraftProblem({ ...CANONICAL, spot: 0 })).toMatch(/Spot/);
    expect(describeDraftProblem({ ...CANONICAL, volatility: -0.1 })).toMatch(/Volatility/);
  });
});
