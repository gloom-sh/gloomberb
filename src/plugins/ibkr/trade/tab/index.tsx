import { Box, ScrollBox, Text } from "gloomberb/ui";
import { useDialog } from "gloomberb/dialog";
import { useCallback, useEffect, useState } from "react";
import {
  useAppSelector,
  usePaneCollection,
  usePaneInstanceId,
  usePaneTicker,
} from "gloomberb/react";
import { colors, hoverBg } from "gloomberb/theme";
import type { TickerResearchTabProps } from "gloomberb/types/plugin";
import { isGatewayConfigured } from "../../config";
import { useIbkrGatewaySelection } from "../../gateway/selection";
import { TradePreviewPanel } from "../preview-panel";
import { TradeTabHeader } from "./header";
import { TradeTicketPanel } from "../ticket-panel";
import {
  getTradeTicketState,
  useTradingPaneState,
} from "../../trading/state";
import { inferDraftAccountId, isLimitOrder, isStopOrder } from "../utils";
import {
  resolveTradeConnectionTone,
  resolveTradeContractDisplay,
  resolveTradeNextStep,
  resolveTradePreviewDisplay,
  resolveTradeStatus,
  resolveTradeTabLayout,
} from "./model";
import { useTradeTabFooter } from "./footer";
import { useTradeTabActions } from "./actions";
import { useTradeTabShortcuts } from "./shortcuts";
import { useTradeTicketSync } from "./state-sync";

