import type { PluginModule } from "../plugin-module";
import { CdxPane } from "./cdx-pane";
import { cdxBoardCache, sovrBoardCache } from "./client";
import { cdxHeadless, sovrHeadless } from "./headless";
import { CDX_PANE_ID, SOVR_PANE_ID } from "./model";
import { SovrPane } from "./sovr-pane";

export const creditBoardsModule: PluginModule = {
  panes: [
    {
      id: CDX_PANE_ID,
      name: "Index CDS",
      icon: "X",
      component: CdxPane,
      defaultPosition: "right",
      defaultMode: "floating",
      // Five indexes under their history, like Credit Spreads.
      defaultFloatingSize: { width: 92, height: 20 },
      tableExport: true,
      headless: cdxHeadless,
    },
    {
      id: SOVR_PANE_ID,
      name: "Sovereign CDS",
      icon: "S",
      component: SovrPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 96, height: 28 },
      tableExport: true,
      headless: sovrHeadless,
    },
  ],
  paneTemplates: [
    {
      id: "cdx-pane",
      paneId: CDX_PANE_ID,
      label: "Index CDS",
      description: "CDX IG, HY, EM, iTraxx Main and Crossover on the run from DTCC public dissemination: level, 1D and 1W moves, 1Y rank.",
      keywords: ["cdx", "itraxx", "crossover", "xover", "index", "cds", "credit", "ig", "hy", "em", "spread", "dtcc"],
      shortcut: { prefix: "CDX" },
      headless: cdxHeadless,
    },
    {
      id: "sovr-pane",
      paneId: SOVR_PANE_ID,
      label: "Sovereign CDS",
      description: "Sovereign 5Y CDS from DTCC public dissemination, ranked by the month's move, beside each local currency's month.",
      keywords: ["sovr", "wcds", "sovereign", "country", "cds", "credit", "em", "emerging", "spread", "dtcc"],
      shortcut: { prefix: "SOVR", aliases: ["WCDS"] },
      headless: sovrHeadless,
    },
  ],
  setup(ctx) {
    cdxBoardCache.attach(ctx.persistence);
    sovrBoardCache.attach(ctx.persistence);
  },
  dispose() {
    cdxBoardCache.reset();
    sovrBoardCache.reset();
  },
};
