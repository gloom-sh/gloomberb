import { CLI_COMMAND_GROUPS } from "../../../cli/help";
import type { GloomPlugin } from "../../../types/plugin";
import {
  attachFearGreedPersistence,
  loadFearGreed,
  resetFearGreedPersistence,
} from "./cache";
import { FearGreedPane } from "./pane";
import { fearGreedHeadless } from "./headless";

export const fearGreedPlugin: GloomPlugin = {
  id: "fear-greed",
  name: "Fear & Greed",
  version: "1.0.0",
  description: "CNN Fear & Greed index with the seven indicator charts",
  toggleable: true,

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

  // `gloomberb fear-greed`, as before the plugin moved out of the host. Runs
  // without the pane cache attached when invoked from the CLI, so it always
  // fetches, which is what a CLI call wants anyway.
  cliCommands: [
    {
      name: "fear-greed",
      description: "Fetch CNN Fear & Greed gauge data",
      help: { group: CLI_COMMAND_GROUPS.markets },
      async execute(_args, ctx) {
        const { data } = await loadFearGreed(ctx.cliOptions.refresh);
        ctx.printResult({
          data: [{
            score: data.overall.score,
            rating: data.overall.rating,
            updatedAt: data.overall.updatedAt?.toISOString() ?? "",
            previousClose: data.overall.previousClose,
            previousWeek: data.overall.previousWeek,
            previousMonth: data.overall.previousMonth,
            previousYear: data.overall.previousYear,
          }],
          metadata: {
            indicators: data.indicators.map((indicator) => ({
              id: indicator.definition.id,
              score: indicator.score,
              rating: indicator.rating,
            })),
          },
        });
      },
    },
  ],
};
