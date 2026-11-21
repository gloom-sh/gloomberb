import { afterEach, expect, test } from "bun:test";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { resetThirteenFApiPersistence } from "../thirteenf/api";
import { bestFundMatch, loadHolder13FMatches } from "./thirteenf-match";
import type { HolderRow } from "./types";
afterEach(() => { setHttpFetchTransport(null); resetThirteenFApiPersistence(); });

test("manager matching rejects ambiguous subsidiaries, empty names and substring collisions", () => {
  const funds = [{ cik: "1", name: "Acme Capital Partners L.P." }, { cik: "2", name: "Acme Capital Advisors LLC" }];
  expect(bestFundMatch("Acme Capital", funds)).toBeUndefined();
  expect(bestFundMatch("Inc.", funds)).toBeUndefined();
  expect(bestFundMatch("Capital", funds)).toBeUndefined();
  expect(bestFundMatch("Capital Partners", [{ cik: "3", name: "Noncapital Partners" }])).toBeUndefined();
  expect(bestFundMatch("Acme Capital Partners LP", funds)?.cik).toBe("1");
  expect(bestFundMatch("Acme Capital Partners", [{ cik: "1", name: "Acme Capital Partners" }, { cik: "2", name: "Acme Capital Partners LLC" }])).toBeUndefined();
  expect(bestFundMatch("Acme Capital Partners", [...funds, funds[0]!])?.cik).toBe("1");
});

test("holder metadata combines additive amendments instead of showing just the added positions", async () => {
  setHttpFetchTransport(async url => {
    const path = new URL(String(url)).pathname;
    const payload = path.endsWith("/funds") ? [{ cik: "1", name: "Acme Capital Partners LP" }] : [
      { cik: "1", company_name: "Acme Capital Partners LP", accession_number: "addition", period_of_report: "2026-06-30", filed_as_of_date: "2026-08-20", submission_type: "13F-HR/A", amendment_type: "NEW HOLDINGS", table_value_total: 20, table_entry_total: 1 },
      { cik: "1", company_name: "Acme Capital Partners LP", accession_number: "base", period_of_report: "2026-06-30", filed_as_of_date: "2026-08-10", submission_type: "13F-HR", table_value_total: 100, table_entry_total: 2 },
    ];
    return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
  });
  const result = await loadHolder13FMatches([{ id: "holder", name: "Acme Capital Partners" } as HolderRow], new AbortController().signal);
  expect(result.get("holder")).toMatchObject({ cik: "0000000001", tableValueTotal: 120, periodOfReport: "2026-06-30", filedAsOfDate: "2026-08-20" });
});

test("a 13F service that never answers stops matching at the budget, keeping the matches that landed", async () => {
  const filings = [
    { cik: "1", company_name: "Acme Capital Partners LP", accession_number: "base", period_of_report: "2026-06-30", filed_as_of_date: "2026-08-10", submission_type: "13F-HR", table_value_total: 100, table_entry_total: 2 },
  ];
  let stopped = 0;
  setHttpFetchTransport(async (url, init) => {
    const target = new URL(String(url));
    // The search for this holder is taken and never answered, as by a source that takes no connection.
    if (target.pathname.endsWith("/funds") && target.searchParams.get("name") === "Silent Holdings") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { stopped++; reject(init.signal!.reason); }, { once: true });
      });
    }
    const payload = target.pathname.endsWith("/funds") ? [{ cik: "1", name: "Acme Capital Partners LP" }] : filings;
    return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
  });
  const started = performance.now();
  const result = await loadHolder13FMatches([
    { id: "silent", name: "Silent Holdings" } as HolderRow,
    { id: "answered", name: "Acme Capital Partners" } as HolderRow,
  ], new AbortController().signal, { budgetMs: 200 });
  // The budget, not the read's own timeout, ends the wait; the read it stopped is aborted, not left running.
  expect(performance.now() - started).toBeLessThan(3_000);
  expect([...result.keys()]).toEqual(["answered"]);
  expect(stopped).toBeGreaterThan(0);
});
