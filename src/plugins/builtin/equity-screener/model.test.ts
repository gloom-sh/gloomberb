import { MISSING_VALUE } from "../../../utils/format";
import { screenFixture as payload } from "./test-fixture";
import { expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { DIVIDEND_FIELDS, GRADE_FIELDS, LETTER_GRADE_FIELDS, OPTION_VOLATILITY_FIELDS, OWNERSHIP_FIELDS, QUALITY_FIELDS, SCORE_FIELDS, RESEARCH_FIELDS, SOCIAL_FIELDS, TECHNICAL_FIELDS, VOLATILITY_FIELDS, type ScreenFieldDefinition, type ScreenSnapshot } from "../../../api-client/equity-screener";
import { fetchScreen, fetchScreenFields } from "./client";
import {
  appendScreenPage,
  columnWidth,
  criterionText,
  DEFAULT_SCREEN,
  dividendYieldBasis,
  formatScreenMetric,
  formatScreenValue,
  gradeRankText,
  metricDate,
  parseCriterion,
  parseThreshold,
  screenListings,
  resultFields,
  parseScreenDefinition,
  screenColumnLabel,
  screenDetailValue,
  screenLabel,
  screenSignValue,
  screenYtdBase,
  SHORT_LABELS,
  splitGradeReason,
  SIGN_COLORED,
  validateScreenPayload,
  criterionInputText,
  criterionValueLabel,
  firstScreenSortDirection,
  pressedScreenSort,
} from "./model";
const field = {
  id: "trailingPE" as const,
  label: "P/E",
  kind: "number" as const,
  unit: "x",
  description: "",
  operators: ["gte", "between", "present"] as const,
};

test("criteria preserve zero and finite bounds, reject blank, currency ambiguity and observed-subset absence claims", () => {
  expect(
    parseCriterion({ ...field, operators: [...field.operators] }, "gte", "0"),
  ).toEqual({ field: "trailingPE", op: "gte", value: 0 });
  expect(() =>
    parseCriterion({ ...field, operators: [...field.operators] }, "gte", ""),
  ).toThrow("finite");
  expect(() =>
    parseCriterion(
      { ...field, operators: [...field.operators] },
      "between",
      "20,10",
    ),
  ).toThrow("ascending");
  expect(() =>
    parseScreenDefinition({ ...DEFAULT_SCREEN, currency: null }),
  ).toThrow("currency");
  expect(() =>
    parseScreenDefinition({
      ...DEFAULT_SCREEN,
      criteria: [{ field: "insiderPurchases90d", op: "eq", value: 0 }],
    }),
  ).toThrow('criteria[0] (insiderPurchases90d): op "eq" is not supported: insiderPurchases90d takes gte, gt, present, missing.');
});
test("boundaries reject fabricated dates and percentiles; pagination cannot cross snapshots", () => {
  const data = payload();
  expect(validateScreenPayload(data)).toBe(data);
  data.rows[0]!.metrics.price.value = 1;
  data.rows[0]!.metrics.price.state = "available";
  expect(() => validateScreenPayload(data)).toThrow("price");
  data.rows[0]!.metrics.price.asOf = "2026-09-22";
  data.rows[0]!.metrics.price.percentile.value = 101;
  expect(() => validateScreenPayload(data)).toThrow("price");
  const dated = payload();
  dated.snapshot!.assembledAt = null as unknown as ScreenSnapshot["assembledAt"];
  expect(() => validateScreenPayload(dated)).toThrow("snapshot identity");
  const undated = payload();
  undated.rows[0]!.metrics.marketCap.value = 12;
  undated.rows[0]!.metrics.marketCap.state = "partial";
  undated.rows[0]!.metrics.marketCap.observedAt = "2026-09-22T12:00:00Z";
  expect(validateScreenPayload(undated).rows[0]!.metrics.marketCap.asOf).toBeNull();
  const next = payload();
  next.snapshot!.id = "two";
  expect(() => appendScreenPage(payload(), next)).toThrow("snapshot changed");
  expect(appendScreenPage(payload(), payload()).rows).toHaveLength(1);
});

test("query boundary rejects valid rows from different criteria", async () => {
  const response = payload();
  response.definition.criteria = [];
  await expect(fetchScreen(DEFAULT_SCREEN, null, undefined, {
    equityScreener: async <T>() => response as T,
  })).rejects.toThrow("requested criteria");
});

test("a field typed without its unit or in part names the screen fields it means", () => {
  const criterion = (field: string) => () => parseScreenDefinition({ ...DEFAULT_SCREEN, criteria: [{ field, op: "lte", value: 60 }] });
  expect(criterion("payoutRatio")).toThrow('"payoutRatio" is not a screen field (did you mean payoutRatioPercent?)');
  expect(criterion("dividendGrowth")).toThrow("did you mean dividendGrowth1YPercent or dividendGrowth3YPercent or dividendGrowthYears?");
  expect(criterion("bogus")).toThrow('"bogus" is not a screen field: use a numeric field');
});

test("thresholds accept scale suffixes and reject anything else", () => {
  expect(parseThreshold("10B")).toBe(10_000_000_000);
  expect(parseThreshold("1.5t")).toBe(1_500_000_000_000);
  expect(parseThreshold("-0.5")).toBe(-0.5);
  expect(parseThreshold("1e6")).toBe(1_000_000);
  expect(parseThreshold("10 B")).toBeNull();
  expect(parseThreshold("ten")).toBeNull();
  expect(criterionText({ field: "marketCap", op: "gte", value: 10_000_000_000 })).toBe("Market cap >= 10B");
  expect(criterionText({ field: "trailingPE", op: "between", value: [0, 25] })).toBe("Trailing P/E between 0, 25");
});

test("values keep sign, scale and missing distinct from zero", () => {
  expect(formatScreenValue("marketCap", 5_547_531_698_176)).toBe("5.55T");
  expect(formatScreenValue("revenueGrowthPercent", 65.47)).toBe("+65.5");
  expect(formatScreenValue("revenueGrowthPercent", 0)).toBe("0.0");
  expect(formatScreenValue("insiderSales90d", 20)).toBe("20");
  expect(formatScreenValue("trailingPE", null)).toBe(MISSING_VALUE);
  // Thousands separators; a six-figure price still fits its column.
  expect(formatScreenValue("price", 757_398)).toBe("757,398.00");
  expect(formatScreenValue("price", 757_398).length).toBeLessThanOrEqual(columnWidth("price"));
  expect(formatScreenValue("trailingPE", -1_234.56)).toBe("-1,234.6");
  // A multiple the server marks not meaningful reads N/M, as RV and valuation print it; one merely missing stays --.
  expect(formatScreenMetric("enterpriseToRevenue", { value: null, notMeaningful: true })).toBe("N/M");
  expect(formatScreenMetric("enterpriseToRevenue", { value: null })).toBe(MISSING_VALUE);
});

test("undated provider values show their collection date, never an invented source date", () => {
  const base = payload().rows[0]!.metrics.trailingPE;
  expect(metricDate({ ...base, asOf: "2026-08-31", observedAt: "2026-09-22T12:00:00Z" })).toEqual({ text: "2026-08-31", collected: false });
  expect(metricDate({ ...base, value: 10, asOf: null, observedAt: "2026-09-22T12:00:00Z" })).toEqual({ text: "2026-09-22", collected: true });
  expect(metricDate({ ...base, value: null, asOf: null, observedAt: null })).toEqual({ text: MISSING_VALUE, collected: false });
});

test("a dividend yield names its own row's basis, and none the server did not state", () => {
  const base = { ...payload().rows[0]!.metrics.trailingPE, value: 3.2, unit: "%" };
  const basis = (reason: string) => dividendYieldBasis({ ...base, reason });
  expect(basis("forward yield; provider observation date unavailable")).toBe("latest distribution annualized");
  expect(basis("trailing yield; provider observation date unavailable")).toBe("last 12 months of distributions");
  expect(basis("Unspecified yield; provider observation date unavailable")).toBeNull();
});

test("result columns lead with the focus metric and the screen's criteria; money needs a currency", () => {
  const definition = parseScreenDefinition({
    version: 1,
    currency: "USD",
    criteria: [{ field: "operatingMarginPercent", op: "gte", value: 20 }, { field: "sector", op: "in", value: ["Technology"] }],
    sort: { field: "trailingPE", direction: "asc" },
  });
  expect(resultFields(definition, "trailingPE").slice(0, 3)).toEqual(["trailingPE", "operatingMarginPercent", "marketCap"]);
  expect(resultFields({ ...definition, currency: null }, "trailingPE")).not.toContain("price");
});

test("social and research fields format by kind, and an older server's rows still load", () => {
  expect([formatScreenValue("xPostsPerDay", 77), formatScreenValue("wikiViewsPerDay", 5_916), formatScreenValue("xPostsVsMedian", 2.46)])
    .toEqual(["77", formatScreenValue("volume", 5_916), "2.5x"]);
  expect([formatScreenValue("return1YPercent", 32.51), formatScreenValue("fromHigh52WPercent", -1.98), formatScreenValue("priceToBook", 45.93),
    formatScreenValue("beta", 1.052), formatScreenValue("ivRank", 46.89)])
    .toEqual(["+32.5", "-2.0", "45.9x", "1.05", "47"]);
  const older = payload();
  for (const row of older.rows) for (const field of [...SOCIAL_FIELDS, ...RESEARCH_FIELDS, ...VOLATILITY_FIELDS, ...DIVIDEND_FIELDS, ...TECHNICAL_FIELDS, ...OPTION_VOLATILITY_FIELDS, ...OWNERSHIP_FIELDS, ...QUALITY_FIELDS, ...SCORE_FIELDS])
    delete (row.metrics as Partial<typeof row.metrics>)[field];
  const loaded = validateScreenPayload(older);
  expect(loaded.rows[0]!.metrics.xPostsVsMedian).toMatchObject({ value: null, state: "unavailable" });
  expect(loaded.rows[0]!.metrics.atrPercent).toMatchObject({ value: null, state: "unavailable" });
  expect(loaded.rows[0]!.metrics.ivPercentile).toMatchObject({ value: null, state: "unavailable" });
  expect(loaded.rows[0]!.metrics.floatShares).toMatchObject({ value: null, state: "unavailable" });
  expect(loaded.rows[0]!.metrics.roicPercent).toMatchObject({ value: null, state: "unavailable" });
  expect(loaded.rows[0]!.metrics.piotroskiFScore).toMatchObject({ value: null, state: "unavailable" });
  expect(loaded.rows[0]!.metrics.roePercent).toMatchObject({ value: null, state: "unavailable" });
  expect(loaded.rows[0]!.metrics.payoutRatioPercent).toMatchObject({ value: null, state: "unavailable" });
  expect(loaded.rows[0]!.metrics.goldenCrossDays).toMatchObject({ value: null, state: "unavailable" });
  const broken = payload();
  delete (broken.rows[0]!.metrics as Partial<typeof broken.rows[0]["metrics"]>).price;
  expect(() => validateScreenPayload(broken)).toThrow("price");
});

test("ATR% is a one-decimal percent with no sign or sign colour, and works as a criterion, sort and column", () => {
  expect([3.456, 12, 0.04, null].map((value) => formatScreenValue("atrPercent", value))).toEqual(["3.5", "12.0", "0.0", MISSING_VALUE]);
  expect(SIGN_COLORED.has("atrPercent")).toBe(false);
  expect([SHORT_LABELS.atrPercent, screenLabel("atrPercent")]).toEqual(["ATR%", "ATR%"]);
  expect(columnWidth("atrPercent")).toBe(8);
  const atr = { id: "atrPercent" as const, label: "ATR%", kind: "number" as const, unit: "%", description: "",
    operators: ["gte", "lte", "between", "present", "missing"] as ("gte" | "lte" | "between" | "present" | "missing")[] };
  expect(parseCriterion(atr, "gte", "3.5")).toEqual({ field: "atrPercent", op: "gte", value: 3.5 });
  expect(parseCriterion(atr, "between", "2, 8")).toEqual({ field: "atrPercent", op: "between", value: [2, 8] });
  expect(parseCriterion(atr, "missing", "")).toEqual({ field: "atrPercent", op: "missing" });
  expect(criterionText({ field: "atrPercent", op: "gte", value: 3.5 })).toBe("ATR% >= 3.5");
  const screen = parseScreenDefinition({
    ...DEFAULT_SCREEN,
    criteria: [...DEFAULT_SCREEN.criteria, { field: "atrPercent", op: "gte", value: 3 }],
    sort: { field: "atrPercent", direction: "desc" },
  });
  expect(resultFields(screen, "atrPercent").slice(0, 3)).toEqual(["atrPercent", "marketCap", "price"]);
  // The field the rows are sorted by comes right after the focus metric, so their order reads from a column.
  expect(resultFields(screen, "trailingPE").slice(0, 3)).toEqual(["trailingPE", "atrPercent", "marketCap"]);
  expect(resultFields(screen, "trailingPE", ["beta"]).slice(0, 3)).toEqual(["trailingPE", "beta", "atrPercent"]);
});

test("the field list is requested with the volatility group, which servers without it ignore", async () => {
  const ask = spyOn(apiClient, "equityScreener").mockResolvedValue({
    version: 1,
    fields: [{ id: "atrPercent", label: "ATR%", kind: "number", unit: "%", operators: ["gte"], description: "" }],
    limits: { criteria: 20, pageSize: 200, exportRows: 5000, savedScreens: 50 },
    cadenceSeconds: 900,
  } as never);
  try {
    const data = await fetchScreenFields();
    expect(String(ask.mock.calls[0]![0])).toMatch(/^fields\?include=.*\bvolatility\b.*\bdividends\b.*\btechnical\b.*\bgrades\b/);
    expect(data.fields.map((entry) => entry.id)).toEqual(["atrPercent"]);
  } finally {
    ask.mockRestore();
  }
});

test("YTD's header names the prior year's last close the returns start from", () => {
  const base = payload().rows[0]!;
  const row = (asOf: string) => ({ ...base, metrics: { ...base.metrics,
    returnYtdPercent: { ...base.metrics.returnYtdPercent, value: 13.27, asOf, state: "available" as const } } });
  const now = Date.parse("2026-10-20T17:00:00Z");
  expect(screenYtdBase([row("2026-10-19")], null, now)).toBe("31 Dec");
  // A row still on the year's first session reads from the close before it.
  expect(screenYtdBase([row("2026-01-02")], null, now)).toBe("31 Dec");
  // No row with YTD: the snapshot's day.
  expect(screenYtdBase([], "2026-10-20T16:30:00Z", now)).toBe("31 Dec");
  expect(screenYtdBase([], null, now)).toBeNull();
  expect(screenColumnLabel("returnYtdPercent", "31 Dec", "report")).toBe("YTD% vs 31 Dec close");
  expect(screenColumnLabel("returnYtdPercent", "31 Dec")).toBe("YTD% vs 31 Dec");
  expect(screenColumnLabel("returnYtdPercent", "31 Dec", "compact")).toBe("YTD% 31 Dec");
  expect(screenColumnLabel("returnYtdPercent", null)).toBe(SHORT_LABELS.returnYtdPercent);
  expect(screenColumnLabel("trailingPE", "31 Dec", "report")).toBe(SHORT_LABELS.trailingPE);
});

test("technical fields: RSI and the width percentile without a sign, distances from the averages signed, days since as whole sessions", () => {
  expect([formatScreenValue("rsi14", 28.44), formatScreenValue("bollingerWidthPercentile", 3.2), formatScreenValue("priceVsSma200Percent", 4.06),
    formatScreenValue("priceVsSma50Percent", -2.31), formatScreenValue("goldenCrossDays", 0), formatScreenValue("newHigh52wDays", 7)])
    .toEqual(["28.4", "3", "+4.1", "-2.3", "0", "7"]);
  expect([SIGN_COLORED.has("priceVsSma20Percent"), SIGN_COLORED.has("rsi14"), SIGN_COLORED.has("macdBullishCrossDays")]).toEqual([true, false, false]);
  for (const field of TECHNICAL_FIELDS) expect(SHORT_LABELS[field].length).toBeLessThanOrEqual(13);
  expect(screenLabel("goldenCrossDays")).toBe("Days since golden cross");
});

test("option volatility fields: IV30 and HV20 in percent, percentile and rank whole, IV changes signed vol points", () => {
  expect([formatScreenValue("iv30Percent", 28.04), formatScreenValue("ivPercentile", 91.4), formatScreenValue("iv30Change1d", 2.26),
    formatScreenValue("iv30Change5d", -0.81), formatScreenValue("hv20Percent", 19.97), formatScreenValue("hvRank", 33.3)])
    .toEqual(["28.0", "91", "+2.3", "-0.8", "20.0", "33"]);
  expect(SIGN_COLORED.has("iv30Change1d")).toBe(false);
  for (const field of OPTION_VOLATILITY_FIELDS) expect(SHORT_LABELS[field].length).toBeLessThanOrEqual(13);
});

test("ownership fields: share counts compact, short % of float and institutional ownership one decimal", () => {
  expect([formatScreenValue("sharesOutstanding", 504_500_990), formatScreenValue("floatShares", 461_240_000),
    formatScreenValue("shortPercentOfFloat", 10.637), formatScreenValue("institutionalOwnershipPercent", 125.4)])
    .toEqual(["504.50M", "461.24M", "10.6", "125.4"]);
  for (const field of OWNERSHIP_FIELDS) expect(SHORT_LABELS[field].length).toBeLessThanOrEqual(13);
});

test("quality fields: leverage as multiples, growth signed like the growth fields, returns unsigned like margins, N/M as FA prints it", () => {
  expect([formatScreenValue("netDebtToEbitda", 0.1307), formatScreenValue("netDebtToEbitda", -0.124), formatScreenValue("debtToEquity", 0.784),
    formatScreenValue("roicPercent", 71.27), formatScreenValue("fcfYieldPercent", 3.28), formatScreenValue("fcfYieldPercent", -2.04), formatScreenValue("revenueCagr5YPercent", 8.677),
    formatScreenValue("epsCagr3YPercent", 0.01), formatScreenValue("forwardEpsGrowthPercent", 95.23), formatScreenValue("revenueGrowthPercent", 8.677)])
    .toEqual(["0.1x", "-0.1x", "0.8x", "71.3", "3.3", "-2.0", "+8.7", "0.0", "+95.2", "+8.7"]);
  // A value FA calls not meaningful, kept apart from a missing one.
  expect(formatScreenMetric("netDebtToEbitda", { value: null, notMeaningful: true })).toBe("N/M");
  expect(formatScreenMetric("netDebtToEbitda", { value: null })).toBe(MISSING_VALUE);
  // Growth, not a move: no sign colour, like FY REV GR%.
  for (const field of QUALITY_FIELDS) {
    expect(SIGN_COLORED.has(field)).toBe(false);
    expect(SHORT_LABELS[field].length).toBeLessThanOrEqual(13);
  }
});

test("score fields: whole scores and ranks, Z and fair values to the cent, upside signed and coloured, membership Yes or No", () => {
  expect([formatScreenValue("piotroskiFScore", 8), formatScreenValue("magicFormulaRank", 1234), formatScreenValue("rsRating", 99),
    formatScreenValue("altmanZScore", 13.784), formatScreenValue("grahamNumber", 37.9), formatScreenValue("grahamUpsidePercent", -89.18),
    formatScreenValue("lynchUpsidePercent", 20.04), formatScreenValue("earningsYieldPercent", 2.954), formatScreenValue("totalReturn1YPercent", 29.9),
    formatScreenValue("profitableYears", 19), formatScreenValue("sp500Member", 1), formatScreenValue("dowMember", 0)])
    .toEqual(["8", "1,234", "99", "13.78", "37.90", "-89.2", "+20.0", "3.0", "+29.9", "19", "Yes", "No"]);
  expect(formatScreenMetric("altmanZScore", { value: null, notMeaningful: true })).toBe("N/M");
  for (const field of ["grahamUpsidePercent", "lynchUpsidePercent", "totalReturn1YPercent"] as const) expect(SIGN_COLORED.has(field)).toBe(true);
  for (const field of SCORE_FIELDS) expect(SHORT_LABELS[field].length).toBeLessThanOrEqual(13);
  // Membership is 1 or 0: equal, there or not.
  expect(criterionText({ field: "sp500Member", op: "eq", value: 1 })).toBe("S&P 500 member = yes");
  const membership = { version: 1, currency: "USD", criteria: [{ field: "dowMember", op: "gte", value: 1 }], sort: { field: "marketCap", direction: "desc" } };
  expect(() => parseScreenDefinition(membership)).toThrow();
  expect(parseScreenDefinition({ ...membership, criteria: [{ field: "dowMember", op: "eq", value: 1 }] }).criteria).toHaveLength(1);
});

test("grades print as letters and the composite with its label, in one sign colour scale, and work as criteria", () => {
  expect([1, 4, 5, 7, 8, 10, 13].map((value) => formatScreenValue("valueGrade", value))).toEqual(["F", "D+", "C-", "C+", "B-", "B+", "A+"]);
  // A value off the scale is not a grade.
  expect([formatScreenValue("growthGrade", 0), formatScreenValue("growthGrade", 7.5), formatScreenValue("momentumGrade", null)]).toEqual([MISSING_VALUE, MISSING_VALUE, MISSING_VALUE]);
  expect([4.72, 4.5, 3.5, 3.49, 2.5, 1.5, 1.49, 1].map((value) => formatScreenValue("gradeComposite", value)))
    .toEqual(["4.72 Top", "4.50 Top", "3.50 Strong", "3.49 Neutral", "2.50 Neutral", "1.50 Weak", "1.49 Bottom", "1.00 Bottom"]);
  expect(screenDetailValue("profitabilityGrade", { value: 12, unit: "1-13" })).toBe("A");
  expect(screenDetailValue("gradeComposite", { value: 2.79, unit: "1-5" })).toBe("2.79 Neutral");
  expect(screenDetailValue("revenueRevision30dPercent", { value: 1.24, unit: "%" })).toBe("+1.2 %");
  // A missing value is just "--"; N/M says so; a count of one is singular.
  expect(screenDetailValue("returnOnCapitalPercent", { value: null, unit: "%" })).toBe(MISSING_VALUE);
  expect(screenDetailValue("magicFormulaRank", { value: null, unit: "rank" })).toBe(MISSING_VALUE);
  expect(screenDetailValue("altmanZScore", { value: null, unit: "", notMeaningful: true })).toBe("N/M");
  expect([1, 2].map((value) => screenDetailValue("dividendGrowthYears", { value, unit: "years" }))).toEqual(["1 year", "2 years"]);
  // The note on another line of the company is split from what is the grade's own.
  const note = "One company with GOOGL:NASDAQ, its primary line: graded once, on that line's figures.";
  expect(splitGradeReason(`${note} Revenue revision 30D ranked against every company: Communication Services has under 20 with it.`)).toEqual({
    company: note,
    own: "Revenue revision 30D ranked against every company: Communication Services has under 20 with it.",
  });
  expect(splitGradeReason(note)).toEqual({ company: note, own: null });
  expect(splitGradeReason("Reads stale figures: 3M return as of 2026-10-31.")).toEqual({ company: null, own: "Reads stale figures: 3M return as of 2026-10-31." });
  expect(splitGradeReason(null)).toEqual({ company: null, own: null });
  expect(gradeRankText({ source: "B+: 82nd percentile among 412 Technology companies, from P/E 18.4 (61st pctl) and P/B 2.1 (70th pctl)" }))
    .toBe("82nd percentile among 412 Technology companies, from P/E 18.4 (61st pctl) and P/B 2.1 (70th pctl)");
  expect(gradeRankText({ source: "Neutral: 46th percentile among 4,007 companies, from the mean of the five grades' percentiles, 49" }))
    .toBe("46th percentile among 4,007 companies, from the mean of the five grades' percentiles, 49");
  // B- and up read positive, D+ and down negative, the C band neutral; the composite by its label.
  expect([1, 4, 5, 7, 8, 13].map((value) => screenSignValue("revisionsGrade", value))).toEqual([-1, -1, 0, 0, 1, 1]);
  expect([4.8, 3.5, 3, 2.49, 1].map((value) => screenSignValue("gradeComposite", value))).toEqual([1, 1, 0, -1, -1]);
  expect([screenSignValue("changePercent", -2), screenSignValue("changePercent", 0.01), screenSignValue("trailingPE", 20)]).toEqual([-2, 0, null]);
  for (const field of ["nextYearEpsRevision30dPercent", "revenueRevision30dPercent"] as const) expect(SIGN_COLORED.has(field)).toBe(true);
  for (const field of GRADE_FIELDS) expect(SHORT_LABELS[field].length).toBeLessThanOrEqual(13);
  expect(columnWidth("gradeComposite")).toBeGreaterThanOrEqual("4.72 Neutral".length);

  // A grade is typed and read as its letter; a number still works.
  const grade: ScreenFieldDefinition = { id: "valueGrade", label: "Value grade", kind: "number", unit: "1-13", description: "", operators: ["gte", "between", "present"] };
  expect(parseCriterion(grade, "gte", "b+")).toEqual({ field: "valueGrade", op: "gte", value: 10 });
  expect(parseCriterion(grade, "between", "B, A+")).toEqual({ field: "valueGrade", op: "between", value: [9, 13] });
  expect(parseCriterion(grade, "gte", "11")).toEqual({ field: "valueGrade", op: "gte", value: 11 });
  expect(() => parseCriterion(grade, "gte", "E")).toThrow("Enter a grade from F to A+, such as B+.");
  expect(criterionText({ field: "valueGrade", op: "gte", value: 10 })).toBe("Value grade >= B+");
  expect(criterionText({ field: "momentumGrade", op: "between", value: [9, 13] })).toBe("Momentum grade between B, A+");
  expect(criterionInputText({ field: "valueGrade", op: "between", value: [9, 13] })).toBe("B, A+");
  expect(criterionValueLabel(grade)).toBe("Value (F to A+)");
  // The composite takes a score or its label, and names the label a threshold starts.
  const composite: ScreenFieldDefinition = { ...grade, id: "gradeComposite", label: "Grade composite", unit: "1-5" };
  expect(parseCriterion(composite, "gte", "Strong")).toEqual({ field: "gradeComposite", op: "gte", value: 3.5 });
  expect(parseCriterion(composite, "gte", "4.2")).toEqual({ field: "gradeComposite", op: "gte", value: 4.2 });
  expect(criterionText({ field: "gradeComposite", op: "gte", value: 4.5 })).toBe("Grade composite >= 4.5 (Top)");
  expect(criterionText({ field: "gradeComposite", op: "gte", value: 4.2 })).toBe("Grade composite >= 4.2");
  expect(criterionValueLabel(composite)).toBe("Value (1-5)");
  // An older server's rows, without the grades, still load with them unavailable.
  const older = payload();
  for (const row of older.rows) for (const field of GRADE_FIELDS) delete (row.metrics as Partial<typeof row.metrics>)[field];
  const loaded = validateScreenPayload(older);
  for (const field of [...LETTER_GRADE_FIELDS, "gradeComposite"] as const) expect(loaded.rows[0]!.metrics[field]).toMatchObject({ value: null, state: "unavailable" });
});

test("a P/E header or metric starts cheapest first, any other largest first, and a second press flips it", () => {
  const byCap = { field: "marketCap", direction: "desc" } as const;
  for (const field of ["trailingPE", "forwardPE", "priceToBook", "enterpriseToRevenue", "evToEbitda"]) {
    expect(pressedScreenSort(byCap, field), field).toEqual({ field, direction: "asc" });
    expect(firstScreenSortDirection(field), field).toBe("asc");
  }
  expect(pressedScreenSort({ field: "trailingPE", direction: "desc" }, "marketCap")).toEqual({ field: "marketCap", direction: "desc" });
  expect(pressedScreenSort({ field: "trailingPE", direction: "asc" }, "trailingPE")).toEqual({ field: "trailingPE", direction: "desc" });
  expect(pressedScreenSort({ field: "trailingPE", direction: "desc" }, "trailingPE")).toEqual({ field: "trailingPE", direction: "asc" });
  expect(firstScreenSortDirection("dividendYieldPercent")).toBe("desc");
});

test("a symbol list takes a watchlist's name or up to 500 symbols; other categories stay at 25", () => {
  const symbol: ScreenFieldDefinition = { id: "symbol", label: "Symbol", kind: "category", unit: "", description: "", operators: ["in"] };
  const sector: ScreenFieldDefinition = { ...symbol, id: "sector", label: "Sector" };
  const names = (count: number) => Array.from({ length: count }, (_, index) => `S${index}`);
  expect(parseCriterion(symbol, "in", names(500).join(","))).toMatchObject({ field: "symbol", value: names(500) });
  expect(() => parseCriterion(symbol, "in", names(501).join(","))).toThrow("Enter a watchlist name or 1-500 comma-separated symbols");
  expect(() => parseCriterion(sector, "in", names(26).join(","))).toThrow("Enter 1-25 comma-separated values");
  // One typed name that is a watchlist reads as its symbols; one that is not stays a symbol.
  const readWatchlist = (typed: string) => (typed.toLowerCase() === "hy3" ? { symbols: ["NFE", "CZR", "RIG"] } : null);
  expect(parseCriterion(symbol, "in", "HY3", readWatchlist)).toMatchObject({ value: ["NFE", "CZR", "RIG"] });
  expect(parseCriterion(symbol, "in", "AAPL", readWatchlist)).toMatchObject({ value: ["AAPL"] });
  expect(parseCriterion(sector, "in", "HY3", readWatchlist)).toMatchObject({ value: ["HY3"] });
  expect(parseScreenDefinition({ ...DEFAULT_SCREEN, criteria: [{ field: "symbol", op: "in", value: names(500) }] }).criteria).toHaveLength(1);
  expect(() => parseScreenDefinition({ ...DEFAULT_SCREEN, criteria: [{ field: "sector", op: "in", value: names(26) }] })).toThrow();
  // A watchlist's members keep their venues, once each, so the server matches each by company.
  expect(screenListings([{ ticker: "SAP:XETRA" }, { ticker: "SAP:XETRA", exchange: "XETRA" }, { ticker: "BN", exchange: "NYSE" }, { ticker: "NFE" }]))
    .toEqual(["SAP:XETRA", "BN:NYSE", "NFE"]);
  expect(criterionText({ field: "symbol", op: "in", value: names(300) })).toBe("Symbol in S0, S1, S2, S3, S4, S5, S6, S7 and 292 more");
});
