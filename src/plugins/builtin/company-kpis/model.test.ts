import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { cachedCompanyData, companyKpisCache, fetchCompanyData, loadCompanyData, validateCompanyData } from "./client";
import { getTableWidth } from "../../../components/ui/table-layout";
import { allObservations, changeText, changeTone, companyColumns, companyEmptyState, directionLabel, directionTone, fiscalLabel, fitCompanyColumns, guidanceSeries, kpiPeriodView, kpiPeriodViews, observationChange, observationChart, outcomeLabel, rangeText, observationValue, guideGroupKey, seriesDetail, seriesName,
  seriesOrder, guidanceIssueNote } from "./model";
import { guide, guidancePayload, kpisPayload, observation } from "./test-fixture";
import { NOT_MEANINGFUL_TONE } from "../../../utils/growth";

afterEach(() => { setCloudApiFetchTransport(null); companyKpisCache.reset(); });
test("a newer outlook for another metric dates an older guide without claiming it was replaced", () => {
  const older = guide({ issuedDate: "2026-05-20" });
  const newer = guide({ id: "guide:newer", issuedDate: "2026-08-19", metric: { ...older.metric, id: "revenue", name: "Revenue" } });
  expect(guidanceIssueNote(older, [older])).toBeNull();
  expect(guidanceIssueNote(older, [newer, older])).toBe("Issued 20 May 2026; newer outlook 19 Aug 2026");
  expect(guidanceIssueNote(newer, [older, newer])).toBeNull();
});
test("runtime boundary rejects nonfinite values, inverted ranges, unsafe evidence and mismatched series", () => {
  for (const overrides of [{ value: NaN }, { currency: null }, { confidence: 2 }, { evidence: [{ ...observation().evidence[0]!, url: "javascript:alert(1)" }] }, { period: { ...observation().period, start: "2026-12-31" } }]) {
    const data = kpisPayload(); data.series[0]!.observations = [observation(overrides)];
    expect(() => validateCompanyData(data)).toThrow("unreadable");
  }
  const mismatched = kpisPayload(); mismatched.series[0]!.key = "different";
  expect(() => validateCompanyData(mismatched)).toThrow("unreadable");
  expect(() => validateCompanyData(guidancePayload({ guidance: [guide({ low: 20, high: 10 })] }))).toThrow("unreadable");
  const fiscalOnly = observation({ period: { ...observation().period, start: null, end: null } });
  expect(validateCompanyData(kpisPayload({ revisions: [fiscalOnly] })).revisions[0]?.period.end).toBeNull();
});

test("changes preserve frequency, currency, basis, zero denominators and percentage points", () => {
  const current = observation();
  const previous = observation({ id: "previous", value: 100_000_000, period: { ...current.period, start: "2026-01-01", end: "2026-03-31", fiscalQuarter: 1 } });
  expect(observationChange(current, [previous]).value).toBe(25);
  expect(observationChange(current, [{ ...previous, seriesKey: "arr:adjusted:USD" }]).value).toBeNull();
  expect(observationChange(current, [{ ...previous, period: { ...previous.period, kind: "year" } }]).value).toBeNull();
  expect(observationChange(current, [{ ...previous, conflict: true }]).value).toBeNull();
  expect(observationChange(current, [{ ...previous, value: 0 }]).value).toBeNull();
  expect(observationChange({ ...current, value: 12, unit: "percent" }, [{ ...previous, value: 10, unit: "percent" }])).toEqual({ value: 2, unit: "pp" });
  // Off a zero or negative base the change is not meaningful, and reads so.
  expect(changeText(observationChange(current, [{ ...previous, value: 0 }]))).toBe("N/M");
  const fromLoss = observationChange(current, [{ ...previous, value: -40_000_000 }]);
  expect(fromLoss).toEqual({ value: null, unit: "%", notMeaningful: true });
  expect(changeText(fromLoss)).toBe("N/M");
  // Drawn as every pane draws N/M: the text's tone, never muted, good or bad.
  expect(changeTone(current, fromLoss.value, fromLoss.notMeaningful)).toBe(NOT_MEANINGFUL_TONE);
  expect(changeTone(current, null)).toBe("muted");
  // A rate's change in points stays a number across zero.
  expect(observationChange({ ...current, value: 2, unit: "percent" }, [{ ...previous, value: -1, unit: "percent" }])).toEqual({ value: 3, unit: "pp" });
  // Only the period just before counts: with the two quarters between missing, Q3 FY2025 is no prior change for Q2 FY2026.
  const older = { ...previous, period: { ...previous.period, start: "2025-07-01", end: "2025-09-30", fiscalYear: 2025, fiscalQuarter: 3 } };
  expect(observationChange(current, [older]).value).toBeNull();
  expect(observationChange(current, [older, previous]).value).toBe(25);
  const fiscalOnly = (item: typeof current) => ({ ...item, period: { ...item.period, start: null, end: null } });
  expect(observationChange(fiscalOnly(current), [fiscalOnly(older)]).value).toBeNull();
  expect(observationChange(fiscalOnly(current), [fiscalOnly(previous)]).value).toBe(25);
  const year = (fiscalYear: number, value: number) => observation({ id: `fy${fiscalYear}`, value, period: { start: `${fiscalYear}-01-01`, end: `${fiscalYear}-12-31`, kind: "year", fiscalYear, fiscalQuarter: null, label: `FY${fiscalYear}` } });
  expect(observationChange(year(2025, 120), [year(2024, 100)]).value).toBe(20);
  expect(observationChange(year(2025, 120), [year(2023, 100)]).value).toBeNull();
});

