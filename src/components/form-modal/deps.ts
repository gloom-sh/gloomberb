import type { Dispatch } from "react";
import type { SignedInBroker } from "../../brokers/signed-in/client";
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
  /** The form's own connect step for a signed-in broker. */
  requestBrokerSignIn?: (broker: SignedInBroker) => Promise<boolean>,
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
    requestBrokerSignIn,
    setActiveCollection: (collectionId) => showCollectionInPortfolioPane(deps.getState(), deps.dispatch, collectionId),
    tickerRepository: deps.tickerRepository,
  });
}

/**
 * Collection actions for work that can outlive its caller, such as a confirm
 * the bar opened and closed behind: each call builds them from the app as it
 * is then, so a delete never writes an older config back over a newer one.
 */
export function createLiveCollectionActions(
  getDeps: () => FormModalDeps,
  notify: CommandBarNotifyFn,
): CommandBarCollectionWorkflowActions {
  const current = () => createFormCollectionActions(getDeps(), notify);
  return {
    connectBrokerProfile: (brokerId, values) => current().connectBrokerProfile(brokerId, values),
    connectSignedInBroker: (broker) => current().connectSignedInBroker(broker),
    createManualPortfolio: (name, owner) => current().createManualPortfolio(name, owner),
    createWatchlist: (name, owner) => current().createWatchlist(name, owner),
    deletePortfolio: (portfolioId) => current().deletePortfolio(portfolioId),
    deleteWatchlist: (watchlistId) => current().deleteWatchlist(watchlistId),
    disconnectBrokerInstance: (instanceId) => current().disconnectBrokerInstance(instanceId),
    setPortfolioPositionFromWorkflow: (values) => current().setPortfolioPositionFromWorkflow(values),
    addTickerMembershipFromWorkflow: (values) => current().addTickerMembershipFromWorkflow(values),
  };
}
