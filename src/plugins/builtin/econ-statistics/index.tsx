import type { PluginModule } from "../plugin-module";
import { statsCache } from "./cache";
import { STAT_CATEGORIES } from "./defs";
import { econStatisticsHeadless } from "./headless";
import { EconStatisticsPane } from "./pane";
import { resolveStatArg, STATS, DEFAULT_STAT_ID } from "./stats";


const ECON_STATISTICS_PANE_ID = "econ-statistics";

export const econStatisticsModule: PluginModule = {
  panes: [{
    id: ECON_STATISTICS_PANE_ID,
    name: "Economic Statistics",
    icon: "E",
    component: EconStatisticsPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 120, height: 36 },
  }],
  paneTemplates: [{
    id: "econ-statistics-pane",
    paneId: ECON_STATISTICS_PANE_ID,
    label: "Economic Statistics",
    description: "Inflation, labour, growth, housing and rates against their own history.",
    keywords: [...new Set([
      "economic",
      "statistics",
      "macro",
      "indicators",
      "data",
      ...STAT_CATEGORIES.map((entry) => entry.label.toLowerCase()),
      ...STATS.flatMap((entry) => [entry.shortLabel, ...entry.keywords ?? []].map((keyword) => keyword.toLowerCase())),
    ])],
    shortcut: {
      prefix: "ECST",
      argPlaceholder: "statistic",
      argKind: "text",
      argOptional: true,
      argOptions: () => STATS.map((stat) => ({ value: stat.id, label: `${stat.label} (${stat.shortLabel})` })),
    },
    headless: econStatisticsHeadless,
    canCreate: () => true,
    createInstance: (_context, options) => ({
      settings: { stat: resolveStatArg(options?.arg)?.id ?? DEFAULT_STAT_ID },
    }),
  }],
  setup(ctx) {
    statsCache.attach(ctx.persistence);
  },
  dispose() {
    statsCache.reset();
  },
};
