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
