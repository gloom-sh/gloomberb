import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { HkTendersPayload } from "../../../api-client/hk-tenders";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { outage } from "../../../test-support/outage";
import recording from "./fixtures/hk-tenders-20261107.json";
import { createTreasuryAuctionsHeadless } from "./headless";
import { attachHkTendersPersistence, loadHkTenders, resetHkTendersPersistence, visibleHkTenders, DEFAULT_HK_SORT } from "./hk";

const NOW = "2026-11-07T08:00:00Z";
const payload = () => structuredClone(recording) as HkTendersPayload;

afterEach(() => {
  resetHkTendersPersistence();
  setSystemTime();
});

/** AUCT's report over the recorded tenders, as `fn AUCT <argument> --market ...` runs it. */
async function report(argument: string | null, options: Record<string, unknown> = {}) {
  setSystemTime(new Date(NOW));
  const usAsked: string[] = [];
  const headless = createTreasuryAuctionsHeadless({
    load: async () => {
      usAsked.push("us");
      return { auctions: [], fetchedAt: Date.parse(NOW), stale: false };
    },
    curves: async () => ({ curves: new Map(), errors: [] }),
    hk: async () => ({ tenders: payload().tenders, fetchedAt: Date.parse(NOW), stale: false }),
  });
  const args = createTestHeadlessArgs({ argument, options: { historyDays: "365", filter: "all", market: "us", view: "results", ...options } });
  const result = await headless.load(args, createTestHeadlessContext());
  return { result, usAsked, headless, args, issues: result.rows.map((row) => String(row.issue)) };
}

test("Hong Kong's tenders by --market hk or a search naming them; a word that only names the market leaves the search", async () => {
  const all = await report(null, { market: "hk" });
  expect(all.usAsked).toEqual([]);
  // Newest first, the window's tenders: 30 days leaves the August notes and December's bill out.
  expect(all.issues).toEqual(["H2673", "Q2644", "03GB2807001", "10GB3507001", "Y2696", "02Y2808", "01GH2708001", "Q2553"]);
  expect((await report(null, { market: "hk", historyDays: "30" })).issues).toEqual(["H2673", "Q2644", "03GB2807001", "10GB3507001", "Y2696"]);
  expect((await report("HK 10Y")).issues).toEqual(["10GB3507001"]);
  expect((await report("EFB")).issues).toEqual(["H2673", "Q2644", "Y2696", "Q2553"]);
  // 1Y is the 12-month bill and the 1-year note; RMB the RMB bond; a month, its tenders.
  expect((await report("1Y", { market: "hk" })).issues).toEqual(["Y2696", "01GH2708001"]);
  expect((await report("HKGB RMB")).issues).toEqual(["03GB2807001"]);
  expect((await report("2026-11", { market: "hk" })).issues).toEqual(["H2673", "Q2644"]);
  expect((await report(null, { market: "hk", filter: "bond" })).issues).toEqual(["03GB2807001", "10GB3507001", "01GH2708001"]);
  expect((await report(null, { market: "hk", sort: "btc" })).issues.slice(0, 2)).toEqual(["03GB2807001", "H2673"]);
});

test("the text reads each tender's yields, an FRN's spread in bp, and the size in its currency; the report is dated in Hong Kong", async () => {
  const { result, headless, args } = await report(null, { market: "hk", historyDays: "all" });
  const text = renderHeadlessPaneText(headless, result, args, "AUCT");
  const line = (issue: string) => text.split("\n").find((entry) => entry.includes(issue))!.trim().split(/\s{2,}/);
  expect(line("Q2644")).toEqual(["2026-11-03", "EFB", "3-Month", "2.840%", "2.810%", "2.49", "HK$66.29B", "Q2644"]);
  expect(line("03GB2807001")).toEqual(["2026-10-22", "HKGB", "2-Year", "1.415%", "1.401%", "9.93", "RMB750M", "03GB2807001"]);
  expect(line("01GH2708001")).toEqual(["2026-08-12", "FRN", "1-Year", "26.0bp spread", "20.0bp spread", "3.75", "HK$1.5B", "01GH2708001"]);
  expect(text).toContain("Hong Kong Tenders | all | all");
  const freshness = deriveHeadlessFreshness(headless, result, Date.parse(NOW));
  expect(freshness).toMatchObject({ asOf: "2026-11-03", source: "Hong Kong Monetary Authority" });
});

test("another market's paper says what AUCT covers; the after view and a US-only sort say they are US Treasury's", async () => {
  const jgb = await report("JGB");
  expect(jgb.result.notes?.[0]).toBe(
    "AUCT covers US Treasury auctions and Hong Kong government paper tenders (--market hk); \"JGB\" is neither. Search by type, benchmark (10Y), term, CUSIP, or date (YYYY-MM-DD).",
  );
  const after = await report(null, { market: "hk", view: "after", sort: "indirect" });
  expect(after.result.notes).toEqual(expect.arrayContaining([
    "The after view ranks US Treasury auctions; Hong Kong tenders list their results.",
    "--sort indirect is a US Treasury column; Hong Kong tenders are listed newest first.",
  ]));
  expect(after.issues[0]).toBe("H2673");
  const none = await report("30Y", { market: "hk" });
  expect(none.result.notes?.[0]).toBe(
    "No Hong Kong tenders match \"30Y\" in the last year. Search by paper (EFB, HKGB), tenor (3M, 10Y), issue, stock code, RMB, or date (YYYY-MM-DD).",
  );
});

test("the tenders load once an hour from Gloom Cloud; a saved copy answers an outage, and a record not served yet is the error", async () => {
  setSystemTime(new Date(NOW));
  attachHkTendersPersistence(new MemoryPluginPersistence());
  const asked: (string | null)[] = [];
  const fresh = await loadHkTenders(false, 120, async (from) => {
    asked.push(from);
    return payload();
  });
  expect(asked).toEqual(["2026-07-10"]);
  expect(visibleHkTenders(fresh.tenders, { filter: "all", query: "", sort: DEFAULT_HK_SORT })).toHaveLength(8);
  await loadHkTenders(false, 120, async () => {
    throw new Error("must not ask again within the hour");
  });
  const saved = await loadHkTenders(true, 120, async () => {
    throw outage();
  });
  expect(saved.savedAt).toBe(Date.parse(NOW));
  expect(saved.tenders).toHaveLength(8);
  await expect(loadHkTenders(true, "all", async () => ({ ...payload(), status: "unavailable", tenders: [] })))
    .rejects.toThrow("Hong Kong tender results are not available yet");
});
