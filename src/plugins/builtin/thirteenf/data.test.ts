import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import {
  attachThirteenFApiPersistence,
  resetThirteenFApiPersistence,
} from "./api";
import { ApiRequestError } from "../../../api-client/errors";
import { loadBrowserRows as loadRankedRows, loadFilingGap, loadFilingPositions, loadFundDetail } from "./data";
import { filingGapText } from "./report-notes";
import { buildFundHoldingRows, hasComparable13FQuarter } from "./model";

async function loadBrowserRows(...args: Parameters<typeof loadRankedRows>) {
  const result = await loadRankedRows(...args);
  await result.reportsLoaded;
  return result;
}

afterEach(() => {
  setHttpFetchTransport(null);
  resetThirteenFApiPersistence();
});

describe("13F data cache", () => {
  test("all browser entry points reconcile additions and restatements without borrowing another period", async () => {
    const forms: any[] = [
      { accession_number: "addition", period_of_report: "2026-06-30", table_value_total: 50, table_entry_total: 1,
        filed_as_of_date: "2026-08-20", submission_type: "13F-HR/A", amendment_type: "NEW HOLDINGS" },
      { accession_number: "original", period_of_report: "2026-06-30", table_value_total: 100, table_entry_total: 2,
        filed_as_of_date: "2026-08-14", submission_type: "13F-HR" },
    ];
    let latestFilings = forms;
    setHttpFetchTransport(async (url) => {
      const request = new URL(String(url));
      const path = request.pathname.split("/").at(-1);
      const withManager = (rows: any[]) => rows.map((form) => ({ ...form, cik: "1067983", company_name: "Fund" }));
      if (path === "forms") return json(withManager(forms.slice(Number(request.searchParams.get("offset") ?? 0), Number(request.searchParams.get("limit")))));
      if (path === "filings") return json(withManager(latestFilings));
      if (path === "funds") return json([{ cik: "1067983", name: "Fund" }]);
      if (path === "topfunds") return json([{ cik: "1067983", name: "Fund", period_of_report: "2026-06-30", pnl: 4 }]);
      if (path === "tickers") return json([{ cusip: "111111111", ticker: "AAA" }]);
      if (path === "holders") return json({ period_of_report: "2026-06-30", ciks: ["1067983"] });
      return json([]);
    });
    for (const [tab, query] of [["performance", ""], ["funds", "Fund"], ["funds", "1067983"], ["byTicker", "AAA"], ["latest", "latest"]] as const) {
      expect((await loadBrowserRows(tab, query)).rows[0]).toMatchObject({ tableValueTotal: 150, tableEntryTotal: 3 });
    }
    forms.unshift({ ...forms[1], accession_number: "newer-quarter", period_of_report: "2026-09-30", table_value_total: 900, table_entry_total: 9 });
    expect((await loadBrowserRows("performance", "")).rows[0]).toMatchObject({ periodOfReport: "2026-06-30", estQuarterReturn: 4, tableValueTotal: 150, tableEntryTotal: 3 });
    forms.shift();
    forms.unshift({ ...forms[0], accession_number: "restatement", amendment_type: "RESTATEMENT", filed_as_of_date: "2026-08-21", table_value_total: 20, table_entry_total: 1 });
    expect((await loadBrowserRows("funds", "Fund")).rows[0]).toMatchObject({ tableValueTotal: 20, tableEntryTotal: 1 });
    forms[0].amendment_type = undefined;
    expect((await loadBrowserRows("funds", "Fund")).rows[0]).toMatchObject({ tableValueTotal: null, tableEntryTotal: null });
    forms.splice(0, 1);
    forms.pop();
    expect((await loadBrowserRows("funds", "Fund")).rows[0]).toMatchObject({ tableValueTotal: null, tableEntryTotal: null });
    latestFilings = [{ ...forms[0], period_of_report: "2026-03-31" }];
    expect((await loadBrowserRows("latest", "latest")).rows[0]).toMatchObject({ periodOfReport: "2026-03-31", tableValueTotal: null, tableEntryTotal: null });
  });

  test("a missing prior report preserves current holdings and restores comparisons after refresh", async () => {
    let failure: "previous" | "current" | null = "previous";
    setHttpFetchTransport(async (url) => {
      const request = new URL(String(url));
      if (request.pathname.endsWith("/forms")) return json([
        { accession_number: "current", period_of_report: "2026-06-30", table_value_total: 100, table_entry_total: 1, filed_as_of_date: "2026-08-14", submission_type: "13F-HR", cik: "1067983" },
        { accession_number: "previous", period_of_report: "2026-03-31", table_value_total: 90, table_entry_total: 1, filed_as_of_date: "2026-05-14", submission_type: "13F-HR", cik: "1067983" },
      ]);
      const accession = request.searchParams.get("accession_number");
      if (accession === failure) return new Response("unavailable", { status: 503 });
      return json([{ accession_number: accession, cik: "1067983", cusip: "111111111", value: accession === "current" ? 100 : 90, ssh_prnamt: 10 }]);
    });
    const partial = await loadFundDetail("1067983", "Fund");
    expect(partial.latestReport).toMatchObject({ complete: true, tableValueTotal: 100 });
    expect(partial.previousReport?.complete).toBe(false);
    expect(partial.warnings).toEqual(["2026-03-31: holdings unavailable; comparison unavailable."]);
    expect(buildFundHoldingRows(partial)[0]).toMatchObject({ value: 100, weight: 1, previousValue: null, estimatedPnl: null, action: "unknown", sharesChange: null });
    failure = null;
    const recovered = await loadFundDetail("1067983", "Fund", undefined, { forceRefresh: true });
    expect(hasComparable13FQuarter(recovered)).toBe(true);
    expect(buildFundHoldingRows(recovered)[0]).toMatchObject({ value: 100, previousValue: 90, action: "held", sharesChange: 0 });
    failure = "current";
    await expect(loadFundDetail("1067983", "Fund", undefined, { forceRefresh: true })).rejects.toThrow("Forms13F 503");
  });

  test("one failed holder enhancement retains every source CIK and healthy metadata", async () => {
    setHttpFetchTransport(async (url) => {
      const request = new URL(String(url));
      const path = request.pathname.split("/").at(-1);
      if (path === "tickers") return json([{ cusip: "111111111", ticker: "AAA" }]);
      if (path === "holders") return json({ period_of_report: "2026-06-30", ciks: ["1", "2"] });
      if (path === "forms" && request.searchParams.get("cik") === "0000000002") return new Response("unavailable", { status: 503 });
      return json([{ accession_number: "healthy", cik: "1", company_name: "Healthy Fund", period_of_report: "2026-06-30", filed_as_of_date: "2026-08-14", submission_type: "13F-HR", table_value_total: 100, table_entry_total: 1 }]);
    });
    const result = await loadBrowserRows("byTicker", "AAA");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ cik: "0000000001", name: "Healthy Fund", tableValueTotal: 100 });
    expect(result.rows[1]).toMatchObject({ cik: "0000000002", name: "0000000002" });
    expect(result.rows[1]?.tableValueTotal).toBeUndefined();
    expect(result.warning).toBe("0000000002: filing metadata unavailable.");
  });

  test("keeps performance returns and latest filing metadata in their own reporting periods", async () => {
    let reportedPeriod = "2026-09-30";
    setHttpFetchTransport(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/funds")) return json([{ cik: "1067983", name: "Fund" }]);
      if (path.endsWith("/topfunds")) return json([{
        cik: "1067983", name: "Fund", period_of_report: "2026-06-30", pnl: 12,
      }]);
      if (path.endsWith("/forms")) return json([{
        accession_number: "filing", cik: "1067983", company_name: "Fund", submission_type: "13F-HR",
        period_of_report: reportedPeriod, filed_as_of_date: "2026-10-15", table_value_total: 100, table_entry_total: 2,
      }]);
      return json([]);
    });
    const performance = await loadBrowserRows("performance", "");
    expect(performance.rows[0]).toMatchObject({ periodOfReport: "2026-06-30", estQuarterReturn: 12 });
    expect(performance.rows[0]?.tableValueTotal).toBeUndefined();
    expect(performance.rows[0]?.filedAsOfDate).toBeUndefined();
    expect(performance.rows[0]?.tableEntryTotal).toBeUndefined();

    const funds = await loadBrowserRows("funds", "Fund");
    expect(funds.rows[0]).toMatchObject({ periodOfReport: "2026-09-30", tableValueTotal: 100, estQuarterReturn: null });

    reportedPeriod = "2026-06-30";
    for (const tab of ["performance", "funds"] as const) {
      const matching = await loadBrowserRows(tab, "Fund");
      expect(matching.rows[0]).toMatchObject({ periodOfReport: "2026-06-30", tableValueTotal: 100, estQuarterReturn: 12 });
    }
  });

  test("loads all additive filings, uses their combined denominator, and detects truncated holdings", async () => {
    const fetched: string[] = [];
    const forms = [
      { accession_number: "base", period_of_report: "2026-06-30", table_value_total: 100,
        table_entry_total: 1, filed_as_of_date: "2026-08-14", submission_type: "13F-HR" },
      { accession_number: "addition", period_of_report: "2026-06-30", table_value_total: 50,
        table_entry_total: 1, filed_as_of_date: "2026-08-20", submission_type: "13F-HR/A", amendment_type: "NEW HOLDINGS" },
      { accession_number: "previous", period_of_report: "2026-03-31", table_value_total: 120,
        table_entry_total: 1, filed_as_of_date: "2026-05-14", submission_type: "13F-HR" },
    ];
    setHttpFetchTransport(async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/forms")) return json(forms.map((form) => ({ ...form, cik: "1067983" })));
      const accession = parsed.searchParams.get("accession_number")!;
      fetched.push(accession);
      return json([{ accession_number: accession, cik: "1067983", cusip: accession === "addition" ? "222222222" : "111111111",
        ticker: accession === "addition" ? "NEW" : "OLD", value: accession === "addition" ? 50 : 100, ssh_prnamt: 10 }]);
    });
    const detail = await loadFundDetail("1067983", "Fund");
    expect(fetched.sort()).toEqual(["addition", "base", "previous"]);
    expect(detail.forms).toHaveLength(3);
    expect(detail.latestReport).toMatchObject({ complete: true, tableValueTotal: 150 });
    expect(hasComparable13FQuarter(detail)).toBe(true);
    expect(buildFundHoldingRows(detail).find((row) => row.ticker === "NEW"))
      .toMatchObject({ weight: 1 / 3, value: 50, action: "new" });
    forms[0]!.table_entry_total = 2;
    const partial = await loadFundDetail("1067983", "Fund", undefined, { forceRefresh: true });
    expect(partial.warnings?.[0]).toContain("loaded 1 of 2");
    expect(hasComparable13FQuarter(partial)).toBe(false);
    expect(buildFundHoldingRows(partial).every((row) => row.action === "unknown" && row.weight === null)).toBe(true);
  });

  test("reuses the built-in plugin resource cache across browser row loads", async () => {
    attachThirteenFApiPersistence(new MemoryPluginPersistence());
    let requestCount = 0;
    setHttpFetchTransport(async (url) => {
      requestCount += 1;
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/funds")) {
        return json([{ cik: "1364742", name: "BlackRock Inc." }]);
      }
      if (path.endsWith("/forms")) {
        return json([{
          accession_number: "0001364742-26-000001",
          cik: "1364742",
          period_of_report: "2026-03-31",
          filed_as_of_date: "2026-05-15",
          submission_type: "13F-HR",
          company_name: "BlackRock Inc.",
          table_value_total: 100,
          table_entry_total: 1,
        }]);
      }
      if (path.endsWith("/topfunds")) {
        return json([]);
      }
      return json([]);
    });

    const first = await loadBrowserRows("funds", "BlackRock");
    const second = await loadBrowserRows("funds", "BlackRock");

    expect(first.rows[0]?.name).toBe("BlackRock Inc.");
    expect(second.rows[0]?.name).toBe("BlackRock Inc.");
    expect(requestCount).toBe(3);
  });

  test("force refresh bypasses the plugin resource cache", async () => {
    attachThirteenFApiPersistence(new MemoryPluginPersistence());
    let requestCount = 0;
    setHttpFetchTransport(async (url) => {
      requestCount += 1;
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/funds")) {
        return json([{ cik: "1364742", name: "BlackRock Inc." }]);
      }
      return json([]);
    });

    await loadBrowserRows("funds", "BlackRock");
    await loadBrowserRows("funds", "BlackRock", undefined, { forceRefresh: true });

    expect(requestCount).toBe(6);
  });

  test("requests later fund pages with the Forms13F offset", async () => {
    const fundOffsets: number[] = [];
    setHttpFetchTransport(async (url) => {
      const requestUrl = new URL(String(url));
      const path = requestUrl.pathname;
      if (path.endsWith("/funds")) {
        fundOffsets.push(Number(requestUrl.searchParams.get("offset") ?? 0));
        return json([{ cik: "1364742", name: `BlackRock page ${fundOffsets.length}` }]);
      }
      return json([]);
    });

    const first = await loadBrowserRows("funds", "BlackRock");
    const second = await loadBrowserRows("funds", "BlackRock", undefined, { offset: first.nextOffset });

    expect(fundOffsets).toEqual([0, 1]);
    expect(first.nextOffset).toBe(1);
    expect(second.nextOffset).toBe(2);
  });
});

