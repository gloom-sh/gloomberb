import type { PaneTemplateContext, PaneTemplateInstanceConfig, ShortcutArgError } from "../../../types/plugin";
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

/** Names the bar lists under an unknown one; the line is one row of the bar. */
const LISTED_COLLECTION_NAMES = 6;

/** `PF Nope`: no portfolio or watchlist has that name or id, so the bar names those that do. */
function unknownCollectionArg(arg: string, context: PaneTemplateContext): ShortcutArgError | null {
  if (findCollection(context.config, arg)) return null;
  const names = [...context.config.portfolios, ...context.config.watchlists]
    .map((collection) => collection.name.trim() || collection.id);
  const listed = names.slice(0, LISTED_COLLECTION_NAMES);
  const more = names.length - listed.length;
  return {
    message: `No portfolio or watchlist named "${arg}"`,
    detail: listed.length === 0 ? "No portfolios or watchlists are set up"
      : more > 0 ? `Try ${listed.join(", ")} or ${more} more`
      : listed.length === 1 ? `Try ${listed[0]}`
      : `Try ${listed.slice(0, -1).join(", ")} or ${listed.at(-1)}`,
  };
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
      // A watchlist is tickers someone follows; a portfolio is what they hold.
      personalData: (context) => (
        context.config.watchlists.some((watchlist) => watchlist.id === context.activeCollectionId) ? null : "holdings"
      ),
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
      description: "Holdings, weights and P&L of a portfolio or watchlist; set target weights to see drift and the trades that rebalance",
      // Phrases rather than bare words, so `fn rebalance` and `fn target` keep resolving where they did.
      keywords: [
        "portfolio", "watchlist", "collection", "pane", "list",
        "portfolio rebalance", "allocation drift", "target weights", "asset allocation", "cash balance",
      ],
      // The argument is the report's: `PF Book` opens Book, by name or id in any case.
      shortcut: { prefix: "PF", argError: unknownCollectionArg },
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