test("a year to date is set against the same window a year earlier, never the same year's half", () => {
  const ytd = (id: string, start: string | null, end: string | null, fiscalYear: number, value: number, fiscalQuarter: number | null = null) =>
    observation({ id, value, period: { start, end, kind: "ytd", fiscalYear, fiscalQuarter, label: id } });
  const nine2026 = ytd("9m-2026", "2026-01-01", "2026-09-30", 2026, 218_851);
  const six2026 = ytd("6m-2026", "2026-01-01", "2026-06-30", 2026, 143_300);
  const nine2025 = ytd("9m-2025", "2025-01-01", "2025-09-30", 2025, 216_900);
  // An insurer's nine months beside its half of the same year: no change, rather than +52.73%.
  expect(observationChange(nine2026, [six2026]).value).toBeNull();
  // With the nine months a year earlier stated too, that is the prior, whatever else stands between.
  expect(observationChange(nine2026, [six2026, nine2025]).value).toBeCloseTo(0.899, 2);
  // The half a year earlier compares with its own half, as before.
  expect(observationChange(six2026, [ytd("6m-2025", "2025-01-01", "2025-06-30", 2025, 126_600), nine2025]).value).toBeCloseTo(13.19, 1);
  // A window of another length ending a year earlier (a fiscal year starting elsewhere) is not the same window.
  expect(observationChange(nine2026, [ytd("other", "2024-10-01", "2025-09-30", 2025, 200_000)]).value).toBeNull();
  // Undated: the same fiscal quarter a year earlier, not the quarter before.
  const undated = (item: ReturnType<typeof ytd>, fiscalQuarter: number) => ({ ...item, period: { ...item.period, start: null, end: null, fiscalQuarter } });
  expect(observationChange(undated(nine2026, 3), [undated(six2026, 2)]).value).toBeNull();
  expect(observationChange(undated(nine2026, 3), [undated(six2026, 2), undated(nine2025, 3)]).value).toBeCloseTo(0.899, 2);
  // An end with no start still pairs with the same end a year earlier.
  expect(observationChange(ytd("9m-open", null, "2026-09-30", 2026, 218_851), [ytd("9m-open-2025", null, "2025-09-30", 2025, 216_900), six2026]).value).toBeCloseTo(0.899, 2);
});

