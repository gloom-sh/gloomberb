import type { Dispatch } from "react";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import type { PluginRegistry } from "../../plugins/registry";
import {
  getFocusedCollectionId,
  getFocusedTickerSymbol,
  type AppAction,
  type AppState,
} from "../../state/app/context";
import type { DataProvider } from "../../types/data-provider";
import { showCollectionInPortfolioPane } from "../command-bar/pane-actions";
import { persistWorkflowConfig } from "../command-bar/surface/environment";
import {
  createCommandBarCollectionWorkflowActions,
  type CommandBarCollectionWorkflowActions,
  type CommandBarNotifyFn,
} from "../command-bar/workflow/collection-actions";

/** What a form needs from the app to submit. Read when it submits, never kept. */
export interface FormModalDeps {
  dataProvider: DataProvider;
  dispatch: Dispatch<AppAction>;
  getState: () => AppState;
  pluginRegistry: PluginRegistry;
  tickerRepository: AppTickerRepositoryPort;
}

/**
 * The collection actions behind every built-in form, bound to the state at
 * the moment of the call: the focused collection and ticker are the ones the
 * user sees when they submit, not when the form opened.
 */
export function createFormCollectionActions(
  deps: FormModalDeps,
  notify: CommandBarNotifyFn,
): CommandBarCollectionWorkflowActions {
  const state = deps.getState();
  return createCommandBarCollectionWorkflowActions({
    activeCollectionId: getFocusedCollectionId(state),
    activeTickerSymbol: getFocusedTickerSymbol(state),
    dataProvider: deps.dataProvider,
    dispatch: deps.dispatch,
    getState: deps.getState,
    notify,
    persistConfig: (nextConfig) => persistWorkflowConfig(deps.getState(), nextConfig),
    pluginRegistry: deps.pluginRegistry,
    setActiveCollection: (collectionId) => showCollectionInPortfolioPane(deps.getState(), deps.dispatch, collectionId),
    tickerRepository: deps.tickerRepository,
  });
}
