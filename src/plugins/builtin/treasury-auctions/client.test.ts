import { describe, expect, test } from "bun:test";
import { buildAuctionsUrl, normalizeAuction, parseTreasuryAuctionsPayload } from "./client";

// Shape captured from the live auctions_query endpoint on 2026-08-18.
const LIVE_NOTE_ROW = {
  security_type: "Note",
  security_term: "10-Year",
  auction_date: "2026-08-12",
  high_investment_rate: "null",
  high_yield: "4.6830",
  avg_med_yield: "4.630000",
  high_price: "99.540696",
  low_price: "null",
  avg_med_price: "null",
  bid_to_cover_ratio: "2.530000",
  comp_accepted: "41821613600",
  indirect_bidder_accepted: "32087936000",
  primary_dealer_accepted: "3597810000",
  total_accepted: "52623557100",
  offering_amt: "42000000000",
};

describe("normalizeAuction", () => {
  test("parses a live note row into numbers", () => {
    const auction = normalizeAuction(LIVE_NOTE_ROW);
    expect(auction).toMatchObject({
      id: "Note|2026-08-12|10-Year",
      secType: "Note",
      securityTerm: "10-Year",
      highYield: 4.683,
      avgMedYield: 4.63,
      bidToCoverRatio: 2.53,
      totalAccepted: 52_623_557_100,
      offeringAmount: 42_000_000_000,
    });
  });

  test("turns the API's literal \"null\" strings into null, not NaN", () => {
    // Every metric arrives as a string, and unreported ones arrive as "null".
    const auction = normalizeAuction(LIVE_NOTE_ROW)!;
    expect(auction.highInvestmentRate).toBeNull();
    expect(auction.lowPrice).toBeNull();
    expect(auction.avgMedPrice).toBeNull();
  });

  test("keeps announced auctions whose results are not published yet", () => {
    const auction = normalizeAuction({
      security_type: "Bond",
      security_term: "29-Year 6-Month",
      auction_date: "2026-08-20",
      high_yield: "null",
      bid_to_cover_ratio: "null",
    });
    expect(auction).toMatchObject({ secType: "Bond", highYield: null, bidToCoverRatio: null });
  });

  test("drops rows without the identity fields and tolerates junk", () => {
    expect(normalizeAuction({ security_term: "4-Week", auction_date: "2026-08-17" })).toBeNull();
    expect(normalizeAuction({ security_type: "Bill", security_term: "4-Week" })).toBeNull();
    expect(normalizeAuction(null)).toBeNull();
    expect(normalizeAuction("Bill")).toBeNull();
    expect(normalizeAuction({ security_type: "Bill", auction_date: "2026-08-17" })?.securityTerm).toBe("—");
  });
});

describe("parseTreasuryAuctionsPayload", () => {
  test("skips unusable rows instead of failing the whole payload", () => {
    const auctions = parseTreasuryAuctionsPayload({
      data: [LIVE_NOTE_ROW, { security_type: "" }, null, { security_type: "Bill", auction_date: "2026-08-17" }],
    });
    expect(auctions.map((auction) => auction.secType)).toEqual(["Note", "Bill"]);
  });

  test("collapses repeated (type, date, term) rows", () => {
    const auctions = parseTreasuryAuctionsPayload({ data: [LIVE_NOTE_ROW, { ...LIVE_NOTE_ROW }] });
    expect(auctions).toHaveLength(1);
  });

  test("returns nothing for a body that is not a data array", () => {
    expect(parseTreasuryAuctionsPayload({ error: "boom" })).toEqual([]);
    expect(parseTreasuryAuctionsPayload(null)).toEqual([]);
    expect(parseTreasuryAuctionsPayload("<html>")).toEqual([]);
  });
});

describe("buildAuctionsUrl", () => {
  test("requests a bounded window with encoded pagination brackets", () => {
    const url = buildAuctionsUrl(30, Date.parse("2026-08-18T00:00:00Z"));
    expect(url).toContain("filter=auction_date:gte:2026-07-19");
    expect(url).toContain("sort=-auction_date");
    expect(url).toContain("page%5Bsize%5D=");
    expect(url).not.toContain("page[size]");
  });
});
