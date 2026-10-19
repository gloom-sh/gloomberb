import { describe, expect, test } from "bun:test";
import type { FundBondFacts } from "../api-client/fund-facts";
import {
  analyzeTaxEquivalent, distributionBasis, loadTreasuryTenors, nearestTenor, parseTaxRates, taxEquivalentJson, taxEquivalentLines,
  taxEquivalentYield, type TreasuryTenor,
} from "./tax-equivalent";

const ISHARES = { source: "iShares", url: "https://www.ishares.com/us/products/239766/ishares-national-muni-bond-etf" };

// MUB, CMF and NYF as the iShares screener gave them on 2026-10-19.
const MUB: FundBondFacts = {
  kind: "municipal", state: null,
  secYield: { value: 4.0418, asOf: "2026-10-15", ...ISHARES },
  yieldToWorst: { value: 4.16, asOf: "2026-10-15", ...ISHARES },
  duration: { value: 7.12591, asOf: "2026-10-15", measure: "effective", ...ISHARES },
};
const CMF: FundBondFacts = { ...MUB, state: "CA", secYield: { value: 3.8708, asOf: "2026-10-15", ...ISHARES },
  duration: { value: 6.97523, asOf: "2026-10-15", measure: "effective", ...ISHARES } };
const NYF: FundBondFacts = { ...MUB, state: "NY", secYield: { value: 4.0233, asOf: "2026-10-15", ...ISHARES } };
const AGG: FundBondFacts = { ...MUB, kind: "taxable", secYield: { value: 5.0825, asOf: "2026-10-15", ...ISHARES } };

const CURVE: TreasuryTenor[] = [
  ["1M", 1 / 12, 4.02], ["3M", 0.25, 4.0], ["1Y", 1, 3.85], ["2Y", 2, 4.4], ["3Y", 3, 4.55], ["5Y", 5, 4.76],
  ["7Y", 7, 4.98], ["10Y", 10, 5.18], ["20Y", 20, 5.61], ["30Y", 30, 5.55],
].map(([tenor, years, yieldPercent]) => ({ tenor: tenor as string, years: years as number, yield: yieldPercent as number, asOf: "2026-10-16" }));

const FEDERAL = { federal: 40.8, state: null };

describe("tax rates as typed", () => {
  test("take a percent, with or without its sign, and a state rate only with its state", () => {
    expect(parseTaxRates({})).toBeNull();
    expect(parseTaxRates({ taxRate: "40.8" })).toEqual({ federal: 40.8, state: null });
    expect(parseTaxRates({ taxRate: "40.8%" })).toEqual({ federal: 40.8, state: null });
    expect(parseTaxRates({ taxRate: 40.8, stateRate: "13.3", state: "ca" })).toEqual({ federal: 40.8, state: { rate: 13.3, code: "CA" } });
  });

  test("refuse what cannot be a rate, half a state pair, a state without a federal rate and rates of 100% or more", () => {
    for (const taxRate of ["-1", "100", "abc", "0.4.8", "40,8"]) expect(() => parseTaxRates({ taxRate }), taxRate).toThrow("--tax-rate takes a rate");
    expect(() => parseTaxRates({ taxRate: "40.8", stateRate: "13.3" })).toThrow("--state-rate and --state go together");
    expect(() => parseTaxRates({ taxRate: "40.8", state: "CA" })).toThrow("--state-rate and --state go together");
    expect(() => parseTaxRates({ stateRate: "13.3", state: "CA" })).toThrow("go with --tax-rate");
    expect(() => parseTaxRates({ taxRate: "60", stateRate: "40", state: "CA" })).toThrow("under 100%");
    expect(() => parseTaxRates({ taxRate: "40.8", stateRate: "9.3", state: "California" })).toThrow("two-letter");
  });
});

