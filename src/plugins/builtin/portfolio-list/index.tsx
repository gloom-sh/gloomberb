import type { PaneTemplateContext, PaneTemplateInstanceConfig } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { PortfolioListPane } from "./pane";
import {
  buildPortfolioPaneSettingsDef,
  getPortfolioPaneSettings,
  resolveCollectionPaneId,
} from "./settings";
import { portfolioCliCommand } from "./cli/portfolio-command";
import { watchlistCliCommand } from "./cli/watchlist-command";
import { collectionHoldingsHeadless } from "./headless";
import { findCollection } from "./cli/render";
import {
  LIVE_STREAMING_QUICK_SETTING,
  withLiveStreamingSetting,
} from "../../../state/hooks/live-streaming";

function resolveCollectionIdForKind(context: PaneTemplateContext, kind: "portfolio" | "watchlist"): string | null {
  if (context.activeCollectionId) {
    const matchesKind = kind === "portfolio"
      ? context.config.portfolios.some((portfolio) => portfolio.id === context.activeCollectionId)
      : context.config.watchlists.some((watchlist) => watchlist.id === context.activeCollectionId);
    if (matchesKind) return context.activeCollectionId;
  }

  return kind === "portfolio"
    ? (context.config.portfolios[0]?.id ?? null)
    : (context.config.watchlists[0]?.id ?? null);
}

function createCollectionPaneInstance(
  context: PaneTemplateContext,
  kind?: "portfolio" | "watchlist",
  argument?: string,
): PaneTemplateInstanceConfig | null {
  // `PF Retirement` (or `shot PF Retirement`) opens the collection it names.
  const named = argument?.trim() ? findCollection(context.config, argument) : null;
  const collectionId = named && (!kind || named.kind === kind)
    ? named.id
    : kind ? resolveCollectionIdForKind(context, kind) : resolveCollectionPaneId(context);
  return collectionId ? { params: { collectionId } } : null;
}

export const portfolioListModule: PluginModule = {
  panes: [
    {
      id: "portfolio-list",
      reportFreshness: { source: "Local portfolio and Gloom Cloud" },
      name: "Portfolio",
      icon: "P",
      component: PortfolioListPane,
      defaultPosition: "left",
      defaultMode: "floating",
      defaultWidth: "40%",
      tickerSource: true,
      tableExport: true,
      quickSettings: [LIVE_STREAMING_QUICK_SETTING],
      portableShare: {
        private: {
          params: ["collectionId"],
          settings: ["collectionId", "visibleCollectionIds"],
          state: ["collectionId", "collectionSorts"],
        },
      },
      settings: (context) => withLiveStreamingSetting(
        buildPortfolioPaneSettingsDef(
          context.config,
          getPortfolioPaneSettings(context.settings),
          context.activeCollectionId,
        ),
        context.settings,
      ),
    },
  ],
  cliCommands: [
    portfolioCliCommand,
    watchlistCliCommand,
  ],
  paneTemplates: [
    {
      id: "new-collection-pane",
      paneId: "portfolio-list",
      label: "Collection Pane",
      description: "Open another pane for the current portfolio or watchlist",
      // Phrases rather than bare words, so `fn rebalance` and `fn target` keep resolving where they did.
      keywords: [
        "portfolio", "watchlist", "collection", "pane", "list",
        "portfolio rebalance", "allocation drift", "target weights", "asset allocation", "cash balance",
      ],
      shortcut: { prefix: "PF" },
      headless: collectionHoldingsHeadless,
      canCreate: (context) => resolveCollectionPaneId(context) !== null,
      createInstance: (context, options) => createCollectionPaneInstance(context, undefined, options?.arg),
    },
    {
      id: "new-portfolio-pane",
      paneId: "portfolio-list",
      label: "New Portfolio Pane",
      description: "Open another portfolio list pane",
      keywords: ["new", "portfolio", "pane", "list"],
      canCreate: (context) => context.config.portfolios.length > 0,
      createInstance: (context) => createCollectionPaneInstance(context, "portfolio"),
    },
    {
      id: "new-watchlist-pane",
      paneId: "portfolio-list",
      label: "New Watchlist Pane",
      description: "Open another watchlist pane",
      keywords: ["new", "watchlist", "pane", "list"],
      canCreate: (context) => context.config.watchlists.length > 0,
      createInstance: (context) => createCollectionPaneInstance(context, "watchlist"),
    },
  ],
};
