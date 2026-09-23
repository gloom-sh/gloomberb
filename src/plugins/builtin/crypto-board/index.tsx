import type { PluginModule } from "../plugin-module";
import { cryptoBoardCache } from "./client";
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
      defaultFloatingSize: { width: 112, height: 24 },
      tableExport: true,
      headless: cryptoBoardHeadless,
    },
  ],
  paneTemplates: [
    {
      id: "crypto-board-pane",
      paneId: "crypto-board",
      label: "Crypto Board",
      description: "USD crypto pairs, UTC returns, Alpaca volume and one-year price context.",
      keywords: ["crypto", "cryp", "bitcoin", "ethereum", "digital", "currency"],
      shortcut: { prefix: "CRYP" },
      headless: cryptoBoardHeadless,
    },
  ],
  setup(ctx) {
    cryptoBoardCache.attach(ctx.persistence);
  },
  dispose() {
    cryptoBoardCache.reset();
  },
};
