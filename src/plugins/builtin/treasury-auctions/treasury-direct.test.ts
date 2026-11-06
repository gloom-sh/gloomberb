import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { isPendingAuction } from "./model";
import { RECORDED_NOW, recordedFiscalData, recordedTreasuryDirect, recordedTreasuryDirectBody } from "./test-fixture";
import {
  buildDirectSearchUrl, directSearchRange, fetchDirectAuctions, normalizeDirectAuction, parseDirectAuctions,
} from "./treasury-direct";

afterEach(() => {
  setHttpFetchTransport(null);
  setSystemTime();
});

describe("TreasuryDirect securities", () => {
  test("every auction Fiscal Data lists with results reads the same from TreasuryDirect", () => {
    // The two feeds name the same figures differently (investmentRate, medianYield, subtotalCompetitiveParAwarded...);
    // this holds the mapping to what Fiscal Data published for the same CUSIP and day.
    const direct = new Map(recordedTreasuryDirect().map((auction) => [auction.id, auction]));
    const published = recordedFiscalData().filter((auction) => !isPendingAuction(auction));
    expect(published.length).toBeGreaterThan(5);
    for (const auction of published) expect(direct.get(auction.id)).toEqual(auction);
  });

  test("lists what Fiscal Data had not: results after its last row, and the auctions announced", () => {
    const fiscal = new Set(recordedFiscalData().map((auction) => auction.id));
    const added = recordedTreasuryDirect().filter((auction) => !fiscal.has(auction.id));
    const days = [...new Set(added.map((auction) => auction.auctionDate))].sort();
    expect(days).toEqual([
      "2026-10-21", "2026-10-22", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05",
      "2026-11-09", "2026-11-10", "2026-11-12",
    ]);
    // Results are in through 5 Nov; the three later days are announced and have none.
    const [announced, completed] = [added.filter((auction) => auction.auctionDate > "2026-11-05"), added.filter((auction) => auction.auctionDate <= "2026-11-05")];
    expect(completed.every((auction) => !isPendingAuction(auction))).toBe(true);
    expect(announced.map((auction) => auction.securityTerm)).toEqual(expect.arrayContaining(["3-Year", "10-Year", "30-Year"]));
    expect(announced.every(isPendingAuction)).toBe(true);
  });

  test("types a security as the board does: TIPS and FRN by their flags, a CMB as the bill Fiscal Data lists", () => {
    const base = { cusip: "912797XX9", securityType: "Bill", securityTerm: "10-Day", competitiveAuctionCloseDate: "2026-10-22T00:00:00" };
    expect(normalizeDirectAuction({ ...base, type: "CMB", cashManagementBill: "Yes", highRate: "3.925", medianRate: "3.900", investmentRate: "3.984" }))
      .toMatchObject({ secType: "Bill", highDiscountRate: 3.925, avgMedDiscountRate: 3.9, highInvestmentRate: 3.984 });
    expect(normalizeDirectAuction({ ...base, securityType: "Note", securityTerm: "5-Year", type: "TIPS", inflationProtected: "Yes", highYield: "2.367" }))
      .toMatchObject({ secType: "TIPS", highYield: 2.367, highDiscountRate: null });
    expect(normalizeDirectAuction({ ...base, securityType: "Note", securityTerm: "2-Year", type: "FRN", floatingRate: "Yes", highDiscountMargin: "0.038", highRate: "4.1" }))
      .toMatchObject({ secType: "FRN", highDiscountMargin: 0.038, highDiscountRate: null });
    expect(normalizeDirectAuction({ ...base, securityType: "Note", type: "Note", highRate: "" })?.secType).toBe("Note");
  });

  test("a figure not published is null, never zero, and a published zero stays zero", () => {
    const record = { cusip: "912810UY2", securityType: "Bond", securityTerm: "30-Year", competitiveAuctionCloseDate: "2026-11-12T00:00:00" };
    expect(normalizeDirectAuction({ ...record, highYield: "", bidToCoverRatio: "", offeringAmount: "25000000000", grandTotalParAwarded: "" }))
      .toMatchObject({ id: "912810UY2|2026-11-12", highYield: null, bidToCoverRatio: null, totalAccepted: null, offeringAmount: 25_000_000_000 });
    expect(normalizeDirectAuction({ ...record, highYield: "0.000", indirectBiddersCompetitiveParAwarded: "0" }))
      .toMatchObject({ highYield: 0, indirectAccepted: 0 });
  });

  test("a body that is not a list of securities is a failure, and a record it cannot identify is left out", () => {
    for (const body of [null, "<html>", { error: "boom" }]) expect(() => parseDirectAuctions(body)).toThrow("did not return a list");
    const row = recordedTreasuryDirectBody[0]!;
    const parsed = parseDirectAuctions([row, row, null, { ...row, cusip: "" }, { ...row, competitiveAuctionCloseDate: "" }, { ...row, securityType: "" }]);
    expect(parsed).toHaveLength(1);
  });
});

describe("TreasuryDirect search", () => {
  const now = Date.parse(RECORDED_NOW);

  test("reads at most the last 60 days and a month ahead, both ends inclusive", () => {
    expect(directSearchRange(120, now)).toEqual({ startDate: "2026-09-07", endDate: "2026-12-06" });
    expect(directSearchRange(30, now)).toEqual({ startDate: "2026-10-07", endDate: "2026-12-06" });
    const url = new URL(buildDirectSearchUrl(365, now));
    expect(url.origin + url.pathname).toBe("https://www.treasurydirect.gov/TA_WS/securities/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      startDate: "2026-09-07", endDate: "2026-12-06", dateFieldName: "competitiveAuctionCloseDate", format: "json",
    });
  });

  test("fetches and parses the search; a refusal keeps its status", async () => {
    setSystemTime(new Date(RECORDED_NOW));
    const requested: string[] = [];
    setHttpFetchTransport(async (url) => {
      requested.push(String(url));
      return Response.json(recordedTreasuryDirectBody);
    });
    expect((await fetchDirectAuctions(120)).map((auction) => auction.id)).toEqual(recordedTreasuryDirect().map((auction) => auction.id));
    expect(requested).toEqual([buildDirectSearchUrl(120, now)]);

    setHttpFetchTransport(async () => new Response("gone", { status: 404 }));
    const refused = await fetchDirectAuctions(120).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiRequestError);
    expect(refused).toMatchObject({ status: 404, message: "TreasuryDirect request failed (404)" });
  });
});
