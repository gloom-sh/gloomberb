import { useCallback, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { DataProvider } from "../../../types/data-provider";
import type { AppTickerRepositoryPort } from "../../../core/app-service-ports";
import type { PluginRegistry } from "../../../plugins/registry";
import type { AppAction, AppState } from "../../../state/app/context";
import type { TickerRecord } from "../../../types/ticker";
import { buildAddToPortfolioWorkflow } from "../../../plugins/builtin/portfolio-list/command-bar";
import { getFirstVisibleFieldId } from "../helpers";
import {
  buildBrokerChoices,
  buildBrokerWorkflowRoute,
} from "./broker";
import { buildBuiltInWorkflowRoute } from "./builtin";
import {
  createCommandBarCollectionWorkflowActions,
  type CommandBarNotifyFn,
} from "./collection-actions";
import { useCommandBarWorkflowRuntime } from "./runtime";
import type {
  CommandBarRoute,
  CommandBarWorkflowRoute,
} from "./types";

interface UseCommandBarWorkflowCoordinatorOptions {
  activeCollectionId: string | null;
  activeLayoutIndex: number;
  activeTicker: TickerRecord | null;
  activeTickerSymbol: string | null;
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
  currentRoute: CommandBarRoute | null;
  dataProvider: DataProvider;
  dispatch: Dispatch<AppAction>;
  notify: CommandBarNotifyFn;
  persistConfig: (nextConfig: AppState["config"]) => void;
  pluginRegistry: PluginRegistry;
  pushRoute: (route: CommandBarRoute) => void;
  setActiveCollection: (collectionId: string) => void;
  setRouteStack: Dispatch<SetStateAction<CommandBarRoute[]>>;
  stateRef: MutableRefObject<AppState>;
  tickerRepository: AppTickerRepositoryPort;
  updateTopRoute: (updater: (route: CommandBarRoute) => CommandBarRoute) => void;
}

export function useCommandBarWorkflowCoordinator({
  activeCollectionId,
  activeLayoutIndex,
  activeTicker,
  activeTickerSymbol,
  closeAll,
  currentRoute,
  dataProvider,
  dispatch,
  notify,
  persistConfig,
  pluginRegistry,
  pushRoute,
  setActiveCollection,
  setRouteStack,
  stateRef,
  tickerRepository,
  updateTopRoute,
}: UseCommandBarWorkflowCoordinatorOptions) {
  const brokerChoices = useMemo(
    () => buildBrokerChoices(pluginRegistry.brokers),
    [pluginRegistry.brokers],
  );

  const buildBrokerWorkflow = useCallback((
    selectorKey: "brokerType" | "source",
    title: string,
    subtitle: string | undefined,
    submitLabel: string,
    includeManualOption: boolean,
  ): CommandBarWorkflowRoute | null => buildBrokerWorkflowRoute({
    brokerChoices,
    includeManualOption,
    selectorKey,
    submitLabel,
    subtitle,
    title,
  }), [brokerChoices]);

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

  const workflowRuntime = useCommandBarWorkflowRuntime({
    activeLayoutIndex,
    closeAll,
    collectionWorkflowActions,
    currentRoute,
    dispatch,
    notify,
    pluginRegistry,
    pushRoute,
    setRouteStack,
    updateTopRoute,
  });
  const { openWorkflowRoute } = workflowRuntime;

  const openAddToPortfolioWorkflow = useCallback((
    ticker: TickerRecord,
    preferredPortfolioId?: string | null,
  ) => {
    const defaultAvgCost = stateRef.current.financials.get(ticker.metadata.ticker)?.quote?.price ?? null;
    const workflow = buildAddToPortfolioWorkflow(stateRef.current.config, {
      preferredPortfolioId,
      ticker,
      defaultAvgCost,
    });
    if (!workflow) {
      notify("Create a manual portfolio first.", { type: "info" });
      return;
    }

    openWorkflowRoute({
      kind: "workflow",
      workflowId: "builtin:add-portfolio",
      title: `Add ${ticker.metadata.ticker} to Portfolio`,
      subtitle: "Choose a portfolio and optionally record the manual position now.",
      fields: workflow.fields,
      values: workflow.values,
      activeFieldId: getFirstVisibleFieldId(workflow.fields, workflow.values),
      submitLabel: "Add to Portfolio",
      cancelLabel: "Back",
      pendingLabel: workflow.pendingLabel,
      pending: false,
      error: null,
      successBehavior: "close",
      payload: { kind: "builtin", actionId: "add-portfolio" },
    });
  }, [notify, openWorkflowRoute, stateRef]);

  const openBuiltInWorkflow = useCallback((actionId: string) => {
    const result = buildBuiltInWorkflowRoute({
      actionId,
      activeCollectionId,
      activeTicker,
      buildBrokerWorkflow,
      config: stateRef.current.config,
    });
    if (result.kind === "notice") {
      notify(result.message, { type: "info" });
      return;
    }
    if (result.kind === "route") {
      openWorkflowRoute(result.route);
    }
  }, [
    activeCollectionId,
    activeTicker,
    buildBrokerWorkflow,
    notify,
    openWorkflowRoute,
    stateRef,
  ]);

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
    ...workflowRuntime,
  };
}
