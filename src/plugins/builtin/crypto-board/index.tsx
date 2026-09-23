import type { PluginModule } from "../plugin-module";
import { LIVE_STREAMING_QUICK_SETTING, withLiveStreamingSetting } from "../shared/live-streaming";
import { cryptoMarketsCache } from "./client";
import { cryptoBoardHeadless } from "./headless";
import { CryptoBoardPane } from "./pane";

export const cryptoBoardModule: PluginModule = {
  panes: [
    {
      id: "crypto-board",
      name: "Crypto",
      icon: "C",
      component: CryptoBoardPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 120, height: 32 },
      tableExport: true,
      headless: cryptoBoardHeadless,
      quickSettings: [LIVE_STREAMING_QUICK_SETTING],
      settings: (context) => withLiveStreamingSetting({ title: "Crypto Settings", values: {}, fields: [] }, context.settings),
    },
  ],
  paneTemplates: [
    {
      id: "crypto-board-pane",
      paneId: "crypto-board",
      label: "Crypto",
      description: "Top crypto assets by market cap with live prices, 7D, 30D and 1Y returns, volume and market cap.",
      keywords: ["crypto", "cryp", "bitcoin", "ethereum", "coins", "stablecoins", "digital", "currency"],
      shortcut: { prefix: "CRYP" },
      headless: cryptoBoardHeadless,
    },
  ],
  setup(ctx) {
    cryptoMarketsCache.attach(ctx.persistence);
  },
  dispose() {
    cryptoMarketsCache.reset();
  },
};
