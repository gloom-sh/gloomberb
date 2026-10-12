import { describe, expect, test } from "bun:test";
import {
  AUCTION_HISTORY_WINDOWS,
  DEFAULT_AUCTION_SORT,
  auctionHistoryDays,
  auctionSize,
  dealerPct,
  directPct,
  formatAuctionRate,
  indirectPct,
  isPendingAuction,
  matchesFilter,
  nextAuctionHistoryWindow,
  nextFilter,
  rateLabel,
  rateValue,
  stopOutVsAverageBp,
  termLengthDays,
  visibleAuctions,
} from "./model";
import { auction } from "./test-fixture";

describe("term ordering", () => {
  test("orders the curve by length, not alphabetically", () => {
    const terms = ["30-Year", "4-Week", "10-Year", "182-Day", "2-Year", "6-Month", "29-Year 6-Month"];
    const sorted = [...terms].sort((left, right) => termLengthDays(left) - termLengthDays(right));
    expect(sorted).toEqual(["4-Week", "6-Month", "182-Day", "2-Year", "10-Year", "29-Year 6-Month", "30-Year"]);
  });

  test("sends unparseable terms to the end rather than to the front", () => {
    expect(termLengthDays("Cash Management")).toBe(Number.MAX_SAFE_INTEGER);
    expect(termLengthDays("")).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("both directions compare every reopening component and keep unknown terms last", () => {
    const rows = ["1-Year 11-Month", "1-Year 8-Month", "1-Year 10-Month", "Unknown"].map((securityTerm, index) =>
      auction({ secType: "Note", securityTerm, auctionDate: `2026-09-0${9 - index}` }));
    for (const direction of ["asc", "desc"] as const) {
      const sorted = visibleAuctions(rows, { filter: "all", query: "", sort: { columnId: "term", direction } });
      expect(sorted.map((row) => row.securityTerm)).toEqual(direction === "asc"
        ? ["1-Year 8-Month", "1-Year 10-Month", "1-Year 11-Month", "Unknown"]
        : ["1-Year 11-Month", "1-Year 10-Month", "1-Year 8-Month", "Unknown"]);
    }
    expect(termLengthDays("1-Year unknown suffix")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("auction metrics", () => {
  test("reads the rate each security type actually reports", () => {
    expect(rateValue(auction({ secType: "Bill", securityTerm: "4-Week", highInvestmentRate: 3.9 }))).toBe(3.9);
    expect(rateValue(auction({ secType: "Note", securityTerm: "10-Year", highYield: 4.683 }))).toBe(4.683);
    expect(rateValue(auction({ secType: "Bond", securityTerm: "20-Year" }))).toBeNull();
    const frn = auction({ secType: "FRN", securityTerm: "1-Year 11-Month", highDiscountMargin: 0.055, highYield: 3.9 });
    expect(rateValue(frn)).toBe(0.055);
    expect(formatAuctionRate(frn, rateValue(frn), "-")).toBe("5.5bp");
    // Announced auctions carry no result yet but keep their type's rate name.
    expect(rateLabel(auction({ secType: "Bill", securityTerm: "13-Week" }))).toBe("Investment rate");
    expect(rateLabel(auction({ secType: "CMB", securityTerm: "6-Week" }))).toBe("Investment rate");
    expect(rateLabel(auction({ secType: "Note", securityTerm: "10-Year" }))).toBe("High yield");
  });

  test("keeps a zero indirect allocation as 0%, not unknown", () => {
    // A no-indirect auction is a real result and a notable one; "—" hides it.
    const zeroIndirect = auction({
      secType: "Bill",
      securityTerm: "4-Week",
      indirectAccepted: 0,
      competitiveAccepted: 50_000_000_000,
    });
    expect(indirectPct(zeroIndirect)).toBe(0);
    expect(visibleAuctions([zeroIndirect], {
      filter: "all",
      query: "",
      sort: { columnId: "indirect", direction: "desc" },
    })).toHaveLength(1);
  });

  test("indirect share is of competitive accepted, excluding SOMA and noncompetitive awards", () => {
    // 2026-09-22 2-Year: Treasury reports 57.8% indirect; total accepted
    // includes $10.4B of SOMA add-ons and would understate it at 49.3%.
    const filled = auction({
      secType: "Note",
      securityTerm: "2-Year",
      indirectAccepted: 39_116_326_000,
      competitiveAccepted: 67_685_935_200,
      totalAccepted: 79_388_014_800,
    });
    expect(indirectPct(filled)).toBeCloseTo(57.79, 1);
    expect(indirectPct(auction({ secType: "Note", securityTerm: "10-Year", competitiveAccepted: 0, indirectAccepted: 5 })))
      .toBeNull();
    expect(indirectPct(auction({ secType: "Note", securityTerm: "10-Year", competitiveAccepted: 100 }))).toBeNull();
  });

  test("takedown shares use competitive accepted, the way Treasury reports them", () => {
    // 2026-10-07 10-Year reopening: the three bidder classes add up to competitive accepted.
    const reopening = auction({
      secType: "Note",
      securityTerm: "9-Year 10-Month",
      competitiveAccepted: 38_665_438_000,
      indirectAccepted: 31_063_238_000,
      directAccepted: 6_618_200_000,
      primaryDealerAccepted: 984_000_000,
      totalAccepted: 39_926_321_900,
    });
    expect(indirectPct(reopening)).toBeCloseTo(80.34, 2);
    expect(directPct(reopening)).toBeCloseTo(17.12, 2);
    expect(dealerPct(reopening)).toBeCloseTo(2.545, 2);
    expect(directPct(auction({ secType: "Note", securityTerm: "2-Year", competitiveAccepted: 100 }))).toBeNull();
    expect(dealerPct(auction({ secType: "Note", securityTerm: "2-Year", primaryDealerAccepted: 0, competitiveAccepted: 100 }))).toBe(0);
  });

  test("stop-out vs average is the high rate minus the average/median, in basis points", () => {
    // 2026-10-07 10-Year reopening: 5.300% high yield against a 5.255% median.
    expect(stopOutVsAverageBp(auction({ secType: "Note", securityTerm: "9-Year 10-Month", highYield: 5.3, avgMedYield: 5.255 }))).toBe(4.5);
    expect(stopOutVsAverageBp(auction({ secType: "TIPS", securityTerm: "10-Year", highYield: 2.438, avgMedYield: 2.43 }))).toBe(0.8);
    // Bills trade on the discount rate, so that is the pair compared; the investment rate has no average.
    expect(stopOutVsAverageBp(auction({
      secType: "Bill", securityTerm: "4-Week",
      highInvestmentRate: 4.048, highDiscountRate: 3.98, avgMedDiscountRate: 3.91,
    }))).toBe(7);
    // A stop-out on the average is a real zero; a missing leg, an FRN or an unannounced result is unknown.
    expect(stopOutVsAverageBp(auction({ secType: "Bond", securityTerm: "30-Year", highYield: 5.1, avgMedYield: 5.1 }))).toBe(0);
    expect(stopOutVsAverageBp(auction({ secType: "Note", securityTerm: "10-Year", highYield: 4.6 }))).toBeNull();
    expect(stopOutVsAverageBp(auction({ secType: "FRN", securityTerm: "2-Year", highYield: 4.6, avgMedYield: 4.5 }))).toBeNull();
    expect(stopOutVsAverageBp(auction({ secType: "Bill", securityTerm: "13-Week", highInvestmentRate: 4.1 }))).toBeNull();
  });

  test("sizes completed and announced auctions by the offering, not SOMA-inflated accepted totals", () => {
    expect(auctionSize(auction({ secType: "Note", securityTerm: "2-Year", offeringAmount: 69e9, totalAccepted: 79.39e9 }))).toBe(69e9);
    expect(auctionSize(auction({ secType: "Note", securityTerm: "2-Year", totalAccepted: 79.39e9 }))).toBe(79.39e9);
  });

  test("flags announced auctions that have no published results", () => {
    expect(isPendingAuction(auction({ secType: "Bond", securityTerm: "20-Year" }))).toBe(true);
    expect(isPendingAuction(auction({ secType: "Bond", securityTerm: "20-Year", bidToCoverRatio: 2.4 }))).toBe(false);
  });
});

describe("filters", () => {
  test("groups CMBs with bills, FRNs with notes, and TIPS with bonds", () => {
    expect(matchesFilter(auction({ secType: "CMB", securityTerm: "42-Day" }), "bill")).toBe(true);
    expect(matchesFilter(auction({ secType: "FRN", securityTerm: "2-Year" }), "note")).toBe(true);
    expect(matchesFilter(auction({ secType: "TIPS", securityTerm: "10-Year" }), "bond")).toBe(true);
    expect(matchesFilter(auction({ secType: "TIPS", securityTerm: "10-Year" }), "note")).toBe(false);
    expect(matchesFilter(auction({ secType: "TIPS", securityTerm: "10-Year" }), "all")).toBe(true);
  });

  test("the filter key wraps through every tab", () => {
    expect(nextFilter("all")).toBe("bill");
    expect(nextFilter(nextFilter(nextFilter("bill")))).toBe("all");
  });
});

describe("visibleAuctions", () => {
  const rows = [
    auction({ secType: "Bill", securityTerm: "4-Week", auctionDate: "2026-08-17", highInvestmentRate: 3.9 }),
    auction({ secType: "Note", securityTerm: "10-Year", auctionDate: "2026-08-12", highYield: 4.683 }),
    auction({ secType: "Bond", securityTerm: "30-Year", auctionDate: "2026-08-14", highYield: 5.1 }),
  ];

  test("newest first by default", () => {
    expect(visibleAuctions(rows, { filter: "all", query: "", sort: DEFAULT_AUCTION_SORT })
      .map((row) => row.auctionDate)).toEqual(["2026-08-17", "2026-08-14", "2026-08-12"]);
  });

  test("term sort walks the curve, not the alphabet", () => {
    expect(visibleAuctions(rows, { filter: "all", query: "", sort: { columnId: "term", direction: "asc" } })
      .map((row) => row.securityTerm)).toEqual(["4-Week", "10-Year", "30-Year"]);
  });

  test("search matches type, term, and auction date", () => {
    const sort = DEFAULT_AUCTION_SORT;
    expect(visibleAuctions(rows, { filter: "all", query: "bill", sort })).toHaveLength(1);
    expect(visibleAuctions(rows, { filter: "all", query: "30-year", sort })).toHaveLength(1);
    expect(visibleAuctions(rows, { filter: "all", query: "2026-08-1", sort })).toHaveLength(3);
    expect(visibleAuctions(rows, { filter: "note", query: "bill", sort })).toHaveLength(0);
  });

  test("rows missing a metric sort last instead of jumping to the top", () => {
    const withPending = [...rows, auction({ secType: "Bond", securityTerm: "20-Year", auctionDate: "2026-08-19" })];
    const byRate = visibleAuctions(withPending, {
      filter: "all",
      query: "",
      sort: { columnId: "rate", direction: "desc" },
    });
    expect(byRate.at(-1)?.securityTerm).toBe("20-Year");
  });

  test("ascending and descending rates preserve negative zero and unknown values", () => {
    const input = [null, 0, -0.125, 2, null].map((highYield, index) => auction({
      secType: "Note", securityTerm: `${index + 1}-Year`, highYield, auctionDate: `2026-09-0${index + 1}`,
    }));
    const sorted = (direction: "asc" | "desc") => visibleAuctions(input, { filter: "all", query: "", sort: { columnId: "rate", direction } });
    expect(sorted("asc").map((row) => row.highYield)).toEqual([-0.125, 0, 2, null, null]);
    expect(sorted("desc").map((row) => row.highYield)).toEqual([2, 0, -0.125, null, null]);
    expect(sorted("asc").slice(-2).map((row) => row.auctionDate)).toEqual(["2026-09-05", "2026-09-01"]);
  });
});

describe("search", () => {
  const search = (rows: ReturnType<typeof auction>[], query: string) =>
    visibleAuctions(rows, { filter: "all", query, sort: DEFAULT_AUCTION_SORT });
  const dated = (secType: string, securityTerm: string, auctionDate: string, cusip: string | null = null) =>
    auction({ secType, securityTerm, auctionDate, cusip, id: `${cusip ?? secType}|${auctionDate}` });

  const rows = [
    dated("Note", "9-Year 10-Month", "2026-10-07", "91282CRF0"),
    dated("Note", "9-Year 11-Month", "2026-09-09", "91282CRF0"),
    dated("Note", "10-Year", "2026-08-12", "91282CNH3"),
    dated("TIPS", "10-Year", "2026-07-23", "91282CRE3"),
    dated("TIPS", "9-Year 10-Month", "2026-09-17", "91282CRG8"),
    dated("Bond", "29-Year 10-Month", "2026-10-08", "912810UW6"),
    dated("Bond", "30-Year", "2026-08-13", "912810UV8"),
    dated("Bond", "19-Year 11-Month", "2026-09-15", "912810UX4"),
    dated("FRN", "1-Year 10-Month", "2026-09-23", "91282CRD5"),
    dated("Note", "2-Year", "2026-09-22", "91282CRP8"),
    dated("Note", "4-Year 10-Month", "2026-08-26", "91282CRK9"),
    dated("Bill", "13-Week", "2026-10-05", "912797VT1"),
    dated("Bill", "52-Week", "2026-09-29", "912797WA1"),
  ];

  test("a benchmark finds the new issue and its reopenings, newest first, without TIPS or FRNs", () => {
    for (const query of ["10Y", "10y", "10yr", "10-Year", "10 year", " 10 YEAR "]) {
      expect(search(rows, query).map((row) => row.auctionDate)).toEqual(["2026-10-07", "2026-09-09", "2026-08-12"]);
    }
    expect(search(rows, "30y").map((row) => row.securityTerm)).toEqual(["29-Year 10-Month", "30-Year"]);
    expect(search(rows, "20y").map((row) => row.securityTerm)).toEqual(["19-Year 11-Month"]);
    expect(search(rows, "5y").map((row) => row.securityTerm)).toEqual(["4-Year 10-Month"]);
    // The 2-year FRN reopens as 1-Year 10-Month but is not the 2-year note.
    expect(search(rows, "2y").map((row) => row.secType)).toEqual(["Note"]);
  });

  test("naming TIPS or FRN asks for them, in either order", () => {
    expect(search(rows, "tips 10y").map((row) => row.cusip)).toEqual(["91282CRG8", "91282CRE3"]);
    expect(search(rows, "10 year tips").map((row) => row.cusip)).toEqual(["91282CRG8", "91282CRE3"]);
    expect(search(rows, "frn 2y").map((row) => row.cusip)).toEqual(["91282CRD5"]);
    expect(search(rows, "note 10y")).toHaveLength(3);
    expect(search(rows, "bond 10y")).toHaveLength(0);
  });

  test("bill and CMB benchmarks match their own term only", () => {
    expect(search(rows, "13w").map((row) => row.securityTerm)).toEqual(["13-Week"]);
    expect(search(rows, "52 week").map((row) => row.securityTerm)).toEqual(["52-Week"]);
  });

  test("a CUSIP matches whole or in part, in any case, and a reopening shares its original's", () => {
    expect(search(rows, "91282CRF0").map((row) => row.auctionDate)).toEqual(["2026-10-07", "2026-09-09"]);
    expect(search(rows, "91282crf0")).toHaveLength(2);
    expect(search(rows, "82CRF")).toHaveLength(2);
    expect(search(rows, "912810").map((row) => row.secType)).toEqual(["Bond", "Bond", "Bond"]);
    // Letters-only queries are words, not CUSIP fragments.
    expect(search(rows, "bill").map((row) => row.secType)).toEqual(["Bill", "Bill"]);
  });

  test("literal term and date text keep working", () => {
    expect(search(rows, "29-year 10-month")).toHaveLength(1);
    // A part of the term as written finds the reopening that carries it, TIPS aside.
    expect(search(rows, "9-year").map((row) => row.securityTerm)).toEqual(["9-Year 10-Month", "9-Year 11-Month"]);
    expect(search(rows, "10-month").map((row) => row.cusip)).toEqual(["912810UW6", "91282CRF0", "91282CRK9"]);
    expect(search(rows, "2026-10-0")).toHaveLength(3);
  });
});

describe("history windows", () => {
  test("the next window names where older auctions are, and the longest has none", () => {
    expect(nextAuctionHistoryWindow(120)).toBe(365);
    expect(nextAuctionHistoryWindow(365)).toBe(1825);
    expect(nextAuctionHistoryWindow(1825)).toBe(3650);
    expect(nextAuctionHistoryWindow(3650)).toBeNull();
  });

  test("a saved pane setting reaches every window and falls back on a value that is not one", () => {
    for (const days of AUCTION_HISTORY_WINDOWS) expect(auctionHistoryDays({ historyDays: String(days) })).toBe(days);
    expect(auctionHistoryDays({ historyDays: "7300" })).toBe(120);
    expect(auctionHistoryDays(undefined)).toBe(120);
  });
});
