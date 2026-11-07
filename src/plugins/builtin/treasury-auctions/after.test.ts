import { describe, expect, test } from "bun:test";
import { auctionPercentiles, cmtFor, loadAuctionCurves, projectAuctionAfter, yieldChangeAfter } from "./after";
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

  test("reads each curve point once, from the oldest auction shown, and an after column sorts with blanks last", async () => {
    const shown = [
      auction({ secType: "Note", securityTerm: "7-Year", auctionDate: "2026-10-29", id: "a", highYield: 4.894 }),
      auction({ secType: "Note", securityTerm: "7-Year", auctionDate: "2026-10-28", id: "b", highYield: 4.9 }),
      auction({ secType: "Note", securityTerm: "6-Year 11-Month", auctionDate: "2026-11-04", id: "c", highYield: 4.8 }),
    ];
    const reads: string[] = [];
    const read = await loadAuctionCurves(shown, async (curve, tenor, from) => {
      reads.push(`${curve}:${tenor}:${from}`);
      return { curve, tenor, points: closes } as never;
    });
    expect(reads).toEqual(["us:7Y:2026-10-28"]);
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
