import type { PluginModule } from "../plugin-module";
import { LIVE_STREAMING_QUICK_SETTING, withLiveStreamingSetting } from "../../../state/hooks/live-streaming";
import { cryptoMarketsCache, DEFI_TVL_CACHES, STABLECOIN_SUPPLY_CACHES } from "./client";
import { BITCOIN_NETWORK_CACHES } from "./bitcoin-network";
import { cryptoBoardHeadless } from "./headless";
import { CRYPTO_SERIES } from "./series";

export const cryptoBoardModule: PluginModule = {
  series: CRYPTO_SERIES,
  panes: [
    {
      id: "crypto-board",
      name: "Crypto",
      icon: "C",
      get component(): typeof import("./pane").CryptoBoardPane { const { CryptoBoardPane } = require("./pane"); return CryptoBoardPane; },
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
      description: "Top crypto assets by market cap with live prices, 7D, 30D and 1Y returns, volume and market cap, stablecoin supply, and DeFi TVL by protocol and chain.",
      keywords: [
        "crypto", "cryp", "bitcoin", "ethereum", "coins", "stablecoins", "stablecoin supply", "digital", "currency",
        "defi", "tvl", "total value locked", "defi tvl", "on-chain", "onchain", "aave", "lido", "protocols", "chains",
      ],
      shortcut: { prefix: "CRYP" },
      headless: cryptoBoardHeadless,
    },
  ],
  setup(ctx) {
    cryptoMarketsCache.attach(ctx.persistence);
    for (const cache of STABLECOIN_SUPPLY_CACHES) cache.attach(ctx.persistence);
    for (const cache of DEFI_TVL_CACHES) cache.attach(ctx.persistence);
    for (const cache of BITCOIN_NETWORK_CACHES) cache.attach(ctx.persistence);
  },
  dispose() {
    cryptoMarketsCache.reset();
    for (const cache of STABLECOIN_SUPPLY_CACHES) cache.reset();
    for (const cache of DEFI_TVL_CACHES) cache.reset();
    for (const cache of BITCOIN_NETWORK_CACHES) cache.reset();
  },
};
