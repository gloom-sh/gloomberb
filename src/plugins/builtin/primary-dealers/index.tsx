import type { PluginModule } from "../plugin-module";
import { fixedIncomeShortcut } from "../fixed-income/shortcut";
import { primaryDealersHeadless } from "./headless";
import { PRIMARY_DEALERS_PANE_ID } from "./model";

export const primaryDealersModule: PluginModule = {
  paneTemplates: [fixedIncomeShortcut({
    id: "primary-dealers-pane",
    paneId: PRIMARY_DEALERS_PANE_ID,
    label: "Primary Dealer Positions",
    description: "Weekly net positions and settlement fails in Treasuries and mortgage-backed securities.",
    keywords: ["primary", "dealer", "dealers", "positions", "fails", "treasury", "tips", "mbs", "pdlr"],
    shortcut: { prefix: "PDLR" },
    headless: primaryDealersHeadless,
    createInstance: () => ({ placement: "floating" }),
  }, "treasury", "dealers")],
};
