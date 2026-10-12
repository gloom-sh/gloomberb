import type { ResolvedPane } from "../../../../layout/pane-manager";
import { getPaneSettings } from "../../../../pane-settings";
import { resolveCollectionForPane, resolveTickerForPane, type AppState } from "../../../../state/app/context";
import type { LayoutConfig } from "../../../../types/config";
import type { PanePersonalDataContext } from "../../../../types/plugin";

/** What a pane shows now, for its `personalData` rule. */
export function personalDataContext(state: AppState, layout: LayoutConfig, pane: ResolvedPane): PanePersonalDataContext {
  const paneId = pane.instance.instanceId;
  return {
    config: state.config,
    layout,
    paneId,
    paneType: pane.instance.paneId,
    pane: pane.instance,
    settings: getPaneSettings(pane.instance),
    paneState: state.paneState[paneId] ?? {},
    activeTicker: resolveTickerForPane(state, paneId),
    activeCollectionId: resolveCollectionForPane(state, paneId),
    tickers: state.tickers,
  };
}
