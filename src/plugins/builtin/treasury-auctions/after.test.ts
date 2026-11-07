import { afterEach, describe, expect, test } from "bun:test";
import {
  auctionPercentiles,
  cmtFor,
  loadAuctionCurves,
  projectAuctionAfter,
  resetAuctionCurvesForTests,
  widerAfterWindow,
  yieldChangeAfter,
} from "./after";
import { DEFAULT_AUCTION_SORT, visibleAuctions } from "./model";
import { auction } from "./test-fixture";

/** A month's auction of `term`, `months` after 2020-01, with a bid-to-cover. */
const monthly = (secType: string, securityTerm: string, months: number, bidToCoverRatio: number) => {
  const date = new Date(Date.UTC(2020, months, 15)).toISOString().slice(0, 10);
  return auction({ secType, securityTerm, auctionDate: date, cusip: `C${months}`, id: `${secType}|${date}|${securityTerm}`, bidToCoverRatio });
};

describe("percentiles", () => {
  test("rank an auction against its own tenor's previous 24 only, reopenings included, with at least 12", () => {
    // 30 ten-year auctions, B/C 2.00, 2.01 ... 2.29, every third a 9-Year 10-Month reopening; a 10-year TIPS between them.
    const notes = Array.from({ length: 30 }, (_, index) =>
      monthly("Note", index % 3 === 2 ? "9-Year 10-Month" : "10-Year", index, 2 + index / 100));
    const tips = Array.from({ length: 30 }, (_, index) => monthly("TIPS", "10-Year", index, 9));
    const ranked = auctionPercentiles([...tips, ...notes].reverse());
    // Fewer than 12 before it: nothing.
    expect(ranked.get(notes[11]!.id)!.btcPercentile).toBeNull();
    expect(ranked.get(notes[12]!.id)!.btcPercentile).toBe(100);
    // The last reads the 24 before it (2.05 to 2.28), not the first five, and not the TIPS at 9.
    const last = { ...notes[29]!, id: "low", bidToCoverRatio: 2.1 };
    const reRanked = auctionPercentiles([...notes.slice(0, 29), last, ...tips]);
    // 2.05..2.09 are below 2.10 (5), one ties (half): 5.5 / 24.
    expect(reRanked.get("low")!.btcPercentile).toBe(23);
    // A TIPS ranks among TIPS: all equal, so the middle.
    expect(reRanked.get(tips[29]!.id)!.btcPercentile).toBe(50);
    // No bidder split, no percentile, while B/C still has one.
    expect(reRanked.get("low")!.indirectPercentile).toBeNull();
  });
});

afterEach(resetAuctionCurvesForTests);

describe("the window the after view reads", () => {
  const NOW = Date.parse("2026-11-07T12:00:00Z");
  /** `count` auctions of `term`, `months` apart, the last on 2026-10-15. */
  const series = (secType: string, securityTerm: string, count: number, months: number) => Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2026, 9 - (count - 1 - index) * months, 15)).toISOString().slice(0, 10);
    return auction({ secType, securityTerm, auctionDate: date, id: `${secType}|${securityTerm}|${date}`, bidToCoverRatio: 2.4 });
  });

  test("widens while a listed tenor has fewer than 24 before its oldest row and was already sold when the window starts", () => {
    // 30-year TIPS twice a year since 1998: five years read hold 10, ten years 20, so the view asks for ten years, then all.
    const tips = series("TIPS", "29-Year 6-Month", 56, 6);
    const listed = tips.slice(-1);
    const within = (days: number) => tips.filter((entry) => Date.parse(entry.auctionDate) >= NOW - days * 86_400_000);
    expect(widerAfterWindow(listed, within(1825), 1825, NOW)).toBe(3650);
    expect(widerAfterWindow(listed, within(3650), 3650, NOW)).toBe("all");
    expect(widerAfterWindow(listed, tips, "all", NOW)).toBeNull();
    // A monthly tenor has its 24 in five years.
    const sevens = series("Note", "7-Year", 60, 1);
    expect(widerAfterWindow(sevens.slice(-1), sevens, 1825, NOW)).toBeNull();
  });

  test("a tenor that began inside the window, and a cash management bill, do not widen it", () => {
    // The 6-week bill, weekly since early 2025: fewer than 24 before a row listed in March 2025, but none before 2025.
    const sixWeek = Array.from({ length: 80 }, (_, index) => {
      const date = new Date(Date.UTC(2025, 1, 18) + index * 7 * 86_400_000).toISOString().slice(0, 10);
      return auction({ secType: "Bill", securityTerm: "6-Week", auctionDate: date, id: `6w|${date}`, highInvestmentRate: 4 });
    });
    expect(widerAfterWindow(sixWeek.slice(5), sixWeek, 1825, NOW)).toBeNull();
    const cmb = [auction({ secType: "CMB", securityTerm: "10-Day", auctionDate: "2026-10-20", id: "cmb", highInvestmentRate: 4 })];
    expect(widerAfterWindow(cmb, cmb, 1825, NOW)).toBeNull();
  });
});

