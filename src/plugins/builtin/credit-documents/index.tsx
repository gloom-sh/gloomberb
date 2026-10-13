import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { fixedIncomeShortcut } from "../fixed-income/shortcut";
import { creditCache } from "./client";
import { creditHeadless, covenantsHeadless } from "./headless";

export const creditDocumentsModule: PluginModule = {
  setup(ctx) { creditCache.attach(ctx.persistence); },
  dispose() { creditCache.reset(); },
  paneTemplates: [
    fixedIncomeShortcut({
      ...createTickerSurfacePaneTemplate({
        id: "credit-documents-pane",
        paneId: "credit-documents",
        label: "Credit Documents",
        description: "Pro credit documents: capital structure, covenant headroom, maturities and amendment evidence. Free preview available.",
        keywords: ["credit", "covenants", "capital structure", "headroom", "bonds", "indentures", "maturities", "cast"],
        shortcut: "CRDOC",
      }),
      headless: creditHeadless,
    }, "issuer-debt", "documents"),
    fixedIncomeShortcut({
      ...createTickerSurfacePaneTemplate({
        id: "credit-covenants-pane",
        paneId: "credit-documents",
        label: "Covenants",
        description: "Pro covenant thresholds, supported headroom and credit-document evidence. Free preview available.",
        keywords: ["covenants", "headroom", "credit tests", "maintenance"],
        shortcut: "COVN",
        viewKey: "covenants",
        settings: () => ({ tab: "covenants" }),
      }),
      headless: covenantsHeadless,
    }, "issuer-debt", "documents"),
  ],
};
