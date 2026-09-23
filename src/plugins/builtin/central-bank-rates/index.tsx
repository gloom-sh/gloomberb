import type { PluginModule } from "../plugin-module";
import { centralBankRatesCache } from "./client";
import { centralBankRatesHeadless } from "./headless";
import { CentralBankRatesPane } from "./pane";

export const centralBankRatesModule: PluginModule = {
  panes: [{ id: "central-bank-rates", name: "Central Bank Rates", icon: "%", component: CentralBankRatesPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 108, height: 25 },
    tableExport: true, headless: centralBankRatesHeadless }],
  paneTemplates: [{
    id: "central-bank-rates-cbr", paneId: "central-bank-rates", label: "Central Bank Rates",
    description: "G20 policy rates, last observed changes and dated historical context.",
    keywords: ["central", "bank", "policy", "rates", "g20", "cbr", "ecfc", "cbrt"], shortcut: { prefix: "CBR", aliases: ["ECFC", "CBRT"] },
    headless: centralBankRatesHeadless,
  }],
  setup(ctx) { centralBankRatesCache.attach(ctx.persistence); },
  dispose() { centralBankRatesCache.reset(); },
};
