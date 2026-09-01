import { usePaneFooter } from "../../../components";
import { useShortcut } from "../../../react/input";
import { useDialog } from "../../../ui/dialog";
import { useCallback, useEffect, useRef } from "react";
import { resolveTickerFinancialsForInstrument } from "../../../market-data/coordinator";
import { instrumentFromTicker } from "../../../market-data/request-types";
import {
  useAppDispatch,
  useAppSelector,
  usePaneCollection,
  usePaneInstanceId,
} from "../../../state/app/context";
import type { PaneProps } from "../../../types/plugin";
import { isPlainKey } from "../../../utils/keyboard";
import { getBrokerInstance } from "../../../utils/broker-instances";
import { usePluginPaneActions } from "../../runtime";
import { isGatewayConfigured } from "../../ibkr/config";
import { useIbkrGatewaySelection } from "../gateway/selection";
import { refreshGatewayData } from "../gateway/helpers";
import { promptIbkrAccountChoice, promptIbkrProfileChoice } from "../trade/dialogs";
import {
  getTradingPaneState,
  loadOrderIntoDraft,
  setTradingBusy,
  setTradingMessage,
  updateTradingPaneState,
  useTradingPaneState,
} from "./state";
import {
  findTickerForOrder,
  getKnownIbkrAccounts,
  inferDraftAccountId,
  isMarketDataWarning,
} from "../trade/utils";
import { TradingPaneView } from "./pane-view";

