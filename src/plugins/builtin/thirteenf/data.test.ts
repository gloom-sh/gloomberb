import { afterEach, describe, expect, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import {
  attachThirteenFApiPersistence,
  resetThirteenFApiPersistence,
} from "./api";
import { loadBrowserRows, loadFundDetail } from "./data";
import { buildFundHoldingRows, hasComparable13FQuarter } from "./model";

afterEach(() => {
  setHttpFetchTransport(null);
  resetThirteenFApiPersistence();
});

describe("13F data cache", () => {
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

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