test("ranked rows paint before filing reports, then take the reconciled totals", async () => {
  let releaseReports: (() => void) | undefined;
  let formCalls = 0;
  const reportsGate = new Promise<void>((resolve) => { releaseReports = resolve; });
  const form = {
    accession_number: "original", cik: "1067983", company_name: "Fund", period_of_report: "2026-06-30",
    filed_as_of_date: "2026-08-14", submission_type: "13F-HR", table_value_total: 100, table_entry_total: 2,
  };
  setHttpFetchTransport(async (url) => {
    const request = new URL(String(url));
    const path = request.pathname.split("/").at(-1);
    if (path === "forms") {
      formCalls += 1;
      await reportsGate;
      return json([
        form,
        { ...form, accession_number: "addition", filed_as_of_date: "2026-08-20", submission_type: "13F-HR/A", amendment_type: "NEW HOLDINGS", table_value_total: 50, table_entry_total: 1 },
      ]);
    }
    if (path === "filings") return json([{ ...form }]);
    if (path === "funds") return json([{ cik: "1067983", name: "Fund" }]);
    if (path === "topfunds") return json([{ cik: "1067983", name: "Fund", period_of_report: "2026-06-30", pnl: 4 }]);
    if (path === "tickers") return json([{ cusip: "111111111", ticker: "AAA" }]);
    if (path === "holders") return json({ period_of_report: "2026-06-30", ciks: ["1067983"] });
    return json([]);
  });
  const pages = await Promise.race([
    Promise.all([
      loadRankedRows("latest", "latest"),
      loadRankedRows("funds", "Fund"),
      loadRankedRows("byTicker", "AAA"),
      loadRankedRows("performance", ""),
    ]),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ranked rows waited for reports")), 500)),
  ]);
  for (let i = 0; i < 30 && formCalls === 0; i++) await Promise.resolve();
  expect(formCalls).toBeGreaterThan(0);
  expect(pages.map((page) => page.rows[0]?.name)).toEqual(["Fund", "Fund", "0001067983", "Fund"]);
  expect(pages[0]?.rows[0]?.tableValueTotal).toBe(100);
  expect(pages[1]?.rows[0]?.tableValueTotal).toBeUndefined();
  expect(pages[2]?.rows[0]?.tableValueTotal).toBeUndefined();
  expect(pages[3]?.rows[0]).toMatchObject({ estQuarterReturn: 4, tableValueTotal: undefined });
  releaseReports!();
  await Promise.all(pages.map((page) => page.reportsLoaded));
  expect(pages[0]?.rows[0]).toMatchObject({ tableValueTotal: 150, tableEntryTotal: 3 });
  expect(pages[1]?.rows[0]).toMatchObject({ name: "Fund", tableValueTotal: 150, tableEntryTotal: 3 });
  expect(pages[2]?.rows[0]).toMatchObject({ name: "Fund", tableValueTotal: 150, tableEntryTotal: 3 });
  expect(pages[3]?.rows[0]).toMatchObject({ periodOfReport: "2026-06-30", estQuarterReturn: 4, tableValueTotal: 150, tableEntryTotal: 3 });
});

