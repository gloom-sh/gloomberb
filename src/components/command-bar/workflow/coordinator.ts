import { useCallback, useMemo, type Dispatch, type MutableRefObject } from "react";
import type { DataProvider } from "../../../types/data-provider";
import type { AppTickerRepositoryPort } from "../../../core/app-service-ports";
import type { PluginRegistry } from "../../../plugins/registry";
import type { AppAction, AppState } from "../../../state/app/context";
import type { TickerRecord } from "../../../types/ticker";
import { openFormModal, type FormModalRequest } from "../../form-modal";
import {
  createCommandBarCollectionWorkflowActions,
  type CommandBarNotifyFn,
} from "./collection-actions";
import type { CommandBarWorkflowRoute } from "./types";

interface UseCommandBarWorkflowCoordinatorOptions {
  activeCollectionId: string | null;
  activeTickerSymbol: string | null;
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
  dataProvider: DataProvider;
  dispatch: Dispatch<AppAction>;
  notify: CommandBarNotifyFn;
  persistConfig: (nextConfig: AppState["config"]) => void;
  pluginRegistry: PluginRegistry;
  setActiveCollection: (collectionId: string) => void;
  stateRef: MutableRefObject<AppState>;
  tickerRepository: AppTickerRepositoryPort;
}

/**
 * The bar finds a form and hands it to the form modal, closing itself; the
 * modal builds and submits it. The collection actions stay here for the
 * pickers and confirms the bar still shows.
 */
export function useCommandBarWorkflowCoordinator({
  activeCollectionId,
  activeTickerSymbol,
  closeAll,
  dataProvider,
  dispatch,
  notify,
  persistConfig,
  pluginRegistry,
  setActiveCollection,
  stateRef,
  tickerRepository,
}: UseCommandBarWorkflowCoordinatorOptions) {
  const collectionWorkflowActions = useMemo(() => createCommandBarCollectionWorkflowActions({
    activeCollectionId,
    activeTickerSymbol,
    dataProvider,
    dispatch,
    getState: () => stateRef.current,
    notify,
    persistConfig,
    pluginRegistry,
    setActiveCollection,
    tickerRepository,
  }), [
    activeCollectionId,
    activeTickerSymbol,
    dataProvider,
    dispatch,
    notify,
    persistConfig,
    pluginRegistry,
    setActiveCollection,
    stateRef,
    tickerRepository,
  ]);

  const openForm = useCallback((request: FormModalRequest) => {
    if (openFormModal(request)) closeAll({ revertThemePreview: false });
  }, [closeAll]);

  const openWorkflowRoute = useCallback((route: CommandBarWorkflowRoute) => {
    openForm({ kind: "route", route });
  }, [openForm]);

  const openAddToPortfolioWorkflow = useCallback((
    ticker: TickerRecord,
    preferredPortfolioId?: string | null,
  ) => {
    openForm({ kind: "add-to-portfolio", ticker, portfolioId: preferredPortfolioId });
  }, [openForm]);

  const openBuiltInWorkflow = useCallback((actionId: string) => {
    openForm({ kind: "builtin", actionId });
  }, [openForm]);

  const buildSharedWorkflowDeps = useCallback(() => ({
    dataProvider,
    tickerRepository,
    pluginRegistry,
    dispatch,
    getState: () => stateRef.current,
  }), [dataProvider, dispatch, pluginRegistry, stateRef, tickerRepository]);

  return {
    buildSharedWorkflowDeps,
    collectionWorkflowActions,
    openAddToPortfolioWorkflow,
    openBuiltInWorkflow,
    openForm,
    openWorkflowRoute,
  };
}
