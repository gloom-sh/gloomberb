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

type Rows = Array<Record<string, unknown>>;
const facts = (eps: Rows, splits: Rows, income: Rows, shares: Rows = []) => ({ facts: { "us-gaap": {
  EarningsPerShareDiluted: { units: { "USD/shares": eps } },
  StockholdersEquityNoteStockSplitConversionRatio1: { units: { pure: splits } },
  NetIncomeLoss: { units: { USD: income } },
  WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares } },
} } });

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

  test("one split stated under several context dates is one factor, back to each figure's own filing", () => {
    // Alphabet, abridged: the 2022 20:1 split stated at 2022-02-01 (announced) in the Q1 to Q3 10-Qs and at
    // 2022-07-15 (effective) from Q3 on. The Q1 10-Q states it but still reports on the old basis. No filing
    // tags diluted shares and no two share a period, so only the split connects them.
    const [q2Old, q3Old, q1Pre, q2New, q3New, q1New] = ["0001652044-21-000047", "0001652044-21-000057",
      "0001652044-22-000029", "0001652044-22-000071", "0001652044-22-000090", "0001652044-23-000045"];
    const q2 = { start: "2021-04-01", end: "2021-06-30", form: "10-Q" }, q3 = { start: "2021-07-01", end: "2021-09-30", form: "10-Q" };
    const q1 = { start: "2022-01-01", end: "2022-03-31", form: "10-Q" };
    const eps = [
      { ...q2, accn: q2Old, filed: "2021-07-28", val: 27.26 }, { ...q2, accn: q2New, filed: "2022-07-27", val: 1.36 },
      { ...q3, accn: q3Old, filed: "2021-10-27", val: 27.99 }, { ...q3, accn: q3New, filed: "2022-10-26", val: 1.4 },
      { ...q1, accn: q1Pre, filed: "2022-04-27", val: 24.62 }, { ...q1, accn: q1New, filed: "2023-04-26", val: 1.23 },
    ];
    const income = { [q2.end]: 18_525_000_000, [q3.end]: 18_936_000_000, [q1.end]: 16_436_000_000 };
    const stated = (end: string, accn: string, filed: string) => ({ end, val: 20, accn, filed, form: "10-Q" });
    const resolve = createSecEpsBasisResolver(facts(eps, [
      stated("2022-02-01", q1Pre, "2022-04-27"), stated("2022-02-01", q2New, "2022-07-27"), stated("2022-02-01", q3New, "2022-10-26"),
      stated("2022-07-15", q3New, "2022-10-26"), stated("2022-07-15", q1New, "2023-04-26"),
    ], eps.map((row) => ({ ...row, val: income[row.end]! }))));
    expect(resolve(eps[0]!)).toMatchObject({ value: 1.363, availableAt: "2022-07-27", basis: {
      status: "split-adjusted", factor: 20, originalValue: 27.26, originalFiled: "2021-07-28", basisDate: "2022-07-15",
    } });
    expect(resolve(eps[2]!)).toMatchObject({ value: 1.3995, basis: { factor: 20, originalFiled: "2021-10-27" } });
    // The announcing 10-Q is a restated filing, not a restating one.
    expect(resolve(eps[4]!)).toMatchObject({ value: 1.231, basis: { factor: 20, originalFiled: "2022-04-27" } });
    expect(resolve(eps[1]!)).toMatchObject({ value: 1.36, basis: { factor: 1 } });
  });

  test("one split stated at different dates in filings that share no period is still one factor", () => {
    // NVIDIA, abridged: the 2021 4:1 split at 2021-06-03 in the Q2 FY2022 10-Q and at 2021-07-19 in the FY2022
    // 10-K. Each restates its own comparative; nothing else links the quarter to the year.
    const quarter = { start: "2020-04-27", end: "2020-07-26", form: "10-Q" }, year = { start: "2020-01-27", end: "2021-01-31", form: "10-K" };
    const eps = [
      { ...quarter, accn: "0001045810-20-000147", filed: "2020-08-19", val: .99 }, { ...quarter, accn: "0001045810-21-000131", filed: "2021-08-20", val: .25 },
      { ...year, accn: "0001045810-21-000010", filed: "2021-02-26", val: 6.9 }, { ...year, accn: "0001045810-22-000036", filed: "2022-03-18", val: 1.73 },
    ];
    const resolve = createSecEpsBasisResolver(facts(eps, [
      { end: "2021-06-03", val: 4, accn: eps[1]!.accn, filed: eps[1]!.filed, form: "10-Q" },
      { end: "2021-07-19", val: 4, accn: eps[3]!.accn, filed: eps[3]!.filed, form: "10-K" },
    ], eps.map((row) => ({ ...row, val: row.form === "10-Q" ? 622_000_000 : 4_332_000_000 }))));
    expect(resolve(eps[0]!)).toMatchObject({ value: .2475, availableAt: "2021-08-20", basis: { factor: 4, originalFiled: "2020-08-19" } });
    expect(resolve(eps[2]!)).toMatchObject({ value: 1.725, basis: { factor: 4, originalFiled: "2021-02-26" } });
  });

  test("a filing that restates by a proved split without stating it restates on that split", () => {
    // NVIDIA, abridged: the 2024 10:1 split is stated only in the 10-Qs; the FY2025 10-K restates FY2024 without it.
    const quarter = { start: "2023-05-01", end: "2023-07-30", form: "10-Q" }, year = { start: "2023-01-30", end: "2024-01-28", form: "10-K" };
    const eps = [
      { ...quarter, accn: "0001045810-23-000175", filed: "2023-08-28", val: 2.48 }, { ...quarter, accn: "0001045810-24-000264", filed: "2024-08-28", val: .25 },
      { ...year, accn: "0001045810-24-000029", filed: "2024-02-21", val: 11.93 }, { ...year, accn: "0001045810-25-000023", filed: "2025-02-26", val: 1.19 },
    ];
    const split = { start: "2024-05-01", end: "2024-05-31", val: 10, accn: eps[1]!.accn, filed: eps[1]!.filed, form: "10-Q" };
    const incomes = eps.map((row) => ({ ...row, val: row.form === "10-Q" ? 6_188_000_000 : 29_760_000_000 }));
    const resolve = createSecEpsBasisResolver(facts(eps, [split], incomes));
    expect(resolve(eps[2]!)).toMatchObject({ value: 1.193, basis: { status: "split-adjusted", factor: 10, originalFiled: "2024-02-21" } });
    expect(resolve(eps[3]!)).toMatchObject({ value: 1.19, basis: { factor: 1 } });
    // Income that changed is a restatement, not the split.
    incomes[3]!.val += 1;
    expect(createSecEpsBasisResolver(facts(eps, [split], incomes))(eps[2]!).value).toBeUndefined();
  });

  test("links repeated EPS without diluted shares only when no disclosed split could leave it unchanged", () => {
    const [older, newer, restated] = ["0001652044-20-000060", "0001652044-21-000047", "0001652044-22-000071"];
    const prior = { start: "2020-04-01", end: "2020-06-30", form: "10-Q" }, period = { start: "2021-04-01", end: "2021-06-30", form: "10-Q" };
    const eps = [
      { ...prior, accn: older, filed: "2020-07-31", val: 10.13 }, { ...prior, accn: newer, filed: "2021-07-28", val: 10.13 },
      { ...period, accn: newer, filed: "2021-07-28", val: 27.26 }, { ...period, accn: restated, filed: "2022-07-27", val: 1.36 },
    ];
    const incomes = eps.map((row) => ({ ...row, val: row.end === prior.end ? 6_959_000_000 : 18_525_000_000 }));
    const split = { end: "2022-02-01", val: 20, accn: restated, filed: "2022-07-27", form: "10-Q" };
    const linked = createSecEpsBasisResolver(facts(eps, [split], incomes))(eps[0]!);
    expect(linked.value).toBeCloseTo(.5065, 10);
    expect(linked.basis).toMatchObject({ status: "split-adjusted", factor: 20, originalFiled: "2020-07-31" });
    // Diluted shares that differ keep the filings apart.
    const shares = [{ ...eps[0]!, val: 693_000_000 }, { ...eps[1]!, val: 692_000_000 }];
    expect(createSecEpsBasisResolver(facts(eps, [split], incomes, shares))(eps[0]!).value).toBeUndefined();
    // A disclosed 5% stock dividend could leave 0.05 unchanged at cent rounding.
    const small = eps.map((row) => row.end === prior.end ? { ...row, val: .05 } : row);
    const dividend = { end: "2010-01-04", val: 1.05, accn: "0001652044-10-000001", filed: "2010-02-01", form: "10-K" };
    expect(createSecEpsBasisResolver(facts(small, [split], incomes))(small[0]!).value).toBeCloseTo(.0025, 10);
    expect(createSecEpsBasisResolver(facts(small, [split, dividend], incomes))(small[0]!).value).toBeUndefined();
  });

  test("keeps two splits with one ratio apart and never merges them into one factor", () => {
    // Copart, abridged: 2:1 splits stated at 2022-10-03 and 2023-08-04. The second restates a filing that already
    // carries the first, so no single filing date separates their restatements.
    const [a, b, c] = ["0000900075-21-000045", "0000900075-22-000065", "0000900075-23-000043"];
    const fy22 = { start: "2021-08-01", end: "2021-10-31", form: "10-Q" }, fy23 = { start: "2022-08-01", end: "2022-10-31", form: "10-Q" };
    const eps = [
      { ...fy22, accn: a, filed: "2021-11-18", val: 1.2 }, { ...fy22, accn: b, filed: "2022-11-18", val: .6 },
      { ...fy23, accn: b, filed: "2022-11-18", val: 1.4 }, { ...fy23, accn: c, filed: "2023-11-21", val: .7 },
    ];
    const resolve = createSecEpsBasisResolver(facts(eps, [
      { end: "2022-10-03", val: 2, accn: b, filed: "2022-11-18", form: "10-Q" },
      { end: "2022-10-03", val: 2, accn: c, filed: "2023-11-21", form: "10-Q" },
      { end: "2023-08-04", val: 2, accn: c, filed: "2023-11-21", form: "10-Q" },
    ], eps.map((row) => ({ ...row, val: row.end === fy22.end ? 287_000_000 : 334_000_000 }))));
    expect(resolve(eps[0]!)).toMatchObject({ value: .3, basis: { factor: 4 } });
    expect(resolve(eps[2]!)).toMatchObject({ value: .7, basis: { factor: 2 } });
  });

  test("withholds a ratio whose restatements no single filing date separates", () => {
    // One context date, but the later restated filing was filed after the earlier restating one: two splits or
    // a misfiled basis, and either way no figure before it is safe to convert.
    const p1 = { start: "2019-01-01", end: "2019-03-31", form: "10-Q" }, p2 = { start: "2020-01-01", end: "2020-03-31", form: "10-Q" };
    const eps = [
      { ...p1, accn: "0000000001-19-000001", filed: "2019-04-30", val: 1 }, { ...p1, accn: "0000000001-20-000002", filed: "2020-06-01", val: .5 },
      { ...p2, accn: "0000000001-20-000003", filed: "2020-09-01", val: 2 }, { ...p2, accn: "0000000001-21-000004", filed: "2021-03-01", val: 1 },
    ];
    const resolve = createSecEpsBasisResolver(facts(eps, [
      { end: "2020-12-31", val: 2, accn: eps[1]!.accn, filed: eps[1]!.filed, form: "10-Q" },
      { end: "2020-12-31", val: 2, accn: eps[3]!.accn, filed: eps[3]!.filed, form: "10-Q" },
    ], eps.map((row) => ({ ...row, val: row.end === p1.end ? 50_000_000 : 100_000_000 }))));
    for (const row of [eps[0]!, eps[2]!]) expect(resolve(row)).toMatchObject({ basis: { status: "unresolved" } });
    for (const row of eps) expect(resolve(row).value).toBeUndefined();
  });

  test("rejects conflicting, missing, zero and invalid-date evidence", () => {
    expect(createSecEpsBasisResolver(payload([before, after], [split, { ...split, val: 5 }]))(before).value).toBeUndefined();
    expect(createSecEpsBasisResolver(payload([{ ...before, val: 0 }, { ...after, val: 0 }]))(before).value).toBeUndefined();
    expect(() => createSecEpsBasisResolver(payload([before, after], [{ ...split, end: "2020-99-99" }]))).not.toThrow();
    expect(createSecEpsBasisResolver(payload())({ ...before, filed: undefined }).value).toBeUndefined();
  });
});
