import { resolveCollectionForPane, resolveTickerForPane, type AppState } from "../../../state/app/context";
import { t } from "../../../i18n";
import { TICKER_RESEARCH_PANE_ID, type PaneInstanceConfig } from "../../../types/config";
import type { PaneDef } from "../../../types/plugin";

export function getPaneDisplayTitle(
  state: Pick<AppState, "config" | "paneState">,
  instance: PaneInstanceConfig,
  paneDef: PaneDef,
): string {
  if (instance.paneId === "chat") {
    const channelId = typeof instance.settings?.channelId === "string" && instance.settings.channelId.trim()
      ? instance.settings.channelId.trim()
      : "everyone";
    const title = typeof instance.title === "string" ? instance.title.trim() : "";
    const displayTitle = title && !title.startsWith("dm:") && !title.startsWith("group:") ? title : undefined;
    if (channelId.startsWith("dm:")) return displayTitle ?? "DM";
    if (channelId.startsWith("group:")) return displayTitle ?? "Group";
    return displayTitle ?? `#${channelId}`;
  }

  if (instance.paneId === TICKER_RESEARCH_PANE_ID) {
    const ticker = resolveTickerForPane(state as AppState, instance.instanceId);
    if (ticker) return ticker;
    const collectionId = resolveCollectionForPane(state as AppState, instance.instanceId);
    return state.config.portfolios.find((portfolio) => portfolio.id === collectionId)?.name
      ?? state.config.watchlists.find((watchlist) => watchlist.id === collectionId)?.name
      ?? instance.title
      ?? t(paneDef.name);
  }

  if (instance.title) return instance.title;

  if (instance.paneId === "portfolio-list") {
    const collectionId = resolveCollectionForPane(state as AppState, instance.instanceId);
    return state.config.portfolios.find((portfolio) => portfolio.id === collectionId)?.name
      ?? state.config.watchlists.find((watchlist) => watchlist.id === collectionId)?.name
      ?? t(paneDef.name);
  }

  // A source pane owns the cursor symbol; echoing it in its own title would just repeat the row.
  if (paneDef.tickerSource) return t(paneDef.name);

  const ticker = resolveTickerForPane(state as AppState, instance.instanceId);
  return ticker ? `${t(paneDef.name)}: ${ticker}` : t(paneDef.name);
}
