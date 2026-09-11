import { describe, expect, test } from "bun:test";
import { createSecEpsBasisResolver } from "./sec-eps-basis";

const oldAccn = "0000320193-19-000119";
const newAccn = "0000320193-20-000096";
const period = { start: "2017-10-01", end: "2018-09-29", form: "10-K" };
const before = { ...period, accn: oldAccn, filed: "2019-10-31", val: 11.91 };
const after = { ...period, accn: newAccn, filed: "2020-10-30", val: 2.98 };
const split = { end: "2020-08-28", val: 4, accn: newAccn, filed: "2020-10-30", form: "10-K" };
const payload = (eps = [before, after], splitRows = [split], incomes = eps.map((row) => ({ ...row, val: 59_531_000_000 }))) => ({
  facts: { "us-gaap": {
    EarningsPerShareDiluted: { units: { "USD/shares": eps } },
    StockholdersEquityNoteStockSplitConversionRatio1: { units: { pure: splitRows } },
    NetIncomeLoss: { units: { USD: incomes } },
    WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: eps.map((row) => ({ ...row, val: row.val === 2.98 ? 20_000_435_000 : 5_000_109_000 })) } },
  } },
});

describe("SEC EPS share-basis evidence", () => {
  test("uses an exact split and rounded comparative EPS with unchanged income", () => {
    const resolve = createSecEpsBasisResolver(payload());
    const older = { ...before, start: "2016-09-25", end: "2017-09-30", val: 9.21 };
    expect(resolve(older)).toMatchObject({ value: 2.3025, availableAt: "2020-10-30", basis: {
      status: "split-adjusted", originalValue: 9.21, originalFiled: "2019-10-31", factor: 4,
      evidence: [{ date: "2020-08-28", ratio: 4, accessionNumber: newAccn, beforeEps: 11.91, afterEps: 2.98 }],
    } });
    expect(resolve(after)).toMatchObject({ value: 2.98, basis: { factor: 1, originalValue: 2.98 } });
  });

  test("links an earlier accession only with matching comparative EPS and shares", () => {
    const earlier = { ...before, accn: "0000320193-18-000145", filed: "2018-11-05" };
    expect(createSecEpsBasisResolver(payload([earlier, before, after]))(earlier)).toMatchObject({ value: 2.9775, basis: { factor: 4 } });
    // This accession still has a direct same-period split witness, so use a
    // different old period to test the repeat-only link rather than that edge.
    const repeated = { ...before, start: "2016-09-25", end: "2017-09-30", val: 9.21 };
    const oldRepeat = { ...repeated, accn: earlier.accn, filed: earlier.filed };
    const fixture = payload([oldRepeat, repeated, before, after]);
    expect(createSecEpsBasisResolver(fixture)(oldRepeat).basis?.factor).toBe(4);
    fixture.facts["us-gaap"].WeightedAverageNumberOfDilutedSharesOutstanding.units.shares[0]!.val += 1;
    expect(createSecEpsBasisResolver(fixture)(oldRepeat)).toMatchObject({ basis: { status: "unresolved" } });
    expect(createSecEpsBasisResolver(fixture)(oldRepeat).value).toBeUndefined();
  });

  test("does not double-adjust an already restated pre-effective filing", () => {
    const earlyAdjusted = { ...after, accn: "0000320193-20-000062", filed: "2020-07-31" };
    const resolve = createSecEpsBasisResolver(payload([before, earlyAdjusted, after]));
    expect(resolve(earlyAdjusted)).toMatchObject({ value: 2.98, availableAt: "2020-10-30", basis: { factor: 1 } });
  });

  test("composes two disclosed, independently corroborated split factors", () => {
    const a = { ...before, start: "2010-09-26", end: "2011-09-24", accn: "0000320193-12-000001", filed: "2012-10-31", val: 28 };
    const b = { ...a, accn: "0000320193-14-000001", filed: "2014-10-31", val: 4 };
    const c = { ...a, accn: newAccn, filed: "2020-10-30", val: 1 };
    const one = { ...split, end: "2014-06-06", val: 7, accn: b.accn, filed: b.filed };
    const resolve = createSecEpsBasisResolver(payload([a, b, c], [one, split]));
    expect(resolve({ ...a, end: "2010-09-25", val: 14 })).toMatchObject({ value: .5, basis: { factor: 28 } });
    expect(resolve(b)).toMatchObject({ value: 1, basis: { factor: 4 } });
  });

  test("supports a reverse split without confusing it with earnings growth", () => {
    const pre = { ...before, val: 2 };
    const post = { ...after, val: 10 };
    expect(createSecEpsBasisResolver(payload([pre, post], [{ ...split, val: .2 }]))(pre)).toMatchObject({ value: 10, basis: { factor: .2 } });
  });

  test("never infers a split from EPS changes, price changes, or filing chronology", () => {
    expect(createSecEpsBasisResolver(payload([before, after], []))(before)).toEqual({ value: 11.91, availableAt: before.filed });
    const unknown = { ...before, accn: "0000320193-17-000001", filed: "2017-10-31" };
    expect(createSecEpsBasisResolver(payload())(unknown).value).toBeUndefined();
    const restatement = payload();
    restatement.facts["us-gaap"].NetIncomeLoss.units.USD[1]!.val += 1;
    expect(createSecEpsBasisResolver(restatement)(before).value).toBeUndefined();
    expect(createSecEpsBasisResolver(payload([before, { ...after, val: 3.5 }]))(before).value).toBeUndefined();
  });

  test("rejects conflicting, missing, zero and invalid-date evidence", () => {
    expect(createSecEpsBasisResolver(payload([before, after], [split, { ...split, val: 5 }]))(before).value).toBeUndefined();
    expect(createSecEpsBasisResolver(payload([{ ...before, val: 0 }, { ...after, val: 0 }]))(before).value).toBeUndefined();
    expect(() => createSecEpsBasisResolver(payload([before, after], [{ ...split, end: "2020-99-99" }]))).not.toThrow();
    expect(createSecEpsBasisResolver(payload())({ ...before, filed: undefined }).value).toBeUndefined();
  });
});
