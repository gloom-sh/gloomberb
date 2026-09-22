import { expect, test } from "bun:test";
import { effectiveBinomialSteps, solveBinomialImpliedVolatility, valueBinomialOption } from "./binomial";
import { CALCULATOR_IGNORED_DIVIDENDS_NOTICE, calculatorSemanticEvidence, readCalculatorEvidence,
  normalizeCalculatorEvidenceDraft, type CalculatorEvidenceInput } from "./evidence";
import { DEFAULT_OPTION_CALC_DRAFT, solveImpliedVolatility, valueOption, type OptionCalcDraft } from "./model";
import type { CalculatorSurfaceVol } from "./surface";

function rendered(draft: OptionCalcDraft, patch: Partial<CalculatorEvidenceInput> = {}) {
  const options = { exercise: "american" as const, steps: draft.steps ?? 400, dividends: draft.dividends ?? [] };
  const american = draft.pricingModel === "american";
  return calculatorSemanticEvidence({ draft, loading: false,
    valuation: american ? valueBinomialOption(draft, options) : valueOption(draft),
    implied: american ? solveBinomialImpliedVolatility(draft, draft.marketPrice, options) : solveImpliedVolatility(draft, draft.marketPrice),
    effectiveSteps: american ? effectiveBinomialSteps(draft, options) : null, ...patch });
}

test("serialized calculator assumptions match across optional fields and construction order without losing quote attribution", () => {
  const serialized = (draft: OptionCalcDraft) => JSON.stringify(normalizeCalculatorEvidenceDraft(draft));
  expect(serialized(DEFAULT_OPTION_CALC_DRAFT)).toBe(serialized({ dividends: [], steps: 400,
    volSource: "input", pricingModel: "european", ...DEFAULT_OPTION_CALC_DRAFT }));

  const draft: OptionCalcDraft = { ...DEFAULT_OPTION_CALC_DRAFT, dividends: [{ days: 10, amount: 1 }],
    marketPriceSource: "mid", marketReference: { contractSymbol: "AAPL261218C00100000", expiration: 1_797_552_000,
      currency: "USD", bid: 5, ask: 6, lastPrice: 5.5, lastTradeDate: 1_790_078_000, lastUpdated: 1_790_078_001_000 } };
  const reordered = Object.fromEntries(Object.entries(draft).reverse()) as unknown as OptionCalcDraft;
  reordered.dividends = [{ amount: 1, days: 10 }];
  reordered.marketReference = Object.fromEntries(Object.entries(draft.marketReference!).reverse()) as typeof draft.marketReference;
  expect(serialized(draft)).toBe(serialized(reordered));
  expect(serialized(draft)).not.toBe(serialized({ ...draft, rate: .06 }));
  expect(serialized(draft)).not.toBe(serialized({ ...draft, marketPriceSource: "last" }));
  expect(serialized(draft)).not.toBe(serialized({ ...draft, marketReference: { ...draft.marketReference!, bid: 4 } }));
});

test("calculator evidence independently verifies rendered price, every Greek and the selected-model IV", () => {
  const draft = { ...DEFAULT_OPTION_CALC_DRAFT, side: "put" as const, spot: 103, strike: 105,
    daysToExpiry: 92, rate: .03, dividendYield: .01, volatility: .28 };
  draft.marketPrice = valueOption({ ...draft, volatility: .36 }).price;
  const evidence = rendered(draft);
  expect(readCalculatorEvidence(evidence)).toEqual(evidence);
  for (const metric of ["price", "delta", "gamma", "thetaPerDay", "vegaPerPoint", "rhoPerPoint"] as const) {
    const corrupt = structuredClone(evidence);
    corrupt.valuation![metric] += .01;
    expect(readCalculatorEvidence(corrupt)).toBeNull();
  }
  expect(readCalculatorEvidence({ ...evidence, implied: { ...evidence.implied, volatility: .5 } })).toBeNull();
  expect(readCalculatorEvidence({ ...evidence, implied: { ...evidence.implied, note: "Unavailable" } })).toBeNull();
  expect(readCalculatorEvidence({ ...evidence, draft: { ...evidence.draft, rate: .08 } })).toBeNull();
  expect(readCalculatorEvidence({ ...evidence, plottedValueCount: 100 })).toBeNull();
});

test("American evidence verifies the active cash schedule and effective tree refinement", () => {
  const draft: OptionCalcDraft = { ...DEFAULT_OPTION_CALC_DRAFT, pricingModel: "american", side: "put", steps: 32,
    daysToExpiry: 180, volatility: .2, dividends: [{ days: 30, amount: 2 }, { days: 120, amount: 1 }] };
  draft.marketPrice = valueBinomialOption({ ...draft, volatility: .3 }, { steps: 32, dividends: draft.dividends }).price;
  const evidence = rendered(draft);
  expect(readCalculatorEvidence(evidence)).toEqual(evidence);
  expect(readCalculatorEvidence({ ...evidence, draft: { ...evidence.draft, dividends: [] } })).toBeNull();
  expect(readCalculatorEvidence({ ...evidence, effectiveSteps: 64 })).toBeNull();
  expect(readCalculatorEvidence({ ...evidence, draft: { ...evidence.draft, pricingModel: "european" } })).toBeNull();

  const refined = rendered({ ...DEFAULT_OPTION_CALC_DRAFT, pricingModel: "american", side: "put", daysToExpiry: 365,
    rate: .2, volatility: .1, steps: 1 });
  expect(refined.effectiveSteps).toBeGreaterThan(1);
  expect(readCalculatorEvidence(refined)).toEqual(refined);
  expect(readCalculatorEvidence({ ...refined, effectiveSteps: 1 })).toBeNull();
});

