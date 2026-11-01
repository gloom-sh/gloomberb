import type { PluginModule } from "../plugin-module";
import { cryptoEtfFlowsCache } from "./client";
import { cryptoEtfFlowsHeadless } from "./headless";
import { CRYPTO_ETF_FLOWS_PANE_ID } from "./model";

/** ETFF: the daily net flows of the US spot bitcoin and ether ETFs, per fund. */
export const cryptoEtfFlowsModule: PluginModule = {
  panes: [
    {
      id: CRYPTO_ETF_FLOWS_PANE_ID,
      name: "Crypto ETF Flows",
      icon: "F",
      get component(): typeof import("./pane").CryptoEtfFlowsPane { const { CryptoEtfFlowsPane } = require("./pane"); return CryptoEtfFlowsPane; },
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 120, height: 32 },
      tableExport: true,
      headless: cryptoEtfFlowsHeadless,
    },
  ],
  paneTemplates: [
    {
      id: "crypto-etf-flows-pane",
      paneId: CRYPTO_ETF_FLOWS_PANE_ID,
      label: "Crypto ETF Flows",
      description: "Daily net flows of the US spot bitcoin and ether ETFs, per fund in US$ millions, with the running total since launch, as Farside Investors publishes them.",
      keywords: [
        "etf flows", "bitcoin flows", "btc flows", "ether flows", "eth flows", "ethereum flows", "crypto flows",
        "bitcoin etf flows", "ether etf flows", "spot bitcoin etf", "spot ether etf", "spot etf flows",
        "flows", "inflows", "outflows", "net flows", "creations", "redemptions",
        "ibit", "fbtc", "gbtc", "etha", "farside",
      ],
      shortcut: { prefix: "ETFF" },
      headless: cryptoEtfFlowsHeadless,
    },
  ],
  setup(ctx) {
    cryptoEtfFlowsCache.attach(ctx.persistence);
  },
  dispose() {
    cryptoEtfFlowsCache.reset();
  },
};
