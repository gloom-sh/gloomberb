import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { cachedCompanyData, companyKpisCache, fetchCompanyData, loadCompanyData, validateCompanyData } from "./client";
import { allObservations, guidanceSeries, observationChange, observationChart, outcomeLabel, rangeText, observationValue, guideGroupKey } from "./model";
import { guide, guidancePayload, kpisPayload, observation } from "./test-fixture";

afterEach(() => { setCloudApiFetchTransport(null); companyKpisCache.reset(); });
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