export function TradeTab({ focused, width, onCapture }: TickerResearchTabProps) {
  const config = useAppSelector((state) => state.config);
  const brokerAccounts = useAppSelector((state) => state.brokerAccounts);
  const paneId = usePaneInstanceId();
  const { collectionId } = usePaneCollection(paneId);
  const { ticker, financials } = usePaneTicker(paneId);
  const dialog = useDialog();
  const tradeState = useTradingPaneState();
  const [interactive, setInteractive] = useState(false);
  const [hoveredField, setHoveredField] = useState<string | null>(null);
  const fieldHoverBg = hoverBg();

  const symbol = ticker?.metadata.ticker ?? null;
  const ticketState = getTradeTicketState(symbol, ticker);
  const preferredInstanceId = ticketState.brokerInstanceId ?? tradeState.brokerInstanceId;
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
    preferredInstanceId,
  );
  const inferredAccountId = selectedInstance
    ? inferDraftAccountId(
      config,
      collectionId,
      availableAccounts,
      selectedInstance.id,
      tradeState.accountId,
    )
    : undefined;
  const currentAccountId = ticketState.draft.accountId || inferredAccountId;
  const activeAccount = availableAccounts.find((account) => account.accountId === currentAccountId);
  const lockedAccountId = selectedInstance && lockedBrokerInstanceId === selectedInstance.id
    ? activePortfolio?.brokerAccountId
    : undefined;

  const enterInteractive = useCallback(() => {
    setInteractive(true);
    onCapture(true);
  }, [onCapture]);

  const exitInteractive = useCallback(() => {
    setInteractive(false);
    onCapture(false);
  }, [onCapture]);

  useEffect(() => {
    if (!focused) {
      exitInteractive();
    }
  }, [focused, exitInteractive]);

  useEffect(() => {
    exitInteractive();
  }, [symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  useTradeTicketSync({
    availableAccounts,
    collectionId,
    config,
    isGatewayMode,
    lockedAccountId,
    selectedInstance,
    symbol,
    ticker,
    ticketState,
    tradeStateAccountId: tradeState.accountId,
  });

  const actions = useTradeTabActions({
    availableAccounts,
    brokerAccounts,
    collectionId,
    config,
    currentAccountId,
    dialog,
    financials,
    gatewayInstances,
    gatewayRequiredMessage,
    gatewayService,
    isGatewayMode,
    lockedBrokerInstanceId,
    normalizedConfig,
    selectedInstance,
    symbol,
    ticketState,
    ticker,
    tradeState,
  });

  useEffect(() => {
    if (!selectedInstance || !normalizedConfig || !isGatewayMode || !isGatewayConfigured(selectedInstance.config) || !symbol) return;
    actions.refresh().catch(() => {});
  }, [symbol, selectedInstance?.id, isGatewayMode, normalizedConfig ? JSON.stringify(normalizedConfig.gateway) : ""]); // eslint-disable-line react-hooks/exhaustive-deps

  const showLimit = isLimitOrder(ticketState.draft.orderType);
  const showStop = isStopOrder(ticketState.draft.orderType);
  useTradeTabShortcuts({
    actions,
    enterInteractive,
    exitInteractive,
    focused,
    interactive,
    showLimit,
    showStop,
    symbol,
    ticketState,
    ticker,
  });

  const hasProfile = Boolean(selectedInstance);
  const {
    wideLayout,
    previewPanelWidth,
    ticketPanelWidth,
    fieldsPerRow,
    fieldWidth,
    coreFieldWidth,
    orderFieldWidth,
    fieldTextWidth,
    previewTextWidth,
    previewMetricWidth,
  } = resolveTradeTabLayout(width);
  const {
    activeContract,
    hasContract,
    contractValue,
    contractMeta,
  } = resolveTradeContractDisplay({
    ticketState,
    ticker,
    fieldTextWidth,
    fieldsPerRow,
  });
  const hasAccount = Boolean(currentAccountId);
  const hasPreview = Boolean(ticketState.preview);
  const connectionTone = resolveTradeConnectionTone(gatewaySnapshot);
  const { statusTone, statusText } = resolveTradeStatus({ ticketState, gatewaySnapshot });
  const { previewTone, previewHeading } = resolveTradePreviewDisplay(ticketState);
  const { nextStep, workflowTone } = resolveTradeNextStep({
    hasProfile,
    hasContract,
    hasAccount,
    hasPreview,
    editingOrderId: ticketState.editingOrderId,
  });
  const ticketHint = interactive
    ? "Field shortcuts stay active while captured."
    : "Click a field to edit. Shortcuts are in the pane footer.";

  useTradeTabFooter({
    actions,
    canEnterOrder: hasProfile && hasAccount,
    showLimit,
    showStop,
    symbol,
    ticketState,
    ticker,
  });

  if (!ticker || !symbol) {
    return (
      <Box flexGrow={1} alignItems="center" justifyContent="center">
        <Text fg={colors.textDim}>Select a ticker to draft an IBKR trade.</Text>
      </Box>
    );
  }

  return (
    <ScrollBox flexGrow={1} scrollY>
      <Box
        flexDirection="column"
        paddingX={1}
        paddingBottom={1}
        gap={1}
        onMouseDown={!interactive ? enterInteractive : undefined}
      >
        <TradeTabHeader
          ticker={ticker}
          financials={financials}
          profileLabel={selectedInstance?.label}
          isGatewayMode={isGatewayMode}
          connectionTone={connectionTone}
          currentAccountId={currentAccountId}
          lockedBrokerInstanceId={lockedBrokerInstanceId}
          hasAccount={hasAccount}
          activeAccount={activeAccount}
          interactive={interactive}
          nextStep={nextStep}
          workflowTone={workflowTone}
          statusTone={statusTone}
          statusText={statusText}
          busy={ticketState.busy}
          hasError={Boolean(ticketState.lastError)}
          isSuccess={Boolean(ticketState.isSuccess)}
          onEnterInteractive={enterInteractive}
          onExitInteractive={exitInteractive}
          onChooseBrokerInstance={() => actions.chooseBrokerInstance().catch(() => {})}
          onChooseAccount={() => actions.chooseAccount().catch(() => {})}
          onRefresh={() => actions.refresh().catch(() => {})}
        />

        <Box flexDirection={wideLayout ? "row" : "column"} alignItems="stretch" gap={1}>
          <TradeTicketPanel
            interactive={interactive}
            panelWidth={wideLayout ? ticketPanelWidth : undefined}
            ticketPanelWidth={ticketPanelWidth}
            coreFieldWidth={coreFieldWidth}
            orderFieldWidth={orderFieldWidth}
            fieldWidth={fieldWidth}
            fieldTextWidth={fieldTextWidth}
            fieldHoverBg={fieldHoverBg}
            hoveredField={hoveredField}
            setHoveredField={setHoveredField}
            ticketHint={ticketHint}
            profileLabel={selectedInstance?.label}
            hasProfile={hasProfile}
            contractValue={contractValue}
            hasContract={hasContract}
            currentAccountId={currentAccountId}
            hasAccount={hasAccount}
            ticketState={ticketState}
            ticker={ticker}
            activeContract={activeContract}
            showLimit={showLimit}
            showStop={showStop}
            contractMeta={contractMeta}
            onEnterInteractive={enterInteractive}
            onChooseBrokerInstance={() => actions.chooseBrokerInstance().catch(() => {})}
            onChooseInstrument={() => actions.chooseInstrument().catch(() => {})}
            onChooseAccount={() => actions.chooseAccount().catch(() => {})}
            onToggleSide={actions.toggleSide}
            onEditOrderType={() => actions.editOrderType().catch(() => {})}
            onEditQuantity={() => actions.editQuantity().catch(() => {})}
            onEditLimitPrice={() => actions.editLimitPrice().catch(() => {})}
            onEditStopPrice={() => actions.editStopPrice().catch(() => {})}
          />

          <TradePreviewPanel
            previewPanelWidth={previewPanelWidth}
            previewTextWidth={previewTextWidth}
            previewMetricWidth={previewMetricWidth}
            previewTone={previewTone}
            previewHeading={previewHeading}
            ticketState={ticketState}
            onPreviewOrder={() => actions.previewOrder().catch(() => {})}
            onSubmitOrder={() => actions.submitOrder().catch(() => {})}
          />
        </Box>
      </Box>
    </ScrollBox>
  );
}
