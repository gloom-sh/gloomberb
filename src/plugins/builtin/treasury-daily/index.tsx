import type { PluginModule } from "../plugin-module";
import { fixedIncomeShortcut } from "../fixed-income/shortcut";
import { treasuryDailyHeadless } from "./headless";
import { TREASURY_DAILY_PANE_ID } from "./model";

export const treasuryDailyModule: PluginModule = {
  paneTemplates: [fixedIncomeShortcut({
    id: "treasury-daily-pane",
    paneId: TREASURY_DAILY_PANE_ID,
    label: "Treasury Cash and Debt",
    description: "Treasury operating cash for the latest day with the Treasury General Account's closing balance history, and debt held by the public for the last 20 business days.",
    keywords: ["treasury", "dts", "debt", "cash", "tga", "debt to the penny", "operating cash"],
    shortcut: { prefix: "DTS" },
    headless: treasuryDailyHeadless,
    createInstance: () => ({ placement: "floating" }),
  }, "treasury", "cash-debt")],
};
