import type { PluginModule } from "../plugin-module";
import { centralBankRatesCache } from "./client";
import { centralBankRatesHeadless } from "./headless";
import { CENTRAL_BANK_SERIES } from "./series";

export const centralBankRatesModule: PluginModule = {
  series: CENTRAL_BANK_SERIES,
  panes: [{ id: "central-bank-rates", name: "Central Bank Rates", icon: "%", get component(): typeof import("./pane").CentralBankRatesPane { const { CentralBankRatesPane } = require("./pane"); return CentralBankRatesPane; },
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 108, height: 25 },
    tableExport: true, headless: centralBankRatesHeadless }],
  paneTemplates: [{
    id: "central-bank-rates-cbr", paneId: "central-bank-rates", label: "Central Bank Rates",
    description: "Policy rates of the G20, SNB, Norges Bank, Riksbank and RBNZ, last observed changes and dated historical context.",
    keywords: ["central", "bank", "policy", "rates", "g20", "cbr", "cbrt"], shortcut: { prefix: "CBR", aliases: ["CBRT"] },
    headless: centralBankRatesHeadless,
  }],
  setup(ctx) { centralBankRatesCache.attach(ctx.persistence); },
  dispose() { centralBankRatesCache.reset(); },
};
