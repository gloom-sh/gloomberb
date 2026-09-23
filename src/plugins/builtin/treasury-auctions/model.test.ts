import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AUCTION_SORT,
  auctionSize,
  formatAuctionRate,
  indirectPct,
  isPendingAuction,
  matchesFilter,
  nextAuctionSort,
  nextFilter,
  rateValue,
  termLengthDays,
  visibleAuctions,
} from "./model";
import type { TreasuryAuction } from "./types";

function auction(overrides: Partial<TreasuryAuction> & { secType: string; securityTerm: string }): TreasuryAuction {
  return {
    id: `${overrides.secType}|${overrides.auctionDate ?? "2026-08-12"}|${overrides.securityTerm}`,
    auctionDate: "2026-08-12",
    highInvestmentRate: null,
    highYield: null,
    avgMedYield: null,
    highPrice: null,
    lowPrice: null,
    avgMedPrice: null,
    bidToCoverRatio: null,
    competitiveAccepted: null,
    indirectAccepted: null,
    primaryDealerAccepted: null,
    totalAccepted: null,
    offeringAmount: null,
    ...overrides,
  };
}

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

describe("nextAuctionSort", () => {
  test("toggles direction on the active column and picks a sane default per column", () => {
    expect(nextAuctionSort(DEFAULT_AUCTION_SORT, "date")).toEqual({ columnId: "date", direction: "asc" });
    expect(nextAuctionSort(DEFAULT_AUCTION_SORT, "btc")).toEqual({ columnId: "btc", direction: "desc" });
    expect(nextAuctionSort(DEFAULT_AUCTION_SORT, "term")).toEqual({ columnId: "term", direction: "asc" });
  });
});
