import { fearGreedPluginMeta } from "../builtin-plugin-meta";
import { fearGreedCliCommand } from "./cli";
import type { GloomPlugin } from "../../../types/plugin";
import {
  attachFearGreedPersistence,
  resetFearGreedPersistence,
} from "./cache";
import { fearGreedHeadless } from "./headless";
import { FEAR_GREED_SERIES } from "./series";

export const fearGreedPlugin: GloomPlugin = {
  ...fearGreedPluginMeta,

  // One JSON endpoint over HTTPS, so every renderer. CNN sends no CORS
  // headers and wants a Referer, which is why the host is declared: the web
  // app proxies it.
  targets: ["cli", "tui", "desktop", "web"],
  hosts: ["production.dataviz.cnn.io"],

  setup(ctx) {
    attachFearGreedPersistence(ctx.persistence);
  },

  dispose() {
    resetFearGreedPersistence();
  },

  // The index and its seven readings, chartable against anything else.
  series: FEAR_GREED_SERIES,

  panes: [
    {
      id: "fear-greed",
      name: "Fear & Greed",
      icon: "G",
      get component(): typeof import("./pane").FearGreedPane { const { FearGreedPane } = require("./pane"); return FearGreedPane; },
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

  cliCommands: [fearGreedCliCommand],
};
