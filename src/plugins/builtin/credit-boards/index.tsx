import type { PaneTemplateContext, PaneTemplateInstanceConfig } from "../../../types/plugin";
import { commandTabParams } from "../shared/command-tab";
import type { PluginModule } from "../plugin-module";
import { cdxBoardCache, sovrBoardCache } from "./client";
import { cdxHeadless, sovrHeadless } from "./headless";
import { CDX_PANE_ID } from "./model";
import { CreditBoardsPane } from "./pane";
import { CREDIT_BOARD_SERIES } from "./series";

/** One board. A later command retargets this instance; a fresh id would open a second window. */
function openCreditBoard(context: PaneTemplateContext, tab: "index" | "sovereign"): PaneTemplateInstanceConfig {
  const existing = context.layout.instances.find((instance) => instance.paneId === CDX_PANE_ID);
  return {
    instanceId: existing?.instanceId ?? CDX_PANE_ID,
    params: commandTabParams(tab),
  };
}

export const creditBoardsModule: PluginModule = {
  series: CREDIT_BOARD_SERIES,
  panes: [
    {
      id: CDX_PANE_ID,
      // The single-name pane already opens titled "CDS".
      name: "CDS Boards",
      icon: "X",
      component: CreditBoardsPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 96, height: 28 },
      tableExport: true,
    },
  ],
  paneTemplates: [
    {
      id: "cdx-pane",
      paneId: CDX_PANE_ID,
      label: "Index CDS",
      description: "CDX IG, HY, EM, iTraxx Main and Crossover on the run from DTCC public dissemination: level, 1D and 1W moves, 1Y rank. Sovereign CDS is the other tab.",
      keywords: ["cdx", "itraxx", "crossover", "xover", "index", "cds", "credit", "ig", "hy", "em", "spread", "dtcc"],
      shortcut: { prefix: "CDX" },
      headless: cdxHeadless,
      createInstance: (context) => openCreditBoard(context, "index"),
    },
    {
      id: "sovr-pane",
      paneId: CDX_PANE_ID,
      label: "Sovereign CDS",
      description: "The CDS pane on Sovereign: 5Y CDS from DTCC public dissemination, ranked by the month's move, beside each local currency's month.",
      keywords: ["sovr", "wcds", "sovereign", "country", "cds", "credit", "em", "emerging", "spread", "dtcc"],
      shortcut: { prefix: "SOVR", aliases: ["WCDS"] },
      headless: sovrHeadless,
      createInstance: (context) => openCreditBoard(context, "sovereign"),
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