export function TradingPane({ focused, width, height }: PaneProps) {
  const dispatch = useAppDispatch();
  const config = useAppSelector((state) => state.config);
  const brokerAccounts = useAppSelector((state) => state.brokerAccounts);
  const tickers = useAppSelector((state) => state.tickers);
  const paneId = usePaneInstanceId();
  const { collectionId } = usePaneCollection(paneId);
  const { selectTicker, switchTab, switchPanel } = usePluginPaneActions();
  const dialog = useDialog();
  const tradeState = useTradingPaneState();
  const {
    activePortfolio,
    gatewayInstances,
    lockedBrokerInstanceId,
    selectedInstance,
    gatewaySnapshot,
    gatewayService,
    normalizedConfig,
    isGatewayMode,
    availableAccounts,
    gatewayRequiredMessage,
  } = useIbkrGatewaySelection(
    config,
    brokerAccounts,
    collectionId,
    tradeState.brokerInstanceId,
  );
  const statusMessage = gatewaySnapshot.status.message || gatewaySnapshot.lastError;
  const displayStatusState = gatewaySnapshot.status.state === "error" && isMarketDataWarning(statusMessage)
    ? "connected"
    : gatewaySnapshot.status.state;
  const selectedOrder = gatewaySnapshot.openOrders[tradeState.selectedOpenOrderIndex] ?? null;

  useEffect(() => {
    if (!focused) return;
    dispatch({ type: "SET_INPUT_CAPTURED", captured: true });
    return () => {
      dispatch({ type: "SET_INPUT_CAPTURED", captured: false });
    };
  }, [focused, dispatch]);

  useEffect(() => {
    if (!selectedInstance) return;
    const lockedAccountId = lockedBrokerInstanceId === selectedInstance.id ? activePortfolio?.brokerAccountId : undefined;
    if (
      tradeState.brokerInstanceId !== selectedInstance.id
      || tradeState.brokerLabel !== selectedInstance.label
      || (lockedAccountId && tradeState.accountId !== lockedAccountId)
    ) {
      updateTradingPaneState((current) => ({
        ...current,
        brokerInstanceId: selectedInstance.id,
        brokerLabel: selectedInstance.label,
        accountId: lockedAccountId ?? current.accountId,
        selectedOpenOrderIndex: 0,
      }));
    }
  }, [
    selectedInstance,
    tradeState.brokerInstanceId,
    tradeState.brokerLabel,
    tradeState.accountId,
    lockedBrokerInstanceId,
    activePortfolio?.brokerAccountId,
  ]);

  useEffect(() => {
    if (!isGatewayMode || availableAccounts.length === 0 || tradeState.accountId || !selectedInstance) return;
    const inferred = inferDraftAccountId(
      config,
      collectionId,
      availableAccounts,
      selectedInstance.id,
      tradeState.accountId,
    );
    if (inferred) {
      updateTradingPaneState({ accountId: inferred });
    }
  }, [isGatewayMode, availableAccounts, tradeState.accountId, config, collectionId, selectedInstance]);

  const refresh = useCallback(async () => {
    if (!selectedInstance || !normalizedConfig || !isGatewayMode || !isGatewayConfigured(selectedInstance.config)) {
      setTradingMessage(undefined, gatewayRequiredMessage);
      return;
    }

    try {
      setTradingBusy(true);
      await refreshGatewayData(selectedInstance);
      const inferred = inferDraftAccountId(
        config,
        collectionId,
        availableAccounts,
        selectedInstance.id,
        tradeState.accountId,
      );
      if (inferred && !getTradingPaneState().accountId) {
        updateTradingPaneState({ accountId: inferred });
      }
      setTradingMessage(`Refreshed ${selectedInstance.label}.`, undefined);
    } catch (error: any) {
      setTradingMessage(undefined, error?.message || `Failed to refresh ${selectedInstance.label}.`);
    } finally {
      setTradingBusy(false);
    }
  }, [
    selectedInstance,
    normalizedConfig,
    isGatewayMode,
    config,
    collectionId,
    availableAccounts,
    tradeState.accountId,
    gatewayRequiredMessage,
  ]);

  useEffect(() => {
    if (!selectedInstance || !normalizedConfig || !isGatewayMode || !isGatewayConfigured(selectedInstance.config)) return;
    refresh().catch(() => {});
  }, [selectedInstance?.id, isGatewayMode, normalizedConfig ? JSON.stringify(normalizedConfig.gateway) : ""]);

  const chooseBrokerInstance = useCallback(async () => {
    if (lockedBrokerInstanceId) {
      setTradingMessage(undefined, "This console is locked to the active broker-managed portfolio.");
      return;
    }
    if (gatewayInstances.length === 0) {
      setTradingMessage(undefined, "Connect a Gateway / TWS IBKR profile first.");
      return;
    }
    const selected = await promptIbkrProfileChoice(dialog, gatewayInstances);
    if (!selected) return;
    const instance = getBrokerInstance(config.brokerInstances, selected);
    if (!instance) return;
    updateTradingPaneState({
      brokerInstanceId: instance.id,
      brokerLabel: instance.label,
      accountId: undefined,
      selectedOpenOrderIndex: 0,
      lastError: undefined,
      lastInfo: undefined,
    });
  }, [dialog, gatewayInstances, lockedBrokerInstanceId, config.brokerInstances]);

  const chooseAccount = useCallback(async () => {
    if (!selectedInstance || !normalizedConfig || !gatewayService || !isGatewayMode) return;
    if (availableAccounts.length === 0) {
      await refresh();
    }

    const nextAccounts = getKnownIbkrAccounts(
      brokerAccounts,
      selectedInstance.id,
      gatewayService.getSnapshot().accounts,
    );
    if (nextAccounts.length === 0) {
      setTradingMessage(undefined, "No IBKR accounts available.");
      return;
    }

    const selected = await promptIbkrAccountChoice(dialog, selectedInstance, nextAccounts);
    if (!selected) return;
    updateTradingPaneState({ accountId: selected });
  }, [availableAccounts, brokerAccounts, dialog, gatewayService, isGatewayMode, normalizedConfig, refresh, selectedInstance]);

  const cancelSelectedOrder = useCallback(async () => {
    if (!selectedOrder || !selectedInstance || !normalizedConfig || !gatewayService || !isGatewayMode) return;
    try {
      setTradingBusy(true);
      await gatewayService.cancelOrder(normalizedConfig.gateway, selectedOrder.orderId);
      setTradingMessage(`Cancelled order ${selectedOrder.orderId}.`, undefined);
      await refresh();
    } catch (error: any) {
      setTradingMessage(undefined, error?.message || "Failed to cancel order.");
    } finally {
      setTradingBusy(false);
    }
  }, [selectedOrder, selectedInstance, normalizedConfig, gatewayService, isGatewayMode, refresh]);

  const openSelectedOrder = useCallback(() => {
    if (!selectedOrder) return;
    const ticker = findTickerForOrder(selectedOrder, tickers);
    if (!ticker) {
      setTradingMessage(undefined, `No local ticker exists for ${selectedOrder.contract.localSymbol || selectedOrder.contract.symbol}.`);
      return;
    }
    loadOrderIntoDraft(ticker.metadata.ticker, selectedOrder, ticker);
    updateTradingPaneState({
      brokerInstanceId: selectedOrder.brokerInstanceId ?? selectedOrder.contract.brokerInstanceId,
      accountId: selectedOrder.accountId,
      lastInfo: `Loaded order ${selectedOrder.orderId} into ${ticker.metadata.ticker}.`,
      lastError: undefined,
    });
    selectTicker(ticker.metadata.ticker, paneId);
    switchTab("ibkr-trade", paneId);
    switchPanel("right");
  }, [selectedOrder, tickers, paneId, selectTicker, switchTab, switchPanel]);

  const footerActionsRef = useRef<{
    chooseBrokerInstance: () => Promise<void>;
    chooseAccount: () => Promise<void>;
    openSelectedOrder: () => void;
    cancelSelectedOrder: () => Promise<void>;
    refresh: () => Promise<void>;
  }>({
    chooseBrokerInstance: async () => {},
    chooseAccount: async () => {},
    openSelectedOrder: () => {},
    cancelSelectedOrder: async () => {},
    refresh: async () => {},
  });
  footerActionsRef.current = {
    chooseBrokerInstance,
    chooseAccount,
    openSelectedOrder,
    cancelSelectedOrder,
    refresh,
  };

  usePaneFooter("ibkr-trading-pane", () => ({
    hints: [
      { id: "profile", key: "i", label: "profile", onPress: () => footerActionsRef.current.chooseBrokerInstance().catch(() => {}) },
      { id: "account", key: "a", label: "ccount", onPress: () => footerActionsRef.current.chooseAccount().catch(() => {}) },
      { id: "modify", key: "m", label: "odify", onPress: () => footerActionsRef.current.openSelectedOrder() },
      { id: "cancel", key: "c", label: "ancel", onPress: () => footerActionsRef.current.cancelSelectedOrder().catch(() => {}) },
    ],
  }), []);

  useShortcut((event) => {
    if (!focused) return;
    event.stopPropagation?.();

    if (isPlainKey(event, "j", "down")) {
      const nextIndex = Math.min(tradeState.selectedOpenOrderIndex + 1, Math.max(0, gatewaySnapshot.openOrders.length - 1));
      updateTradingPaneState({ selectedOpenOrderIndex: nextIndex });
      return;
    }

    if (isPlainKey(event, "k", "up")) {
      const nextIndex = Math.max(0, tradeState.selectedOpenOrderIndex - 1);
      updateTradingPaneState({ selectedOpenOrderIndex: nextIndex });
      return;
    }

    switch (event.name) {
      case "r":
        refresh().catch(() => {});
        break;
      case "i":
        chooseBrokerInstance().catch(() => {});
        break;
      case "a":
        chooseAccount().catch(() => {});
        break;
      case "m":
      case "return":
      case "enter":
        openSelectedOrder();
        break;
      case "c":
        cancelSelectedOrder().catch(() => {});
        break;
    }
  });

  const activeAccount = availableAccounts.find((account) => account.accountId === (tradeState.accountId || ""));
  const getOrderQuote = useCallback((symbol: string) => {
    const ticker = tickers.get(symbol) ?? null;
    const instrument = instrumentFromTicker(ticker, symbol);
    return instrument ? resolveTickerFinancialsForInstrument(instrument)?.quote ?? null : null;
  }, [tickers]);

  return (
    <TradingPaneView
      activeAccount={activeAccount}
      displayStatusState={displayStatusState}
      gatewayInstancesCount={gatewayInstances.length}
      gatewaySnapshot={gatewaySnapshot}
      getOrderQuote={getOrderQuote}
      height={height}
      isGatewayMode={isGatewayMode}
      lockedBrokerInstanceId={lockedBrokerInstanceId}
      onOpenSelectedOrder={openSelectedOrder}
      onSelectExecutionSymbol={(symbol) => {
        if (tickers.has(symbol)) {
          selectTicker(symbol, paneId);
        }
      }}
      onSelectOpenOrderIndex={(index) => updateTradingPaneState({ selectedOpenOrderIndex: index })}
      selectedInstance={selectedInstance}
      tradeState={tradeState}
      width={width}
      focused={focused}
    />
  );
}