describe("tax-equivalent yield", () => {
  test("MUB's 4.04% SEC yield at 40.8% is 6.83%, the figure iShares publishes", () => {
    expect(taxEquivalentYield(4.0418, 40.8)).toBeCloseTo(6.8274, 4);
    const mub = analyzeTaxEquivalent({ symbol: "MUB", bond: MUB, rates: FEDERAL, treasury: CURVE });
    expect(mub.taxEquivalentYield!).toBeGreaterThanOrEqual(6.82);
    expect(mub.taxEquivalentYield!).toBeLessThan(6.835);
    expect(mub.basis).toEqual({ kind: "sec", value: 4.0418, asOf: "2026-10-15", label: "30-day SEC yield" });
    expect(taxEquivalentLines(mub).map((line) => [line.label, line.text])).toEqual([
      ["Tax rate", "40.8% (federal; no state rate given)"],
      ["Tax-equivalent yield", "6.83% (30-day SEC yield 4.04% as of 2026-10-15 / (1 - 40.8%))"],
      ["Muni/Treasury ratio", "81.2% (SEC yield 4.04% / 7Y Treasury 4.98% on 2026-10-16, the tenor nearest its 7.13-year duration)"],
    ]);
  });

  test("a state rate counts for a single-state fund of that state only, without netting it against the federal rate", () => {
    const california = { federal: 40.8, state: { rate: 13.3, code: "CA" } };
    // CMF at 40.8% + 13.3%: 8.43%, iShares' own figure for it.
    const cmf = analyzeTaxEquivalent({ symbol: "CMF", bond: CMF, rates: california, treasury: CURVE });
    expect(cmf.stateApplied).toBe(true);
    expect(cmf.combinedRate).toBeCloseTo(54.1, 6);
    expect(cmf.taxEquivalentYield!.toFixed(2)).toBe("8.43");
    expect(taxEquivalentLines(cmf)[0]!.text).toBe("54.1% (federal 40.8% + CA 13.3%)");

    // A national fund's income is taxed by the state, so the state rate cancels out; another state's fund likewise.
    const mub = analyzeTaxEquivalent({ symbol: "MUB", bond: MUB, rates: california, treasury: CURVE });
    expect([mub.stateApplied, mub.combinedRate, mub.taxEquivalentYield!.toFixed(2)]).toEqual([false, 40.8, "6.83"]);
    expect(mub.stateNote).toBe("--state-rate not added: MUB is a national fund, its income is taxed by CA");
    const nyf = analyzeTaxEquivalent({ symbol: "NYF", bond: NYF, rates: california, treasury: CURVE });
    expect([nyf.stateApplied, nyf.combinedRate]).toEqual([false, 40.8]);
    expect(taxEquivalentLines(nyf)[0]!.text).toBe("40.8% (federal; --state-rate not added: NYF is a NY fund, not CA)");
    // The same fund with its own state gets it.
    expect(analyzeTaxEquivalent({ symbol: "NYF", bond: NYF, rates: { federal: 40.8, state: { rate: 10.9, code: "NY" } } }).combinedRate)
      .toBeCloseTo(51.7, 6);
  });

  test("on the distribution yield, labelled so, when the sponsor publishes no SEC yield", () => {
    const bond = { ...MUB, secYield: null };
    const analysis = analyzeTaxEquivalent({
      symbol: "MUB", bond, rates: FEDERAL, treasury: CURVE, distribution: distributionBasis(0.0327, "forward", "2026-10-01"),
    });
    expect(analysis.basis).toEqual({ kind: "distribution", value: 3.27, asOf: "2026-10-01", label: "forward distribution yield (not SEC yield)" });
    expect(analysis.taxEquivalentYield!.toFixed(2)).toBe("5.52");
    expect(taxEquivalentLines(analysis).map((line) => line.text).slice(1)).toEqual([
      "5.52% (forward distribution yield (not SEC yield) 3.27% as of 2026-10-01 / (1 - 40.8%))",
      "65.7% (distribution yield 3.27% / 7Y Treasury 4.98% on 2026-10-16, the tenor nearest its 7.13-year duration)",
    ]);
    expect(analyzeTaxEquivalent({ symbol: "MUB", bond, rates: FEDERAL }).notApplicable)
      .toBe("no tax-equivalent yield: MUB has neither a SEC yield nor a distribution yield");
  });

  test("a taxable bond fund and a listing with no bond facts get none, saying why", () => {
    const agg = analyzeTaxEquivalent({ symbol: "AGG", bond: AGG, rates: FEDERAL, treasury: CURVE });
    expect(agg.taxEquivalentYield).toBeUndefined();
    expect(taxEquivalentLines(agg)).toEqual([
      { key: "taxRate", label: "Tax rate", text: "40.8% (federal)", value: 40.8, unit: "%" },
      { key: "taxEquivalentYield", label: "Tax-equivalent yield", text: "no tax-equivalent yield: AGG is a taxable bond fund, its income is taxed", value: null },
    ]);
    expect(analyzeTaxEquivalent({ symbol: "KO", bond: null, rates: FEDERAL }).notApplicable)
      .toBe("no tax-equivalent yield: KO is not a bond fund with sponsor figures (iShares, Vanguard and SPDR bond ETFs have them)");
  });
});