test("a balance is set against the balance before it; a period of an unknown window against none", () => {
  const at = (id: string, end: string, value: number) => observation({ id, value, period: { start: null, end, kind: "instant", fiscalYear: Number(end.slice(0, 4)), fiscalQuarter: null, label: end } });
  expect(observationChange(at("jun-2026", "2026-06-30", 83_402), [at("dec-2025", "2025-12-31", 79_678), at("jun-2025", "2025-06-30", 73_670)]).value).toBeCloseTo(4.67, 2);
  const other = (id: string, end: string, value: number) => observation({ id, value, period: { start: null, end, kind: "other", fiscalYear: Number(end.slice(0, 4)), fiscalQuarter: null, label: id } });
  expect(observationChange(other("final dividend", "2026-06-30", 120), [other("interim dividend", "2025-12-31", 100)]).value).toBeNull();
});

test("chart projection excludes conflicts, revisions and missing dates without combining fiscal frequencies", () => {
  const rows = ["2025-12-31", "2026-03-31", "2026-06-30"].map((end, i) => observation({ id: `row:${i}`, period: { ...observation().period, start: null, end }, value: 100 + i }));
  expect(observationChart(rows, "#fff").series[0]?.points.map((point) => point.value)).toEqual([100, 101, 102]);
  expect(observationChart([...rows.slice(0, 2), { ...rows[2]!, conflict: true }], "#fff").series[0]?.points).toHaveLength(2);
  expect(observationChart([...rows.slice(0, 2), { ...rows[2]!, current: false }], "#fff").series[0]?.points).toHaveLength(2);
  expect(observationChart([...rows.slice(0, 2), { ...rows[2]!, period: { ...rows[2]!.period, end: null, fiscalQuarter: null } }], "#fff").series[0]?.points).toHaveLength(2);
  const data = kpisPayload(); data.revisions = [data.series[0]!.latest];
  expect(allObservations(data)).toHaveLength(1);
});

test("guidance keeps one-sided and withdrawn semantics and economic outcome separate from numeric direction", () => {
  expect(rangeText(guide({ low: 100, high: null, hedge: "greater_than" }))).toBe("> 100");
  expect(rangeText(guide({ low: null, high: 100, hedge: "at_most" }))).toBe("≤ 100");
  expect(rangeText(guide({ status: "withdrawn" }))).toBe("Withdrawn");
  expect(outcomeLabel(guide({ direction: "cut", actual: { ...guide().actual!, favorable: "beat", outcome: "below" } }))).toBe("Beat");
  const rows = ["2026-01-01", "2026-02-01", "2026-03-01"].map((issuedDate, i) => guide({ id: `guide:${i}`, issuedDate, low: 90 + i, high: 100 + i }));
  expect(guidanceSeries(rows.slice(0, 2), rows[1], { low: "#aaa", high: "#fff", actual: "#0f0" })).toHaveLength(3);
  expect(guidanceSeries(rows, rows[2], { low: "#aaa", high: "#fff", actual: "#0f0" }).map((series) => series.label)).toEqual(["Guide low", "Guide high", "Later actual"]);
  expect(guidanceSeries(rows.map((row, i) => ({ ...row, period: { ...row.period, end: `2026-0${i + 1}-28` } })), rows[2], { low: "#aaa", high: "#fff", actual: "#0f0" })).toHaveLength(0);
});

test("paid caches are isolated across account, entitlement and function; access revocation clears stale access", async () => {
  companyKpisCache.attach(new MemoryPluginPersistence());
  setCloudApiFetchTransport(async () => Response.json(kpisPayload()));
  await loadCompanyData("kpis", "EXAMPLE:LSE", "alice:full");
  expect(cachedCompanyData("kpis", "EXAMPLE:LSE", "alice:preview")).toBeNull();
  expect(cachedCompanyData("kpis", "EXAMPLE:LSE", "bob:full")).toBeNull();
  expect(cachedCompanyData("guidance", "EXAMPLE:LSE", "alice:full")).toBeNull();
  setCloudApiFetchTransport(async () => Response.json({ error: "Forbidden" }, { status: 403 }));
  await expect(loadCompanyData("kpis", "EXAMPLE:LSE", "alice:full", true)).rejects.toThrow();
  await expect(fetchCompanyData("kpis", "EXAMPLE", {}, { getCloudCompanyKpis: async () => { throw new ApiRequestError("unavailable", 503); }, getCloudCompanyGuidance: async () => guidancePayload() })).rejects.toThrow("not available yet");
});

