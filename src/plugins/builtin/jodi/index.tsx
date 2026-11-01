import type { PluginModule } from "../plugin-module";
import { jodiHeadless } from "./headless";
import { JODI_PANE_ID } from "./model";

export const jodiModule: PluginModule = {
  panes: [
    {
      id: JODI_PANE_ID,
      name: "Oil and Gas Balances",
      icon: "O",
      get component(): typeof import("./pane").JodiPane { const { JodiPane } = require("./pane"); return JodiPane; },
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 110, height: 30 },
      tableExport: true,
      headless: jodiHeadless,
    },
  ],
  paneTemplates: [
    {
      id: "jodi-pane",
      paneId: JODI_PANE_ID,
      label: "Oil and Gas Balances",
      description: "Latest monthly crude oil and natural gas production, demand, trade and stocks for the largest countries.",
      keywords: ["oil", "crude", "gas", "natural gas", "petroleum", "production", "imports", "exports", "stocks", "balance", "balances", "jodi"],
      shortcut: { prefix: "JODI" },
      headless: jodiHeadless,
      createInstance: () => ({ placement: "floating" }),
    },
  ],
};
