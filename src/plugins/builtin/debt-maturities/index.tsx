import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { fixedIncomeShortcut } from "../fixed-income/shortcut";
import { SEC_FILINGS_VIEW } from "../shared/report-freshness";
import { debtMaturitiesCache } from "./client";
import { debtMaturitiesHeadless } from "./headless";
import { DEBT_MATURITY_SERIES } from "./series";

export const debtMaturitiesModule: PluginModule = {
  series: DEBT_MATURITY_SERIES,
  paneTemplates: [
    fixedIncomeShortcut({
      ...createTickerSurfacePaneTemplate({
        id: "debt-maturities-pane",
        paneId: "debt-maturities",
        label: "Debt Maturities",
        description:
          "Principal maturity wall, concentration and dated annual filing history.",
        shortcut: "DDIS",
        keywords: ["debt", "maturity", "maturities", "refinancing", "ddis"],
        publicShare: true,
      }),
      headless: debtMaturitiesHeadless,
      reportFreshness: SEC_FILINGS_VIEW,
    }, "issuer-debt", "maturities"),
  ],
  setup(ctx) {
    debtMaturitiesCache.attach(ctx.persistence);
  },
  dispose() {
    debtMaturitiesCache.reset();
  },
};
