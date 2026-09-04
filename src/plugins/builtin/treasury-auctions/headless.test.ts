import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createTreasuryAuctionsHeadless } from "./headless";
import type { TreasuryAuction } from "./types";

const bill: TreasuryAuction = {
  id: "bill", cusip: "A", secType: "Bill", securityTerm: "4-Week", auctionDate: "2026-09-03",
  highInvestmentRate: 4.1, highYield: null, avgMedYield: null, highPrice: null, lowPrice: null,
  avgMedPrice: null, bidToCoverRatio: 2.8, competitiveAccepted: 80, indirectAccepted: 20,
  primaryDealerAccepted: 10, totalAccepted: 100, offeringAmount: 100,
};
const bond: TreasuryAuction = { ...bill, id: "bond", cusip: "B", secType: "Bond", securityTerm: "30-Year" };

function args(filter: string): HeadlessPaneLoadArgs {
  return { rawArgument: "", argument: null, symbols: [], options: { historyDays: "90", filter } };
}

describe("treasury auctions headless model", () => {
  test("applies history and security filters to derived auction rows", async () => {
    const requested: number[] = [];
    const headless = createTreasuryAuctionsHeadless({
      load: async (_args, historyDays) => {
        requested.push(historyDays);
        return { auctions: [bill, bond], fetchedAt: 123, stale: false };
      },
    });

    const all = await headless.load(args("all"), {} as HeadlessPaneContext);
    const bonds = await headless.load(args("bond"), {} as HeadlessPaneContext);
    expect(all.rows).toHaveLength(2);
    expect(bonds.rows).toEqual([expect.objectContaining({ id: "bond", rate: 4.1, indirectPercent: 20 })]);
    expect(requested).toEqual([90, 90]);
  });
});
