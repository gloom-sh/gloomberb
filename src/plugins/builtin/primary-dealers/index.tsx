import type { PluginModule } from "../plugin-module";
import { fixedIncomeShortcut } from "../fixed-income/shortcut";
import { primaryDealersHeadless } from "./headless";
import { PRIMARY_DEALERS_PANE_ID } from "./model";

export const primaryDealersModule: PluginModule = {
  paneTemplates: [fixedIncomeShortcut({
    id: "primary-dealers-pane",
    paneId: PRIMARY_DEALERS_PANE_ID,
    label: "Primary Dealer Positions",
    description: "Weekly net positions with history, by sector and Treasury tenor, and settlement fails.",
    // No "muni": a muni search lands on DVD's muni funds alone (known-gaps.test.ts), not on a table of two functions.
    keywords: ["primary", "dealer", "dealers", "positions", "fails", "treasury", "bills", "coupons", "tips", "frn", "mbs", "pdlr"],
    shortcut: { prefix: "PDLR" },
    headless: primaryDealersHeadless,
    createInstance: () => ({ placement: "floating" }),
  }, "treasury", "dealers")],
};