describe("muni/Treasury ratio", () => {
  test("is against the tenor nearest the duration, the shorter on a tie, and named with its date", () => {
    expect(nearestTenor(CURVE, 7.12591)?.tenor).toBe("7Y");
    expect(nearestTenor(CURVE, 1.96913)?.tenor).toBe("2Y");
    expect(nearestTenor(CURVE, 8.5)?.tenor).toBe("7Y");
    expect(nearestTenor(CURVE, 17)?.tenor).toBe("20Y");
    expect(nearestTenor(CURVE, null)).toBeNull();
    expect(nearestTenor([], 7)).toBeNull();
    const ratio = analyzeTaxEquivalent({ symbol: "MUB", bond: MUB, rates: FEDERAL, treasury: CURVE }).ratio!;
    expect(ratio.value).toBeCloseTo(4.0418 / 4.98, 10);
    expect(ratio.treasury).toEqual({ tenor: "7Y", years: 7, yield: 4.98, asOf: "2026-10-16" });
  });

  test("says why it is missing: no duration, or no curve", () => {
    const noDuration = analyzeTaxEquivalent({ symbol: "MUB", bond: { ...MUB, duration: null }, rates: FEDERAL, treasury: CURVE });
    expect(noDuration.ratio).toBeNull();
    expect(taxEquivalentLines(noDuration)[2]!.text).toBe("no ratio: MUB's sponsor publishes no duration to match a Treasury tenor");
    const noCurve = analyzeTaxEquivalent({ symbol: "MUB", bond: MUB, rates: FEDERAL, treasury: null });
    expect(taxEquivalentLines(noCurve)[2]!.text).toBe("no ratio: the Treasury curve could not be read");
  });

  test("reads GC's latest US curve, FRED's when the stored one fails, and none when both do", async () => {
    const stored = {
      getCloudCurve: async () => ({ asOf: "2026-10-16", points: [{ tenor: "7Y", years: 7, yield: 4.98 }, { tenor: "10Y", years: 10, yield: null }] }),
      getCloudYieldCurve: async () => { throw new Error("not asked"); },
    } as unknown as Parameters<typeof loadTreasuryTenors>[0];
    expect(await loadTreasuryTenors(stored)).toEqual([{ tenor: "7Y", years: 7, yield: 4.98, asOf: "2026-10-16" }]);
    const fred = {
      getCloudCurve: async () => { throw new Error("offline"); },
      getCloudYieldCurve: async () => [{ maturity: "7Y", maturityYears: 7, yield: 4.97, asOf: "2026-10-15" }],
    } as unknown as Parameters<typeof loadTreasuryTenors>[0];
    expect(await loadTreasuryTenors(fred)).toEqual([{ tenor: "7Y", years: 7, yield: 4.97, asOf: "2026-10-15" }]);
    const none = { getCloudCurve: async () => { throw new Error("offline"); }, getCloudYieldCurve: async () => { throw new Error("offline"); } } as
      unknown as Parameters<typeof loadTreasuryTenors>[0];
    expect(await loadTreasuryTenors(none)).toBeNull();
  });
});

test("JSON keeps the rates, the yield it was taken on, both results and the formulas", () => {
  const json = taxEquivalentJson(analyzeTaxEquivalent({
    symbol: "MUB", bond: MUB, rates: { federal: 40.8, state: { rate: 13.3, code: "CA" } }, treasury: CURVE,
  }));
  expect(json).toMatchObject({
    federalRate: 40.8,
    stateRate: { rate: 13.3, code: "CA", applied: false },
    combinedRate: 40.8,
    basis: { kind: "sec", value: 4.0418 },
    muniTreasuryRatio: { tenor: "7Y", treasuryYield: 4.98, treasuryAsOf: "2026-10-16", durationYears: 7.12591 },
    notes: ["--state-rate not added: MUB is a national fund, its income is taxed by CA"],
  });
  expect(json.formula).toContain("yield / (1 - (federal rate + state rate))");
  expect(json.ratioFormula).toContain("nearest the fund's duration");
});