test("a listing abroad and its US namesake never share a request or a cache entry", async () => {
  companyKpisCache.attach(new MemoryPluginPersistence());
  const requested: string[] = [];
  setCloudApiFetchTransport(async (input) => {
    const url = new URL(input, "https://example.test");
    requested.push(`${url.pathname}${url.search}`);
    // Answered under the bare symbol it was asked about; the venue tells the two companies apart.
    return Response.json(kpisPayload({ symbol: "AI", methodology: url.searchParams.get("exchange") ? "Air Liquide" : "C3.ai" }));
  });
  const paris = { exchange: "XPAR", name: "Air Liquide S.A." };
  const [abroad, us] = await Promise.all([loadCompanyData("kpis", "AI", "alice:full", false, paris), loadCompanyData("kpis", "AI", "alice:full")]);
  expect([abroad.payload.methodology, us.payload.methodology]).toEqual(["Air Liquide", "C3.ai"]);
  expect(requested.sort()).toEqual(["/cloud/company-kpis/AI", "/cloud/company-kpis/AI?exchange=EPA&name=Air+Liquide+S.A."]);
  expect(cachedCompanyData("kpis", "AI:EPA", "alice:full", { name: "Air Liquide S.A." })?.payload.methodology).toBe("Air Liquide");
  expect(cachedCompanyData("kpis", "AI", "alice:full")?.payload.methodology).toBe("C3.ai");
  expect(cachedCompanyData("kpis", "AI:XNYS", "alice:full")).toBeNull();
});


test("bounded values retain their signs and cannot become exact chart points, changes or unknown-period guide groups", () => {
  const bound = observation({ value: 600, unit: "count", currency: null, valueQualifier: "greater_than" });
  expect(observationValue(bound)).toBe("> 600");
  expect(observationChange(bound, [observation()]).value).toBeNull();
  expect(observationChart([bound, bound, bound], "#fff").series).toHaveLength(0);
  const unknown = guide({ period: { ...guide().period, start: null, end: null } });
  expect(guideGroupKey(unknown)).toBe(guideGroupKey({ ...unknown, period: { ...unknown.period, label: "Second fiscal quarter" } }));
  expect(guideGroupKey(unknown)).not.toBe(guideGroupKey({ ...unknown, period: { ...unknown.period, fiscalYear: 2027, label: "Q2 FY2027" } }));
});

test("unknown calendar ends use fiscal categories with source dates left null", () => {
  const rows = [1, 2, 3].map((fiscalQuarter) => observation({ id: `quarter:${fiscalQuarter}`, period: { ...observation().period, start: null, end: null, fiscalQuarter, label: `Q${fiscalQuarter} FY2026` } }));
  const chart = observationChart(rows, "#fff");
  expect(chart.series).toHaveLength(1);
  expect(chart.xAxis?.ticks?.map((tick) => tick.label)).toEqual(["Q1 FY2026", "Q2 FY2026", "Q3 FY2026"]);
  expect(chart.xAxis?.formatCursor?.(0.5)).toBe("Q2 FY2026");
  expect(rows.every((row) => row.period.end === null)).toBe(true);
  expect(observationChange(rows[2]!, rows).value).toBe(0);
});

