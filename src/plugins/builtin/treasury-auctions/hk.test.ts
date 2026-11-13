import { afterEach, expect, setSystemTime, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { HkTendersPayload } from "../../../api-client/hk-tenders";
import { headlessReportTables, renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { renderReportCsv } from "../../../cli/report-tables";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { outage } from "../../../test-support/outage";
// The server's answer over HKMA's datasets as read on 8 Nov 2026: EF Bills (91-day), EF Notes, the HKD floating rate notes,
// and two RMB bonds as HKMA announced them.
import recording from "./fixtures/hk-tenders-20261108.json";
import { createTreasuryAuctionsHeadless } from "./headless";
import { attachHkTendersPersistence, hkOnOrAfter, hkWindowStart, loadHkTenders, resetHkTendersPersistence, type HkTendersResult } from "./hk";
import { auctionCommandRequest } from "./model";

const NOW = "2026-11-08T02:00:00Z";
const payload = () => structuredClone(recording) as HkTendersPayload;
const board = (): HkTendersResult => {
  const { tenders, firstTender, runsTo, truncated } = payload();
  return { tenders, firstTender, runsTo, truncated, fetchedAt: Date.parse(NOW), stale: false };
};

afterEach(() => {
  resetHkTendersPersistence();
  setSystemTime();
});

/** AUCT's report over the recorded tenders, as `fn AUCT <argument> --market ...` runs it. */
async function report(argument: string | null, options: Record<string, unknown> = {}, result = board()) {
  setSystemTime(new Date(NOW));
  const usAsked: string[] = [];
  const headless = createTreasuryAuctionsHeadless({
    load: async () => {
      usAsked.push("us");
      return { auctions: [], fetchedAt: Date.parse(NOW), stale: false };
    },
    curves: async () => ({ curves: new Map(), errors: [] }),
    hk: async () => result,
  });
  const args = createTestHeadlessArgs({ argument, options: { historyDays: "365", filter: "all", view: "results", ...options } });
  const loaded = await headless.load(args, createTestHeadlessContext());
  const label = (row: Record<string, unknown>) => `${String(row.date)} ${String(row.issue ?? row.term)}`;
  return { result: loaded, usAsked, headless, args, rows: loaded.rows.map(label) };
}

test("Hong Kong's tenders by --market hk or a search naming them, RMB and CNH too; an explicit --market wins and the options name the market used", async () => {
  const all = await report(null, { market: "hk" });
  expect(all.usAsked).toEqual([]);
  // Newest first; a bond's issue month sorts after that month's days.
  expect(all.rows.slice(0, 6)).toEqual([
    "2026-10-28 3-Month", "2026-10-21 3-Month", "2026-10-14 3-Month", "2026-10 03GB2807001", "2026-08-24 2-Year", "2026-08 05GB3105001",
  ]);
  expect(all.result.appliedOptions).toEqual({ market: "hk", view: "results" });
  // The RMB 3-year bond re-opened with 1-Year 9-Month left reads as a 2Y, as its US kin would.
  expect((await report("HK 2Y")).rows).toEqual(["2026-10 03GB2807001", "2026-08-24 2-Year", "2026-05-26 2-Year", "2026-02-23 2-Year"]);
  expect((await report("RMB")).rows).toEqual(["2026-10 03GB2807001", "2026-08 05GB3105001"]);
  expect((await report("cnh 5y")).rows).toEqual(["2026-08 05GB3105001"]);
  expect((await report("2026-05", { market: "hk" })).rows).toEqual(["2026-05-26 2-Year", "2026-05 01GH2705001"]);
  // --market us over a search naming Hong Kong: the US board, and the options say so.
  const us = await report("HK 10Y", { market: "us" });
  expect([us.usAsked, us.result.appliedOptions]).toEqual([["us"], { market: "us", view: "results" }]);
  expect(auctionCommandRequest("HK 10Y --market us").params).toMatchObject({ auctionMarket: "us", search: "HK 10Y" });
  expect(auctionCommandRequest("RMB 3Y").params).toMatchObject({ auctionMarket: "hk", search: "RMB 3Y" });
});

// `fn AUCT "HK 10Y"` read "10-Year" for the 2023-10-26 re-opening of 10GB2601, which had about 2.2 years left.
test("a re-opening reads the term its issue had left, as a US reopening does, and is still found by its issue's tenor", async () => {
  const reopened = {
    ...payload().tenders.find((tender) => tender.issue === "03GB2807001")!,
    date: "2023-10-26", paper: "hkgb" as const, issue: "10GB2601", currency: "HKD" as const, term: "10-Year", maturity: "2026-01-21",
    reopening: true, dataset: "ibip-3year",
  };
  const first = { ...reopened, date: "2016-01-21", reopening: false, dataset: "ibip-10year" };
  const result = { ...board(), tenders: [reopened, first], firstTender: "2016-01-21" };
  const tenTear = await report("HK 10Y", { historyDays: "all" }, result);
  expect(tenTear.result.rows.map((row) => [row.date, row.term, row.issueTerm])).toEqual([
    ["2023-10-26", "2-Year 3-Month", "10-Year"], ["2016-01-21", "10-Year", "10-Year"],
  ]);
  // HKMA tendered it in its 3-year bucket: 3Y finds it, as 10Y finds a US 9-Year 10-Month.
  expect((await report("HK 3Y", { historyDays: "all" }, result)).rows).toEqual(["2023-10-26 10GB2601"]);
  // Shortest first: the re-opening's 27 months before its issue's 120.
  expect((await report("HK", { historyDays: "all", sort: "term" }, result)).rows).toEqual(["2023-10-26 10GB2601", "2016-01-21 10GB2601"]);
});

// `fn AUCT "HK 10Y" --like 2023-10-26` printed the plain list and exited 0.
test("--like refuses Hong Kong's tenders, which have no percentiles to rank by", async () => {
  await expect(report("HK 10Y", { historyDays: "all", like: "2023-10-26" }))
    .rejects.toThrow("--like ranks US Treasury auctions by their percentiles against their tenor; Hong Kong's tenders have no percentiles.");
});

test("the window counts back from today in Hong Kong, and a bond's month stays in a window that starts within it", async () => {
  // 20:00 UTC on 7 Nov is 8 Nov in Hong Kong.
  expect(hkWindowStart(30, Date.parse("2026-11-07T20:00:00Z"))).toBe("2026-10-09");
  expect(hkWindowStart(30, Date.parse("2026-11-07T15:00:00Z"))).toBe("2026-10-08");
  expect(hkWindowStart("all")).toBeNull();
  expect([hkOnOrAfter("2026-08", "2026-08-25"), hkOnOrAfter("2026-08-24", "2026-08-25"), hkOnOrAfter("2026-07", "2026-08-01")])
    .toEqual([true, false, false]);
  expect((await report(null, { market: "hk", historyDays: "90" })).rows).toEqual([
    "2026-10-28 3-Month", "2026-10-21 3-Month", "2026-10-14 3-Month", "2026-10 03GB2807001", "2026-08-24 2-Year", "2026-08 05GB3105001",
  ]);
});

test("rate and size sort within their kind: yields before floating rate notes' spreads, HK$ sizes before RMB ones", async () => {
  const byRate = (await report(null, { market: "hk", sort: "rate", historyDays: "all" })).result.rows;
  const spreads = byRate.findIndex((row) => row.spread != null);
  expect(byRate.slice(0, spreads).every((row) => row.averageYield != null)).toBe(true);
  expect(byRate.slice(spreads).map((row) => row.rate)).toEqual([50, 30, 25, 22, 21, 20, 20]);
  expect(byRate[0]?.rate).toBe(3.0578);
  const bySize = (await report(null, { market: "hk", sort: "size", historyDays: "all" })).result.rows;
  expect(bySize.map((row) => row.currency)).toEqual([...Array(bySize.length - 2).fill("HKD"), "CNH", "CNH"]);
  expect(bySize.slice(-2).map((row) => row.issue)).toEqual(["05GB3105001", "03GB2807001"]);
  expect(bySize[0]?.size).toBe(71_100_000_000);
});

test("the text reads the average yield as RATE, an FRN's spread in bp and EF paper's worked-out size; exports keep the size a number with its currency", async () => {
  const { result, headless, args } = await report(null, { market: "hk", historyDays: "all" });
  const text = renderHeadlessPaneText(headless, result, args, "AUCT");
  const line = (needle: string) => text.split("\n").find((entry) => entry.includes(needle))!.trim().split(/\s{2,}/);
  expect(text).toMatch(/Date\s+Type\s+Term\s+Rate\s+B\/C\s+Size\s+Issue/);
  expect(line("2026-10-28")).toEqual(["2026-10-28", "EFB", "3-Month", "2.827%", "2.46", "≈HK$65.7B"]);
  // A re-opening of a 3-year bond that matures in July 2028, tendered in October 2026.
  expect(line("03GB2807001")).toEqual(["2026-10", "HKGB", "1-Year 9-Month", "1.401%", "9.93", "RMB750M", "03GB2807001"]);
  expect(line("01GH2705001")).toEqual(["2026-05", "FRN", "1-Year", "20.0bp spread", "4.44", "HK$1.5B", "01GH2705001"]);
  expect(text).toContain("Hong Kong Tenders | all | all");
  expect(text).toContain("HKMA publishes its tender figures monthly; they run to 28 Oct 2026 for EF Bills, 24 Aug 2026 for EF Notes, Oct 2026 for Government Bonds.");
  const freshness = deriveHeadlessFreshness(headless, result, Date.parse(NOW));
  expect(freshness).toMatchObject({ asOf: "2026-10-28", source: "HKMA" });

  const csv = renderReportCsv(headlessReportTables(headless, result, args, "AUCT", freshness, { complete: true, unavailableSymbols: [] }), freshness)
    .split("\n");
  const header = csv[0]!.split(",");
  const rmb = csv.find((entry) => entry.includes("03GB2807001"))!.split(",");
  expect(rmb[header.indexOf("Size")]).toBe("750000000");
  expect(rmb[header.indexOf("currency_or_unit")]).toBe("CNH");
  expect(rmb[header.indexOf("Rate")]).toBe("1.401");
  const json = serializeHeadlessPaneResult(headless, result) as { rows: Record<string, unknown>[] };
  expect(json.rows.find((row) => row.issue === "03GB2807001")).toMatchObject({ size: 750_000_000, currency: "CNH", rate: 1.401, date: "2026-10" });
});

test("the older-tenders note only where the record goes back past the window; another market's paper, the after view and a US-only sort say what AUCT covers", async () => {
  expect((await report(null, { market: "hk", historyDays: "365" })).result.notes).toContain("Older tenders: use --history-days 1825.");
  // The record starting inside the window: a wider one adds nothing.
  const short = { ...board(), firstTender: "2026-02-23" };
  expect((await report(null, { market: "hk", historyDays: "365" }, short)).result.notes?.some((note) => note.startsWith("Older tenders"))).toBe(false);
  expect((await report("JGB")).result.notes?.[0]).toBe(
    "AUCT covers US Treasury auctions and Hong Kong government paper tenders (--market hk); \"JGB\" is neither. Search by type, benchmark (10Y), term, CUSIP, or date (YYYY-MM-DD).",
  );
  const after = await report(null, { market: "hk", view: "after", sort: "indirect" });
  expect(after.result.notes).toEqual(expect.arrayContaining([
    "The after view ranks US Treasury auctions; Hong Kong tenders list their results.",
    "--sort indirect is a US Treasury column; Hong Kong tenders are listed newest first.",
  ]));
  expect((await report("30Y", { market: "hk" })).result.notes?.[0]).toBe(
    "No Hong Kong tenders match \"30Y\" in the last year. Search by paper (EFB, HKGB), tenor (3M, 10Y), issue, HKD or RMB, or date (YYYY-MM-DD).",
  );
});

test("the tenders load once an hour from Gloom Cloud; a saved copy answers an outage, and a route not there yet or an empty record says so", async () => {
  setSystemTime(new Date(NOW));
  attachHkTendersPersistence(new MemoryPluginPersistence());
  const asked: [string, number][] = [];
  const fresh = await loadHkTenders(false, 120, async (from, limit) => {
    asked.push([from, limit]);
    return payload();
  });
  expect(asked).toEqual([["2026-07-11", 10_000]]);
  expect(fresh.tenders).toHaveLength(15);
  expect(fresh.runsTo).toEqual({ efb: "2026-10-28", efn: "2026-08-24", hkgb: "2026-10" });
  await loadHkTenders(false, 120, async () => {
    throw new Error("must not ask again within the hour");
  });
  const saved = await loadHkTenders(true, 120, async () => {
    throw outage();
  });
  expect(saved.savedAt).toBe(Date.parse(NOW));
  expect(saved.tenders).toHaveLength(15);
  for (const failure of [new ApiRequestError("Not Found", 404), new ApiRequestError("", 500), new Error("  ")]) {
    await expect(loadHkTenders(true, "all", async () => {
      throw failure;
    })).rejects.toThrow("Hong Kong tender results are not available yet");
  }
  await expect(loadHkTenders(true, "all", async () => ({ ...payload(), status: "unavailable", tenders: [] })))
    .rejects.toThrow("Hong Kong tender results are not available yet");
});
