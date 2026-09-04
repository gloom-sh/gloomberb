import type { PluginModule } from "../plugin-module";
import {
  attachFearGreedPersistence,
  resetFearGreedPersistence,
} from "./cache";
import { FearGreedPane } from "./pane";
import { fearGreedHeadless } from "./headless";

export { fearGreedHeadless } from "./headless";

export const fearGreedModule: PluginModule = {
  setup(ctx) {
    attachFearGreedPersistence(ctx.persistence);
  },

  dispose() {
    resetFearGreedPersistence();
  },

  panes: [
    {
      id: "fear-greed",
      name: "Fear & Greed",
      icon: "G",
      component: FearGreedPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 110, height: 36 },
    },
  ],

  paneTemplates: [
    {
      id: "fear-greed-pane",
      paneId: "fear-greed",
      label: "Fear & Greed",
      description: "CNN Fear & Greed sentiment gauge with the seven indicator charts.",
      keywords: ["fear", "greed", "sentiment", "cnn", "market", "indicators", "gauge"],
      shortcut: { prefix: "FNG" },
      headless: fearGreedHeadless,
    },
  ],
};