test("a half is named by its fiscal year only when its end says which half; a balance and a year to date keep their year", () => {
  const period = (kind: "half" | "instant" | "ytd", end: string, fiscalYear: number, label: string) => ({ period: { start: null, end, kind, fiscalYear, fiscalQuarter: null, label } });
  expect(fiscalLabel(period("half", "2025-12-31", 2026, "six months ended 31 December 2025"))).toBe("H1 FY2026");
  expect(fiscalLabel(period("half", "2025-12-31", 2025, "six months ended 31 December 2025"))).toBe("H2 FY2025");
  // Tencent's first half and an Australian company's second end on the same day.
  expect(fiscalLabel(period("half", "2026-06-30", 2026, "six months ended 30 June 2026"))).toBe("6M to Jun 2026");
  expect(fiscalLabel(period("instant", "2025-12-31", 2025, "At 31 Dec"))).toBe("31 Dec 2025");
  expect(fiscalLabel(period("ytd", "2026-09-30", 2026, "first nine months of 2026"))).toBe("YTD to Sep 2026");
});
test("the desktop names a series in plain words: its parts, a basis other than reported, then its qualifiers", () => {
  expect(seriesDetail(observation())).toBe("");
  expect(seriesName(observation({ dimensions: { platform: "Data Center" } }))).toBe("Annual recurring revenue · Data Center");
  expect(seriesDetail(observation({ dimensions: { segment: "Walmart U.S.", fuel: "excluded", comparison: "year_over_year" } }))).toBe("Walmart U.S. · excl. fuel · year over year");
  expect(seriesDetail(observation({ basis: "adjusted", dimensions: { dilution: "diluted" } }))).toBe("Adjusted · diluted");
  expect(seriesDetail(observation({ basis: "constant_currency", dimensions: { geography: "International", excludes: "acquisitions" } }))).toBe("International · Constant currency · excl. acquisitions");
  expect(seriesDetail(observation({ dimensions: { fx_excluded: "true", window: "trailing twelve months" } }))).toBe("excl. fx · trailing twelve months");
  // The server's series labels, not the fact's stored ones: NVDA's Data Center stored as a market platform.
  expect(seriesDetail(observation({ dimensions: { scope: "market platform", platform: "Data Center" }, seriesLabels: { segment: "Data Center" } }))).toBe("Data Center");
  expect(seriesDetail(observation({ dimensions: { type: "cash dividends paid" }, seriesLabels: {} }))).toBe("");
  // Its columns: the metric cell carries basis and scope.
  expect(companyColumns(false, false, false, false, true).map((column) => column.id)).toEqual(["metric", "period", "value", "change"]);
  expect(companyColumns(false, false, false).map((column) => column.id)).toEqual(["metric", "period", "value", "change", "basis", "scope"]);
});

test("series read by metric: the consolidated figure before its parts, reported before adjusted, a quarter before its year", () => {
  const quarter = observation().period;
  const year = { ...quarter, kind: "year" as const, fiscalQuarter: null, start: null, label: "FY2026" };
  const rows = [
    observation({ id: "segment-year", dimensions: { segment: "Cloud" }, period: year }),
    observation({ id: "adjusted", basis: "adjusted" }),
    observation({ id: "total-year", period: year }),
    observation({ id: "segment-quarter", dimensions: { segment: "Cloud" } }),
    observation({ id: "total-quarter" }),
    observation({ id: "other-metric", metric: { ...observation().metric, name: "Active customers" } }),
  ];
  expect([...rows].sort(seriesOrder).map((row) => row.id)).toEqual(["other-metric", "total-quarter", "total-year", "adjusted", "segment-quarter", "segment-year"]);
});

test("the Action column says what a guide did in plain words, and a guide with nothing to compare with is new", () => {
  const word = (direction: Parameters<typeof directionLabel>[0]["direction"], previousId: string | null = null) => directionLabel({ direction, previousId });
  expect(["raised", "cut", "reiterated", "mixed", "initiated", "withdrawn"].map((direction) => word(direction as never))).toEqual(["Raised", "Lowered", "Maintained", "Mixed", "New", "Withdrawn"]);
  // The service keeps the predecessor when it cannot rank the change (a new hedge or conditions): that guide changed.
  expect(word("not_comparable", "guide:previous")).toBe("Changed");
  // It drops it for another period: there is no earlier guide to set this one beside.
  expect(word("not_comparable")).toBe("New");
  // A New guide reads as one whichever way the service reached it; a Changed one as no news.
  expect(directionTone({ direction: "not_comparable", previousId: null })).toBe(directionTone({ direction: "initiated", previousId: null }));
  expect(directionTone({ direction: "not_comparable", previousId: "guide:previous" })).toBe("muted");
});

