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
