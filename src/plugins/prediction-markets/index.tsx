import type { GloomPlugin, GloomPluginContext } from "../../types/plugin";
import { resolvePaneInstance } from "../../types/config";
import { parsePredictionSearchShortcut } from "./navigation";
import { PredictionMarketsPane } from "./pane";
import { attachPredictionMarketsPersistence, resetPredictionMarketsPersistence } from "./services/fetch";
import { predictionMarketsCliCommand } from "./cli";
import { predictionChartSeriesCapability } from "./capability";
import {
  buildPredictionMarketsPaneSettingsDef,
  createPredictionMarketsPaneSettings,
  getPredictionMarketsPaneSettings,
} from "./settings";

const PANE_ID = "prediction-markets";
const MAIN_INSTANCE_ID = `${PANE_ID}:main`;

function openPredictionMarkets(ctx: GloomPluginContext, query = ""): void {
  const parsed = parsePredictionSearchShortcut(query);
  const existingInstanceId = resolvePaneInstance(ctx.getConfig().layout, PANE_ID)?.instanceId;
  const targetInstanceId = existingInstanceId ?? MAIN_INSTANCE_ID;
  ctx.resume.setPaneState(targetInstanceId, "venueScope", parsed.venueScope);
  ctx.resume.setPaneState(targetInstanceId, "searchQuery", parsed.searchQuery);
  ctx.resume.setPaneState(targetInstanceId, "selectedRowKey", null);
  ctx.resume.setPaneState(targetInstanceId, "selectedDetailMarketKey", null);
  ctx.focusPane(existingInstanceId ?? PANE_ID);
}

export const predictionMarketsPlugin: GloomPlugin = {
  id: PANE_ID,
  name: "Prediction Markets",
  version: "1.0.0",
  description:
    "Browse prediction markets (Polymarket and Kalshi).",
  toggleable: true,
  cliCommands: [predictionMarketsCliCommand],
  capabilities: [predictionChartSeriesCapability],
  panes: [
    {
      id: PANE_ID,
      name: "Prediction Markets",
      icon: "M",
      component: PredictionMarketsPane,
      defaultPosition: "left",
      defaultMode: "floating",
      defaultFloatingSize: { width: 132, height: 36 },
      tableExport: true,
      settings: (context) =>
        buildPredictionMarketsPaneSettingsDef(
          context.config,
          getPredictionMarketsPaneSettings(context.settings),
        ),
    },
  ],
  paneTemplates: [
    {
      id: "new-prediction-markets-pane",
      paneId: PANE_ID,
      label: "Prediction Markets",
      description: "Open a new prediction markets browser pane",
      keywords: ["prediction", "markets", "polymarket", "kalshi", "events"],
      shortcut: { prefix: "PM", argPlaceholder: "query", argKind: "text" },
      createInstance: (_context, options) => {
        const parsed = parsePredictionSearchShortcut(options?.arg ?? "");
        return {
          placement: "floating",
          params: {
            query: parsed.searchQuery,
            scope: parsed.venueScope,
          },
          settings: createPredictionMarketsPaneSettings() as unknown as Record<
            string,
            unknown
          >,
        };
      },
    },
  ],
  setup(ctx) {
    attachPredictionMarketsPersistence(ctx.persistence);

    ctx.registerCommand({
      id: "prediction-markets-open",
      label: "Open Prediction Markets",
      description: "Focus the prediction markets browser pane.",
      keywords: ["prediction", "markets", "polymarket", "kalshi", "open"],
      category: "navigation",
      execute: async () => {
        ctx.focusPane(PANE_ID);
      },
    });

    ctx.registerCommand({
      id: "prediction-markets-search",
      label: "Search Prediction Markets",
      description: "Open the prediction markets pane and seed a search query.",
      keywords: ["prediction", "markets", "search", "polymarket", "kalshi"],
      category: "navigation",
      wizard: [
        {
          key: "query",
          label: "Prediction market query",
          placeholder: "fed or polymarket:fed",
          type: "text",
        },
      ],
      execute: async (values) => {
        openPredictionMarkets(ctx, values?.query ?? "");
      },
    });
  },

  dispose() {
    resetPredictionMarketsPersistence();
  },
};