test("a guidance table fits its pane: the columns narrow, the metric keeps the rest, and only a column the detail repeats goes", () => {
  const fits = (columns: ReturnType<typeof fitCompanyColumns>, width: number) => getTableWidth(columns) <= width - 1;
  const tracker = companyColumns(true, false, false, false, true);
  const history = companyColumns(true, false, true, false, true);
  // 720px is 90 cells: Issued stays on the tracker, which is the column the pane cut off.
  const narrow = fitCompanyColumns(tracker, 90);
  expect(narrow.map((column) => column.id)).toEqual(["metric", "period", "value", "change", "issued"]);
  expect(fits(narrow, 90)).toBe(true);
  expect(narrow.find((column) => column.id === "metric")!.width).toBeGreaterThanOrEqual(14);
  // History has two more columns than a pane that narrow holds: the Action, which the outcome says, gives way.
  const narrowHistory = fitCompanyColumns(history, 90, true);
  expect(narrowHistory.map((column) => column.id)).toEqual(["metric", "period", "actual", "outcome", "value", "issued"]);
  expect(fits(narrowHistory, 90)).toBe(true);
  // A pane that holds the table as defined gets it as defined, and a narrow one drops Issued before the metric is squeezed.
  expect(fitCompanyColumns(tracker, 160)).toEqual(tracker);
  expect(fitCompanyColumns(tracker, 70).map((column) => column.id)).toEqual(["metric", "period", "value", "change"]);
  expect(fits(fitCompanyColumns(tracker, 70), 70)).toBe(true);
  for (const width of [46, 52, 60]) {
    for (const guidance of [true, false]) {
      for (const historical of [true, false]) {
        const columns = fitCompanyColumns(companyColumns(guidance, false, historical), width, historical);
        expect(fits(columns, width)).toBe(true);
        expect(columns.map((column) => column.id)).toContain("metric");
        expect(columns.map((column) => column.id)).toContain("value");
      }
    }
  }
});

test("an empty table says a company has nothing on file and names one that has, else what the selection lacks", () => {
  expect(companyEmptyState("guidance", "AAPL", { tab: "table", hasRows: false })).toEqual({ title: "Guidance for AAPL is not yet available.", hint: "Try GUIDE WMT." });
  expect(companyEmptyState("guidance", "AAPL", { tab: "table", hasRows: false }, "cli").hint).toBe("Try `fn GUIDE WMT`.");
  expect(companyEmptyState("kpis", "NFLX", { tab: "table", hasRows: false })).toEqual({ title: "No KPIs on file for NFLX yet." });
  // It never sends a company to itself.
  expect(companyEmptyState("guidance", "wmt", { tab: "table", hasRows: false }).hint).toBe("Try GUIDE DAL.");
  expect(companyEmptyState("guidance", "WMT", { tab: "history", hasRows: true })).toEqual({ title: "Actuals have not been matched to these guidance periods yet." });
  expect(companyEmptyState("kpis", "AAPL", { tab: "table", hasRows: true })).toEqual({ title: "No disclosed observations for this selection yet." });
});

test("the KPI table lists one kind of period at a time, quarters first, and names the change each kind is set against", () => {
  const quarter = observation();
  const year = observation({ id: "actual:fy", period: { start: "2025-07-01", end: "2026-06-30", kind: "year", fiscalYear: 2026, fiscalQuarter: null, label: "FY2026" } });
  const balance = observation({ id: "actual:at", period: { start: null, end: "2026-06-30", kind: "instant", fiscalYear: 2026, fiscalQuarter: null, label: "At 30 June" } });
  const views = kpiPeriodViews([year, balance, quarter, year]);
  expect(views).toEqual([{ value: "quarter", label: "Quarterly" }, { value: "year", label: "Annual" }, { value: "instant", label: "Balances" }]);
  expect(kpiPeriodView("year", views)).toBe("year");
  // A stored kind the company no longer has opens the first one, and a table with no rows has no view.
  expect(kpiPeriodView("half", views)).toBe("quarter");
  expect(kpiPeriodView("quarter", kpiPeriodViews([year]))).toBe("year");
  expect(kpiPeriodView("quarter", [])).toBeNull();
  const change = (kind: Parameters<typeof companyColumns>[5]) => companyColumns(false, false, false, false, false, kind).find((column) => column.id === "change")!.label;
  expect([change("quarter"), change("half"), change("ytd"), change("year"), change("instant"), change(null)])
    .toEqual(["Q/Q change", "H/H change", "Y/Y change", "Y/Y change", "Prior change", "Prior change"]);
});
