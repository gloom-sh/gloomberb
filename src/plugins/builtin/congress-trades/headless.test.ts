import { describe, expect, test } from "bun:test";
import type { CloudCongressHousePayload } from "../../../api-client";
import type { HeadlessPaneContext } from "../../../types/plugin";
import { createCongressHeadless } from "./headless";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";

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

function args(tab: "trades" | "members", limit = 50) {
  return createTestHeadlessArgs({ options: { tab, year: 2026, limit } });
}

describe("congress headless model", () => {
  test("passes ticker and both cursors to the server without hiding source gaps", async () => {
    let requested: unknown;
    const ctx = createTestHeadlessContext();
    ctx.apiClient = { getCloudCongressHouse: async (params: unknown) => {
      requested = params;
      return { ...payload, filingsPending: 3, hasMoreFilings: true, nextFilingOffset: 120 };
    } } as HeadlessPaneContext["apiClient"];
    const result = await createCongressHeadless().load({
      ...args("trades"), argument: "NVDA", symbols: ["NVDA"],
      options: { ...args("trades").options, offset: 20, filingOffset: 60 },
    }, ctx);
    expect(requested).toMatchObject({ ticker: "NVDA", offset: 20, filingOffset: 60 });
    expect(result.metadata).toMatchObject({ filingsPending: 3, hasMoreFilings: true, nextFilingOffset: 120 });
  });

  test("projects the active tab and applies its row limit", async () => {
    const headless = createCongressHeadless({ loadHouse: async () => payload });

    const trades = await headless.load(args("trades", 1), createTestHeadlessContext());
    expect(trades.rows).toMatchObject([{
      memberName: "Nancy Pelosi",
      side: "BUY",
      ticker: "NVDA",
      amountLow: 1_000_001,
      amountHigh: 5_000_000,
    }]);
    expect(trades.columns?.map((column) => column.key)).toContain("ticker");

    const members = await headless.load(args("members", 1), createTestHeadlessContext());
    expect(members.rows).toMatchObject([{
      memberName: "Nancy Pelosi",
      tradeCount: 12,
      buyCount: 8,
    }]);
    expect(members.columns?.map((column) => column.key)).toContain("tradeCount");
  });

  // `fn CG SHLS` said "No data for SHLS: not covered by CG." for a window with no SHLS trade, where the pane says
  // "No matching trades in this filing window.": an empty window is the window's answer, not missing coverage.
  test("a ticker with no trades in the window says so, with the next window, and never that it is not covered", async () => {
    const window = { ...payload, trades: [], members: [], filingsScanned: 60, filingCount: 812, hasMoreFilings: true, nextFilingOffset: 60 };
    const headless = createCongressHeadless({ loadHouse: async () => window });
    const asked = { ...args("trades"), argument: "SHLS", rawArgument: "SHLS", symbols: ["SHLS"] };
    const result = await headless.load(asked, createTestHeadlessContext());
    expect(result.unavailableSymbols).toEqual([]);
    const text = renderHeadlessPaneText(headless, result, asked, "Congress Trades | Trades", undefined, "CG");
    expect(text).toContain("No matching trades in SHLS in this filing window (2026 filings 1-60 of 812).");
    expect(text).toContain("gloom fn CG SHLS --year 2026 --filingOffset 60");
    expect(text).not.toContain("not covered");
    // The year's last window points at the year before.
    const lastWindow = createCongressHeadless({ loadHouse: async () => ({ ...window, hasMoreFilings: false, filingOffset: 780, filingsScanned: 32 }) });
    expect((await lastWindow.load(asked, createTestHeadlessContext())).empty)
      .toBe("No matching trades in SHLS in this filing window (2026 filings 781-812 of 812).\nThat was the year's last window; the year before: gloom fn CG SHLS --year 2025");
  });
});
