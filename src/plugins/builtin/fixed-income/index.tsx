import type { PluginModule } from "../plugin-module";
import { treasuryAuctionsSettings } from "../treasury-auctions";
import { FIXED_INCOME_PANE_ID } from "./model";

export const fixedIncomeModule: PluginModule = {
  panes: [{
    id: FIXED_INCOME_PANE_ID,
    name: "Fixed Income",
    icon: "B",
    get component(): typeof import("./pane").FixedIncomePane { const { FixedIncomePane } = require("./pane"); return FixedIncomePane; },
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 116, height: 32 },
    tickerFollower: true,
    tableExport: true,
    settings: {
      title: "Fixed Income Settings",
      fields: [
        {
          key: "region",
          label: "Credit spread region",
          type: "select",
          options: [
            { value: "all", label: "All" },
            { value: "us", label: "US" },
            { value: "euro", label: "Euro" },
          ],
        },
        ...treasuryAuctionsSettings().fields,
      ],
    },
  }],
  paneTemplates: [{
    id: "fixed-income-pane",
    paneId: FIXED_INCOME_PANE_ID,
    label: "Fixed Income",
    description: "Credit markets, issuer debt, corporate bonds, Treasury auctions and debt, and dealer positions.",
    keywords: ["fixed income", "bonds", "credit", "treasury", "cds", "debt", "rates", "dealer"],
    shortcut: { prefix: "FI" },
    createInstance: (context) => ({
      instanceId: context.layout.instances.find((instance) => instance.paneId === FIXED_INCOME_PANE_ID)?.instanceId ?? FIXED_INCOME_PANE_ID,
      placement: "floating",
    }),
  }],
};
