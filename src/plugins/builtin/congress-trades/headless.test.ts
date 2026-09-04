import { describe, expect, test } from "bun:test";
import type { CloudCongressHousePayload } from "../../../api-client";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createCongressHeadless } from "./headless";

const payload: CloudCongressHousePayload = {
  asOf: "2026-09-04T12:00:00.000Z",
  chamber: "house",
  source: "house-clerk",
  year: 2026,
  indexUpdatedAt: "2026-09-04T11:00:00.000Z",
  filingsScanned: 2,
  filingCount: 2,
  trades: [
    {
      id: "trade-1",
      chamber: "house",
      filingId: "filing-1",
      docId: "doc-1",
      memberName: "Nancy Pelosi",
      stateDistrict: "CA-11",
      filingDate: "2026-09-03",
      transactionDate: "2026-08-20",
      notificationDate: null,
      lagDays: 14,
      side: "BUY",
      transactionType: "Purchase",
      ticker: "NVDA",
      assetName: "NVIDIA Corporation",
      assetType: "Stock",
      owner: "SP",
      rawOwner: "Spouse",
      amount: "$1,000,001 - $5,000,000",
      amountLow: 1_000_001,
      amountHigh: 5_000_000,
      capGainsOver200: null,
      filingStatus: null,
      subholdingOf: null,
      description: null,
      sourceUrl: "https://disclosures-clerk.house.gov/filing-1",
    },
  ],
  members: [
    {
      id: "member-1",
      memberName: "Nancy Pelosi",
      stateDistrict: "CA-11",
      tradeCount: 12,
      buyCount: 8,
      sellCount: 4,
      exchangeCount: 0,
      otherCount: 0,
      estimatedLow: 2_000_000,
      estimatedHigh: 8_000_000,
      lastFilingDate: "2026-09-03",
      avgLagDays: 18,
    },
  ],
};

function context(): HeadlessPaneContext {
  return {
    marketData: createTestDataProvider(),
    apiClient: {} as HeadlessPaneContext["apiClient"],
    config: createDefaultConfig("/tmp/gloomberb-headless-congress"),
    signal: new AbortController().signal,
  };
}

function args(tab: "trades" | "members", limit = 50): HeadlessPaneLoadArgs {
  return { rawArgument: "", argument: null, symbols: [], options: { tab, year: 2026, limit } };
}

describe("congress headless model", () => {
  test("projects the active tab and applies its row limit", async () => {
    const headless = createCongressHeadless({ loadHouse: async () => payload });

    const trades = await headless.load(args("trades", 1), context());
    expect(trades.rows).toMatchObject([{
      memberName: "Nancy Pelosi",
      side: "BUY",
      ticker: "NVDA",
      amountLow: 1_000_001,
      amountHigh: 5_000_000,
    }]);
    expect(trades.columns?.map((column) => column.key)).toContain("ticker");

    const members = await headless.load(args("members", 1), context());
    expect(members.rows).toMatchObject([{
      memberName: "Nancy Pelosi",
      tradeCount: 12,
      buyCount: 8,
    }]);
    expect(members.columns?.map((column) => column.key)).toContain("tradeCount");
  });
});
