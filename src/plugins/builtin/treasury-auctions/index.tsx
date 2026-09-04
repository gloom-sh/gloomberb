import type { PaneSettingsDef } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import {
  attachTreasuryAuctionsPersistence,
  resetTreasuryAuctionsPersistence,
  TREASURY_FISCAL_DATA_CONNECTION_ID,
} from "./cache";
import { TreasuryAuctionsPane } from "./pane";
import { TREASURY_AUCTIONS_PANE_ID } from "./types";
import { createPublicPaneShare } from "../shared/public-pane";
import { treasuryAuctionsHeadless } from "./headless";

export { treasuryAuctionsHeadless } from "./headless";

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
        options: [
          { value: "30", label: "30 days" },
          { value: "90", label: "90 days" },
          { value: "120", label: "120 days" },
          { value: "365", label: "1 year" },
        ],
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
      ownerId: "macro",
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
      defaultFloatingSize: { width: 92, height: 28 },
      tableExport: true,
      settings: treasuryAuctionsSettings(),
    },
  ],

  paneTemplates: [
    {
      id: "treasury-auctions-pane",
      paneId: TREASURY_AUCTIONS_PANE_ID,
      label: "Treasury Auctions",
      description:
        "Bill, note, bond, and TIPS auction results from Treasury Fiscal Data: high rate, bid-to-cover, indirect share, and size.",
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
        "issuance",
      ],
      shortcut: { prefix: "AUCT" },
      headless: treasuryAuctionsHeadless,
      createInstance: () => ({ placement: "floating" }),
      publicShare: createPublicPaneShare("Treasury Auctions"),
    },
  ],
};