describe("yield after an auction", () => {
  const closes = [
    { date: "2026-10-28", value: 4.9 }, { date: "2026-10-29", value: 4.95 }, { date: "2026-10-30", value: 4.88 },
    { date: "2026-11-02", value: 4.9 }, { date: "2026-11-03", value: 4.86 }, { date: "2026-11-04", value: 4.8 },
    { date: "2026-11-05", value: 4.78 },
  ];

  test("counts sessions from the auction day's close, in bp, and leaves a session not yet closed blank", () => {
    expect(yieldChangeAfter(closes, "2026-10-29", 1)).toBe(-7);
    expect(yieldChangeAfter(closes, "2026-10-29", 5)).toBe(-17);
    expect(yieldChangeAfter(closes, "2026-10-29", 20)).toBeNull();
    // An auction on a day the curve has no close for (a holiday) has no base.
    expect(yieldChangeAfter(closes, "2026-10-31", 1)).toBeNull();
  });

  test("matches each security to its own curve point: the benchmark, the nearest bill point, the real curve for TIPS, none for an FRN", () => {
    expect(cmtFor(auction({ secType: "Note", securityTerm: "9-Year 10-Month" }))).toEqual({ curve: "us", tenor: "10Y" });
    expect(cmtFor(auction({ secType: "Bond", securityTerm: "29-Year 10-Month" }))).toEqual({ curve: "us", tenor: "30Y" });
    expect(cmtFor(auction({ secType: "Bill", securityTerm: "6-Week" }))).toEqual({ curve: "us", tenor: "6W" });
    expect(cmtFor(auction({ secType: "Bill", securityTerm: "17-Week" }))).toEqual({ curve: "us", tenor: "4M" });
    expect(cmtFor(auction({ secType: "TIPS", securityTerm: "9-Year 6-Month" }))).toEqual({ curve: "us-real", tenor: "10Y" });
    expect(cmtFor(auction({ secType: "FRN", securityTerm: "1-Year 10-Month" }))).toBeNull();
  });

  test("reads each curve point once from the window's start, again only for older closes, and an after column sorts with blanks last", async () => {
    const shown = [
      auction({ secType: "Note", securityTerm: "7-Year", auctionDate: "2026-10-29", id: "a", highYield: 4.894 }),
      auction({ secType: "Note", securityTerm: "7-Year", auctionDate: "2026-10-28", id: "b", highYield: 4.9 }),
      auction({ secType: "Note", securityTerm: "6-Year 11-Month", auctionDate: "2026-11-04", id: "c", highYield: 4.8 }),
    ];
    const reads: string[] = [];
    const reader = async (curve: string, tenor: string, from: string | null) => {
      reads.push(`${curve}:${tenor}:${from}`);
      return { curve, tenor, points: closes } as never;
    };
    const read = await loadAuctionCurves(shown, "2026-07-10", reader);
    // A list that changes within the window reads nothing again; a window reaching further back does.
    await loadAuctionCurves(shown.slice(1), "2026-08-01", reader);
    await loadAuctionCurves(shown, "2025-07-10", reader);
    expect(reads).toEqual(["us:7Y:2026-07-10", "us:7Y:2025-07-10"]);
    const after = projectAuctionAfter(shown, shown, read.curves);
    expect(after.get("a")).toMatchObject({ after1d: -7, after5d: -17, after20d: null, cmt: "7Y" });
    const bySoonest = visibleAuctions(shown, { filter: "all", query: "", sort: { columnId: "after1d", direction: "asc" }, after });
    // b +5, a -7, c -2: ascending puts the biggest fall first.
    expect(bySoonest.map((entry) => entry.id)).toEqual(["a", "c", "b"]);
    expect(visibleAuctions(shown, { filter: "all", query: "", sort: { columnId: "after5d", direction: "desc" }, after })
      .map((entry) => entry.id)).toEqual(["b", "a", "c"]);
    expect(visibleAuctions(shown, { filter: "all", query: "", sort: DEFAULT_AUCTION_SORT, after }).map((entry) => entry.id))
      .toEqual(["c", "a", "b"]);
  });
});
