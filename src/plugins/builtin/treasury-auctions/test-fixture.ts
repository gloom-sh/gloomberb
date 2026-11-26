import { parseTreasuryAuctionsPayload } from "./client";
import fiscalDataRecording from "./fixtures/fiscaldata-auctions-20261106.json";
import treasuryDirectRecording from "./fixtures/treasurydirect-search-20261106.json";
import { parseDirectAuctions } from "./treasury-direct";
import type { TreasuryAuction } from "./types";

/** A published auction with every metric unreported; a test overrides what it reads. */
export function auction(overrides: Partial<TreasuryAuction> & { secType: string; securityTerm: string }): TreasuryAuction {
  return {
    id: `${overrides.secType}|${overrides.auctionDate ?? "2026-08-12"}|${overrides.securityTerm}`,
    cusip: null,
    auctionDate: "2026-08-12",
    highInvestmentRate: null,
    highDiscountRate: null,
    avgMedDiscountRate: null,
    highYield: null,
    avgMedYield: null,
    highPrice: null,
    lowPrice: null,
    avgMedPrice: null,
    bidToCoverRatio: null,
    competitiveAccepted: null,
    indirectAccepted: null,
    directAccepted: null,
    primaryDealerAccepted: null,
    totalAccepted: null,
    offeringAmount: null,
    ...overrides,
  };
}

/**
 * Both feeds as recorded on 2026-11-06 (fixtures/), the day Fiscal Data's
 * auctions had no results after 2026-10-15 and no auction after 2026-10-22,
 * while TreasuryDirect listed the results through 2026-11-05 and the
 * auctions announced for 2026-11-09 to 2026-11-12.
 */
export const RECORDED_NOW = "2026-11-06T13:00:00Z";
export const recordedFiscalData = (): TreasuryAuction[] => parseTreasuryAuctionsPayload(fiscalDataRecording);
export const recordedTreasuryDirectBody = treasuryDirectRecording.securities;
export const recordedTreasuryDirect = (): TreasuryAuction[] => parseDirectAuctions(treasuryDirectRecording.securities);

export const EMPTY_HISTORY_NOW = "2026-11-26T06:00:00Z";
export const emptyHistoryPage = { data: [], meta: { count: 0, "total-count": 0, "total-pages": 0 } };
export const emptyHistoryRecentBody = [
  { cusip: "TESTBOND1", securityType: "Bond", securityTerm: "20-Year", competitiveAuctionCloseDate: "2026-11-18", highYield: "5.459", bidToCoverRatio: "2.63" },
  { cusip: "TESTNOTE1", securityType: "Note", securityTerm: "10-Year", competitiveAuctionCloseDate: "2026-11-10", highYield: "4.240" },
  { cusip: "TESTBILL1", securityType: "Bill", securityTerm: "4-Week", competitiveAuctionCloseDate: "2026-11-19", investmentRate: "3.915" },
  { cusip: "TESTNOTE2", securityType: "Note", securityTerm: "3-Year", competitiveAuctionCloseDate: "2026-12-08" },
];
export const emptyHistoryRecentAuctions = (): TreasuryAuction[] => parseDirectAuctions(emptyHistoryRecentBody);
