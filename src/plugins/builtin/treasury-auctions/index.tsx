import type { PluginModule } from "../plugin-module";
import {
  attachTreasuryAuctionsPersistence,
  resetTreasuryAuctionsPersistence,
  TREASURY_FISCAL_DATA_CONNECTION_ID,
} from "./cache";
import { TreasuryAuctionsPane } from "./pane";
import { TREASURY_AUCTIONS_PANE_ID } from "./types";

let disposeConnection: (() => void) | null = null;

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
      createInstance: () => ({ placement: "floating" }),
    },
  ],
};
