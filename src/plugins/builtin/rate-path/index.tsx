import type { PluginModule } from "../plugin-module";
import { ratePathCache } from "./client";
import { ratePathHeadless } from "./headless";
import { RatePathPane } from "./pane";

export const ratePathModule: PluginModule = {
  panes: [{ id: "rate-path", name: "US Rate Path", icon: "R", component: RatePathPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 86, height: 30 },
    tableExport: true, headless: ratePathHeadless }],
  paneTemplates: [{
    id: "rate-path-pane", paneId: "rate-path", label: "US Rate Path",
    description: "Fed funds futures implied FOMC path and conditional target probabilities.",
    keywords: ["rates", "fed", "fomc", "futures", "probability", "wirp", "ffip"],
    shortcut: { prefix: "WIRP", aliases: ["FFIP"] }, headless: ratePathHeadless,
  }],
  setup(ctx) { ratePathCache.attach(ctx.persistence); },
  dispose() { ratePathCache.reset(); },
};
