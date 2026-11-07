import type { PaneSettingsDef } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { fixedIncomeShortcut } from "../fixed-income/shortcut";
import {
  attachTreasuryAuctionsPersistence,
  resetTreasuryAuctionsPersistence,
  TREASURY_DIRECT_CONNECTION_ID,
  TREASURY_FISCAL_DATA_CONNECTION_ID,
} from "./cache";
import { AUCTION_HISTORY_WINDOWS, auctionCommandRequest, auctionHistoryLabel } from "./model";
import { AUCTION_HISTORY_DAYS } from "./client";
import { createPublicPaneShare } from "../shared/public-pane";
import { treasuryAuctionsHeadless } from "./headless";


let disposeConnections: Array<() => void> = [];

export function treasuryAuctionsSettings(): PaneSettingsDef {
  return {
    title: "Treasury Auctions Settings",
    fields: [
      {
        key: "historyDays",
        label: "History window",
        description: "How far back auction results are requested.",
        type: "select",
        options: AUCTION_HISTORY_WINDOWS.map((days) => ({ value: String(days), label: auctionHistoryLabel(days) })),
        defaultValue: String(AUCTION_HISTORY_DAYS),
      },
    ],
  };
}

export const treasuryAuctionsModule: PluginModule = {
  setup(ctx) {
    attachTreasuryAuctionsPersistence(ctx.persistence, ctx.connectionHealth);
    disposeConnections = [
      ctx.connectionHealth.registerSource({
        id: TREASURY_FISCAL_DATA_CONNECTION_ID,
        name: "Treasury Fiscal Data",
        kind: "api",
        ownerId: "credit",
        priority: 300,
        detail: "fiscaldata.treasury.gov",
      }),
      ctx.connectionHealth.registerSource({
        id: TREASURY_DIRECT_CONNECTION_ID,
        name: "TreasuryDirect",
        kind: "api",
        ownerId: "credit",
        priority: 301,
        detail: "treasurydirect.gov",
      }),
    ];
  },

  dispose() {
    for (const dispose of disposeConnections) dispose();
    disposeConnections = [];
    resetTreasuryAuctionsPersistence();
  },

  paneTemplates: [
    {
      ...fixedIncomeShortcut({
        id: "treasury-auctions-pane",
        paneId: "treasury-auctions",
        label: "Treasury Auctions",
        description:
          "Bill, note, bond and TIPS auction results since 1979, from Treasury Fiscal Data and TreasuryDirect: rate, stop-out versus median, bid-to-cover, bidder takedown and size; an after view ranks each auction against its tenor and shows the yield's moves after it. Search by benchmark (10Y) or CUSIP.",
        keywords: [
          "treasury",
          "auction",
          "auctions",
          "bills",
          "notes",
          "bonds",
          "tips",
          "frn",
          "bid",
          "cover",
          "indirect",
          "takedown",
          "tail",
          "stop-out",
          "stop out",
          "treasury auction",
          "bond auction",
          "note auction",
          "bill auction",
          "auction results",
          "10 year auction",
          "30 year auction",
          "percentile",
          "cusip",
          "reopening",
          "issuance",
        ],
        shortcut: { prefix: "AUCT", argKind: "text", argOptional: true, argPlaceholder: "search" },
        headless: treasuryAuctionsHeadless,
        createInstance: (_context, options) => {
          const { params, settings } = auctionCommandRequest(options?.arg);
          return { placement: "floating", params, ...(settings ? { settings } : {}) };
        },
        publicShare: createPublicPaneShare("Treasury Auctions"),
      }, "treasury", "auctions"),
    },
  ],
};
