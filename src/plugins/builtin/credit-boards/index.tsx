import type { PluginModule } from "../plugin-module";
import { fixedIncomeShortcut } from "../fixed-income/shortcut";
import { cdxBoardCache, sovrBoardCache } from "./client";
import { cdxHeadless, sovrHeadless } from "./headless";
import { CREDIT_BOARD_SERIES } from "./series";

export const creditBoardsModule: PluginModule = {
  series: CREDIT_BOARD_SERIES,
  paneTemplates: [
    {
      ...fixedIncomeShortcut({
        id: "cdx-pane",
        paneId: "cdx-board",
        label: "Index CDS",
        description: "CDX IG, HY, EM, iTraxx Main and Crossover on the run from DTCC public dissemination: level, 1D and 1W moves, 1Y rank. Sovereign CDS is the other tab.",
        keywords: ["cdx", "itraxx", "crossover", "xover", "index", "cds", "credit", "ig", "hy", "em", "spread", "dtcc"],
        shortcut: { prefix: "CDX" },
        headless: cdxHeadless,
        createInstance: () => ({ placement: "floating" }),
      }, "credit", "index"),
    },
    {
      ...fixedIncomeShortcut({
        id: "sovr-pane",
        paneId: "cdx-board",
        label: "Sovereign CDS",
        description: "The CDS pane on Sovereign: 5Y CDS from DTCC public dissemination, ranked by the month's move, beside each local currency's month.",
        keywords: ["sovr", "wcds", "sovereign", "country", "cds", "credit", "em", "emerging", "spread", "dtcc"],
        shortcut: { prefix: "SOVR", aliases: ["WCDS"] },
        headless: sovrHeadless,
        createInstance: () => ({ placement: "floating" }),
      }, "credit", "sovereign"),
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
