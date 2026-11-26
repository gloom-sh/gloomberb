import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { DILUTION_PANE_ID, DILUTION_TEMPLATE_ID, DilutionPane } from "./pane";

export const dilutionModule: PluginModule = {
  panes: [
    {
      id: DILUTION_PANE_ID,
      name: "Equity Dilution",
      icon: "D",
      component: DilutionPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 112, height: 32 },
      shareItem: { ticker: true },
      tickerFollower: true,
      tableExport: true,
    },
  ],
  paneTemplates: [
    {
      ...createTickerSurfacePaneTemplate({
        id: DILUTION_TEMPLATE_ID,
        paneId: DILUTION_PANE_ID,
        label: "Equity Dilution & Form 144",
        shortcut: "DILU",
        shortcutAliases: ["ATM", "F144", "SHELF"],
        description:
          "Active SEC shelves (S-3/S-3ASR/F-3), Rule 415 expiry, I.B.6 baby-shelf 1/3 cap, 424B5/424B7 ATM offerings, Form 144 insider sales, IPO lock-ups and HK CCASS physical deposits.",
        keywords: [
          "dilu",
          "dilution",
          "shelf",
          "s-3",
          "atm",
          "424b5",
          "form 144",
          "insider sales",
          "baby shelf",
          "lockup",
          "overhang",
        ],
        publicShare: true,
        settings: (_symbol, _context, createOptions) => {
          const arg = createOptions?.arg?.trim().toLowerCase();
          if (arg === "144" || arg === "form144" || arg === "scanner") {
            return { tab: "scanner" };
          }
          if (arg === "atm" || arg === "offerings") {
            return { tab: "offerings" };
          }
          return {};
        },
      }),
      canCreate: () => true,
      createInstance: (context, createOptions) => {
        const template = createTickerSurfacePaneTemplate({
          id: DILUTION_TEMPLATE_ID,
          paneId: DILUTION_PANE_ID,
          label: "Equity Dilution & Form 144",
          shortcut: "DILU",
          description: "Equity dilution, shelves, ATMs and Form 144.",
          keywords: ["dilu"],
        });
        return template.createInstance?.(context, createOptions) ?? {
          id: `${DILUTION_PANE_ID}-${Date.now()}`,
          paneId: DILUTION_PANE_ID,
          title: "Equity Dilution",
          settings: { tab: "scanner" },
        };
      },
    },
  ],
};