test("expiry zero values and an identifiable zero IV remain numeric evidence", () => {
  for (const pricingModel of ["european", "american"] as const) {
    const expiry = rendered({ ...DEFAULT_OPTION_CALC_DRAFT, pricingModel, daysToExpiry: 0, spot: 90, strike: 100 });
    expect(Object.values(expiry.valuation!).every((value) => value === 0)).toBe(true);
    expect(expiry.plottedValueCount).toBe(6);
    expect(readCalculatorEvidence(expiry)?.complete).toBe(true);
  }
  const draft = { ...DEFAULT_OPTION_CALC_DRAFT, spot: 110, strike: 100, volatility: 0, rate: 0 };
  draft.marketPrice = valueOption(draft).price;
  const zeroIV = rendered(draft);
  expect(zeroIV.implied.volatility).toBe(0);
  expect(zeroIV.plottedValueCount).toBe(7);
  expect(readCalculatorEvidence(zeroIV)?.complete).toBe(true);
});

test("surface evidence must use its effective IV while preserving source limitations", () => {
  const draft: OptionCalcDraft = { ...DEFAULT_OPTION_CALC_DRAFT, symbol: "AAPL", volSource: "surface", spot: 115, volatility: .32 };
  const surface: CalculatorSurfaceVol = { volatility: .32, rate: .05, dividendYield: .01, sourceSpot: 100,
    spotAsOf: Date.UTC(2026, 8, 22, 14), asOf: "2026-09-22T14:00:00Z", rateAsOf: ["2026-09-21"],
    source: "OVDV midpoint: listed smile fits", warnings: ["Surface quote dates differ"], error: null };
  const evidence = rendered(draft, { surface, notices: surface.warnings });
  expect(readCalculatorEvidence(evidence)).toEqual(evidence);
  // Scenario spot and rates are independent inputs; only IV is substituted from the fit.
  expect(evidence.draft.spot).not.toBe(surface.sourceSpot!);
  expect(evidence.draft.rate).not.toBe(surface.rate!);
  expect(readCalculatorEvidence({ ...evidence, notices: [] })).toBeNull();
  expect(readCalculatorEvidence({ ...evidence, surface: null })).toBeNull();
  for (const patch of [{ volatility: null }, { volatility: .4 }, { sourceSpot: 0 }, { rate: null },
    { error: "Required expiry is stale" }, { asOf: "yesterday" }]) {
    expect(readCalculatorEvidence({ ...evidence, surface: { ...surface, ...patch } })).toBeNull();
  }
  const fallback = rendered(draft, { surface: null });
  expect(fallback.complete).toBe(false);
  expect(readCalculatorEvidence({ ...fallback, complete: true })).toBeNull();
});

test("European evidence preserves the ignored schedule notice and values without cash jumps", () => {
  const draft: OptionCalcDraft = { ...DEFAULT_OPTION_CALC_DRAFT, dividends: [{ days: 10, amount: 5 }] };
  const evidence = rendered(draft, { notices: [CALCULATOR_IGNORED_DIVIDENDS_NOTICE] });
  expect(evidence.valuation).toEqual(valueOption({ ...draft, dividends: [] }));
  expect(evidence.draft.dividends).toEqual(draft.dividends!);
  expect(readCalculatorEvidence(evidence)).toEqual(evidence);
  expect(readCalculatorEvidence({ ...evidence, notices: [] })).toBeNull();
  expect(rendered(draft).complete).toBe(false);
});

test("loading and failed captures cannot assert completion or supply absent output", () => {
  for (const patch of [{ loading: true }, { error: "Refresh failed" }]) {
    const evidence = rendered(DEFAULT_OPTION_CALC_DRAFT, patch);
    expect(readCalculatorEvidence(evidence)?.complete).toBe(false);
    expect(readCalculatorEvidence({ ...evidence, complete: true })).toBeNull();
  }
  const missing = rendered(DEFAULT_OPTION_CALC_DRAFT, { valuation: null });
  expect(missing.complete).toBe(false);
  expect(readCalculatorEvidence(missing)).toBeNull();
  const valid = rendered(DEFAULT_OPTION_CALC_DRAFT);
  expect(readCalculatorEvidence({ ...valid, complete: false })).toBeNull();
  expect(readCalculatorEvidence({ ...valid, valuation: { price: valid.valuation!.price } })).toBeNull();
});

test("malformed drafts cannot inherit the closed form's defensive defaults", () => {
  const evidence = rendered(DEFAULT_OPTION_CALC_DRAFT);
  const patches: Record<string, unknown>[] = [{ spot: NaN }, { rate: Infinity }, { daysToExpiry: -1 }, { volatility: -.1 },
    { marketPrice: undefined }, { strike: "100" }, { side: "invalid" }, { pricingModel: undefined }, { volSource: "unknown" },
    { steps: 0 }, { steps: 1.5 }, { dividends: [{ days: 31, amount: 1 }] }, { dividends: [{ days: 5, amount: -1 }] }];
  for (const patch of patches) {
    expect(readCalculatorEvidence({ ...evidence, draft: { ...evidence.draft, ...patch } })).toBeNull();
  }
  expect(readCalculatorEvidence({ ...evidence, draft: {} })).toBeNull();
  expect(readCalculatorEvidence({ ...evidence, symbol: "OTHER" })).toBeNull();
});
