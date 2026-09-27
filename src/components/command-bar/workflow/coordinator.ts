import { useCallback, useMemo, useRef, type Dispatch } from "react";
import type { DataProvider } from "../../../types/data-provider";
import type { AppTickerRepositoryPort } from "../../../core/app-service-ports";
import type { PluginRegistry } from "../../../plugins/registry";
import { useAppGetState, type AppAction } from "../../../state/app/context";
import type { TickerRecord } from "../../../types/ticker";
import { openFormModal, type FormModalRequest } from "../../form-modal";
import { createLiveCollectionActions, type FormModalDeps } from "../../form-modal/deps";
import type { CommandBarNotifyFn } from "./collection-actions";
import type { CommandBarWorkflowRoute } from "./types";

interface UseCommandBarWorkflowCoordinatorOptions {
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
  dataProvider: DataProvider;
  dispatch: Dispatch<AppAction>;
  notify: CommandBarNotifyFn;
  pluginRegistry: PluginRegistry;
  tickerRepository: AppTickerRepositoryPort;
}

/**
 * The bar finds a form and hands it to the form modal, closing itself; the
 * modal builds and submits it. The collection actions stay here for the
 * pickers and confirms the bar still starts, and read the app's store when
 * they run: a confirm outlives the bar that opened it.
 */
export function useCommandBarWorkflowCoordinator({
  closeAll,
  dataProvider,
  dispatch,
  notify,
  pluginRegistry,
  tickerRepository,
}: UseCommandBarWorkflowCoordinatorOptions) {
  const getState = useAppGetState();
  const depsRef = useRef<FormModalDeps>(null as unknown as FormModalDeps);
  depsRef.current = { dataProvider, dispatch, getState, pluginRegistry, tickerRepository };
  const collectionWorkflowActions = useMemo(
    () => createLiveCollectionActions(() => depsRef.current, notify),
    [notify],
  );

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
    getState,
  }), [dataProvider, dispatch, getState, pluginRegistry, tickerRepository]);

  return {
    buildSharedWorkflowDeps,
    collectionWorkflowActions,
    openAddToPortfolioWorkflow,
    openBuiltInWorkflow,
    openForm,
    openWorkflowRoute,
  };
}
