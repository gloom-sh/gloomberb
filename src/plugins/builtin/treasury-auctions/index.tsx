import type { PaneSettingsDef } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import {
  attachTreasuryAuctionsPersistence,
  resetTreasuryAuctionsPersistence,
  TREASURY_FISCAL_DATA_CONNECTION_ID,
} from "./cache";
import { TreasuryAuctionsPane } from "./pane";
import { TREASURY_AUCTIONS_PANE_ID } from "./types";
import { AUCTION_HISTORY_WINDOWS, auctionHistoryLabel } from "./model";
import { createPublicPaneShare } from "../shared/public-pane";
import { treasuryAuctionsHeadless } from "./headless";


let disposeConnection: (() => void) | null = null;

function treasuryAuctionsSettings(): PaneSettingsDef {
  return {
    title: "Treasury Auctions Settings",
    fields: [
      {
        key: "historyDays",
        label: "History window",
        description: "How far back auction results are requested.",
        type: "select",
        options: AUCTION_HISTORY_WINDOWS.map((days) => ({ value: String(days), label: auctionHistoryLabel(days) })),
      },
    ],
  };
}

export const treasuryAuctionsModule: PluginModule = {
  setup(ctx) {
    attachTreasuryAuctionsPersistence(ctx.persistence, ctx.connectionHealth);
    disposeConnection = ctx.connectionHealth.registerSource({
      id: TREASURY_FISCAL_DATA_CONNECTION_ID,
      name: "Treasury Fiscal Data",
      kind: "api",
      ownerId: "credit",
      priority: 300,
      detail: "fiscaldata.treasury.gov",
    });
  },

  dispose() {
    disposeConnection?.();
    disposeConnection = null;
    resetTreasuryAuctionsPersistence();
  },

  panes: [
    {
      id: TREASURY_AUCTIONS_PANE_ID,
      name: "Treasury Auctions",
      icon: "A",
      component: TreasuryAuctionsPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 104, height: 28 },
      tableExport: true,
      reportFreshness: { source: "US Treasury", status: "not-a-feed", basis: "auction results" },
      settings: treasuryAuctionsSettings(),
    },
  ],

  paneTemplates: [
    {
      id: "treasury-auctions-pane",
      paneId: TREASURY_AUCTIONS_PANE_ID,
      label: "Treasury Auctions",
      description:
        "Bill, note, bond, and TIPS auction results from Treasury Fiscal Data: rate, stop-out versus average, bid-to-cover, indirect, direct and dealer takedown, and size. Search by benchmark (10Y) or CUSIP.",
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
        "cusip",
        "reopening",
        "issuance",
      ],
      shortcut: { prefix: "AUCT" },
      headless: treasuryAuctionsHeadless,
      createInstance: () => ({ placement: "floating" }),
      publicShare: createPublicPaneShare("Treasury Auctions"),
    },
  ],
};