test("abort during a holdings page stops the walk", async () => {
  const controller = new AbortController();
  let formCalls = 0;
  const spy = spyOn(apiClient, "getCloudSec13F").mockImplementation((async (path: string, _params: unknown, options?: { signal?: AbortSignal }) => {
    expect(options?.signal).toBe(controller.signal);
    if (path === "/form") {
      formCalls += 1;
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    throw new Error("cloud down");
  }) as never);
  setHttpFetchTransport(async (url) => {
    if (new URL(String(url)).pathname.endsWith("/forms")) return json([{
      accession_number: "current", cik: "1067983", company_name: "Fund", period_of_report: "2026-06-30",
      filed_as_of_date: "2026-08-14", submission_type: "13F-HR", table_value_total: 100, table_entry_total: 200,
    }]);
    throw new Error(`unexpected ${url}`);
  });
  try {
    await expect(loadFundDetail("1067983", "Fund", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(formCalls).toBe(1);
  } finally {
    spy.mockRestore();
  }
});

test("a fund behind on its filings reads EDGAR's 13F-NT; a missing route, a server failure or a hang leaves it unchecked, never 'no 13F'", async () => {
  // 18 October 2026: Q2 2026 was due 14 August; the fund's latest loaded report is Q1.
  const now = new Date("2026-10-18T12:00:00Z");
  let answer: (signal?: AbortSignal) => Promise<unknown> = async () => ({});
  const asked: Array<{ path: string; params: unknown }> = [];
  const spy = spyOn(apiClient, "getCloudSec13F").mockImplementation((async (path: string, params: unknown, options?: { signal?: AbortSignal }) => {
    asked.push({ path, params });
    return answer(options?.signal);
  }) as never);
  // The filing list is Gloom Cloud's alone; no failure falls through to the public 13F source.
  setHttpFetchTransport(async (url) => { throw new Error(`unexpected ${url}`); });
  const gap = (timeoutMs?: number) => loadFilingGap("1336528", "2026-03-31", undefined, now, { timeoutMs });
  try {
    answer = async () => ({
      cik: "0001336528", name: "Pershing Square Capital Management, L.P.", source: "SEC EDGAR",
      filings: [
        { form: "13F-HR", period: "2026-03-31", filed: "2026-05-15", accession: "a", url: "https://www.sec.gov/a" },
        { form: "13F-NT", period: "2026-06-30", filed: "2026-08-14", accession: "0001172661-26-003777", url: "https://www.sec.gov/nt",
          otherManagers: [{ cik: "2026053", name: "PERSHING SQUARE INC.", fileNumber: "028-25746" }] },
      ],
    });
    const notice = await gap();
    expect(asked).toEqual([{ path: "/filer", params: { cik: "0001336528" } }]);
    expect(notice).toMatchObject({ period: "2026-06-30", due: "2026-08-14", checked: true, filing: { form: "13F-NT", otherManagers: [{ cik: "0002026053" }] } });
    expect(filingGapText(notice!)).toBe("13F-NT for Q2 2026, filed 14 Aug; holdings reported by PERSHING SQUARE INC. | open: fn 13F 0002026053");

    const unchecked = "Q2 2026 13F (due 14 Aug) not in the loaded filings; EDGAR not checked";
    for (const failure of [new ApiRequestError("Not found", 404), new ApiRequestError("Bad gateway", 502)]) {
      answer = async () => { throw failure; };
      const result = await gap();
      expect(result).toEqual({ period: "2026-06-30", due: "2026-08-14", filing: null, checked: false });
      expect(filingGapText(result!)).toBe(unchecked);
    }
    // No answer: the deadline aborts the request and the report goes out unchecked.
    let aborted = false;
    answer = (signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => { aborted = true; reject(signal.reason); }));
    const hung = await gap(20);
    expect(aborted).toBe(true);
    expect(filingGapText(hung!)).toBe(unchecked);
    // A current report asks nothing.
    asked.length = 0;
    expect(await loadFilingGap("1336528", "2026-06-30", undefined, now)).toBeNull();
    expect(asked).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}


test("browser, reconciled report and individual filing expose failed-refresh cache provenance without changing filing dates", async () => {
  attachThirteenFApiPersistence(new MemoryPluginPersistence());
  let fail = false;
  setHttpFetchTransport(async url => {
    if (fail) throw new Error("Controlled network outage");
    if (new URL(String(url)).pathname.endsWith("/forms")) return json([{
      accession_number: "0001067983-26-000001", cik: "1067983", company_name: "Fund",
      period_of_report: "2026-06-30", filed_as_of_date: "2026-08-14", submission_type: "13F-HR",
      table_value_total: 100, table_entry_total: 1,
    }]);
    return json([{ accession_number: "0001067983-26-000001", cik: "1067983", cusip: "111111111", value: 100, ssh_prnamt: 10 }]);
  });
  const browser = await loadBrowserRows("funds", "1067983");
  const detail = await loadFundDetail("1067983", "Fund");
  const filing = await loadFilingPositions("1067983", "0001067983-26-000001");
  fail = true;
  const retainedBrowser = await loadBrowserRows("funds", "1067983", undefined, { forceRefresh: true });
  const retainedDetail = await loadFundDetail("1067983", "Fund", undefined, { forceRefresh: true });
  const retainedFiling = await loadFilingPositions("1067983", "0001067983-26-000001", undefined, { forceRefresh: true });
  expect(retainedBrowser.rows).toEqual(browser.rows);
  expect(retainedDetail.latestForm).toEqual(detail.latestForm);
  expect(retainedDetail.latestHoldings).toEqual(detail.latestHoldings);
  expect(retainedFiling.rows).toEqual(filing.rows);
  for (const warning of [retainedBrowser.warning, ...retainedDetail.warnings!, ...retainedFiling.warnings]) {
    expect(warning).toContain("Controlled network outage");
    expect(warning).toMatch(/retrieved \d{4}-\d{2}-\d{2}T/);
  }
  fail = false;
  expect((await loadBrowserRows("funds", "1067983")).warning).toBeUndefined();
  expect((await loadFundDetail("1067983", "Fund")).warnings).toEqual([]);
  expect((await loadFilingPositions("1067983", "0001067983-26-000001")).warnings).toEqual([]);
});

test("performance history joins by CIK, rejects mismatched periods and leaves absent ranks unknown", async () => {
  const requested: string[] = [];
  setHttpFetchTransport(async url => {
    const request = new URL(String(url));
    if (!request.pathname.endsWith("/topfunds")) return json([]);
    const quarter = request.searchParams.get("quarter")!;
    requested.push(quarter);
    const year = Number(quarter.slice(0, 4));
    const q = Number(quarter.at(-1));
    const period = new Date(Date.UTC(year, q * 3, 0)).toISOString().slice(0, 10);
    if (requested.length === 1) return json([{ cik: "1", name: "First", period_of_report: period, pnl: 10 }, { cik: "2", name: "Second", period_of_report: period, pnl: 20 }]);
    if (requested.length === 2) return json([{ cik: "2", name: "Second", period_of_report: period, pnl: -5 }]);
    return json([{ cik: "1", name: "First", period_of_report: "2000-03-31", pnl: 90 }]);
  });
  const result = await loadBrowserRows("performance", "");
  expect(requested).toHaveLength(4);
  expect(result.rows[0]?.priorReturns?.map(point => point.value)).toEqual([null, null, null]);
  expect(result.rows[1]?.priorReturns?.map(point => point.value)).toEqual([-5, null, null]);
});
