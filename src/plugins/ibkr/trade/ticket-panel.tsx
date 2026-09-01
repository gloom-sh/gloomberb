import type { Dispatch, SetStateAction } from "react";
import { Box, Text } from "../../../ui";
import { TextAttributes } from "../../../ui";
import { colors } from "../../../theme/colors";
import type { BrokerContractRef } from "../../../types/instrument";
import type { TickerRecord } from "../../../types/ticker";
import { formatMarketPrice, formatMarketQuantity } from "../../../market-data/market/format";
import type { TradeTicketState } from "../trading/state";
import { truncateTradeText as truncateText } from "./utils";

function TradeFieldPill({
  id,
  label,
  value,
  fieldWidth,
  fieldHoverBg,
  hoveredField,
  setHoveredField,
  valueColor,
  valueAttributes = 0,
  disabled = false,
  active = false,
  widthOverride,
  onEnterInteractive,
  onPress,
}: {
  id: string;
  label: string;
  value: string;
  fieldWidth: number;
  fieldHoverBg: string;
  hoveredField: string | null;
  setHoveredField: Dispatch<SetStateAction<string | null>>;
  valueColor?: string;
  valueAttributes?: number;
  disabled?: boolean;
  active?: boolean;
  widthOverride?: number;
  onEnterInteractive: () => void;
  onPress?: () => void;
}) {
  const itemWidth = widthOverride ?? fieldWidth;
  const valueWidth = Math.max(4, itemWidth - label.length - 3);
  const hovered = hoveredField === id;
  const backgroundColor = disabled
    ? colors.panel
    : active
      ? colors.selected
      : hovered
        ? fieldHoverBg
        : colors.panel;
  const labelColor = disabled
    ? colors.textMuted
    : active
      ? colors.selectedText
      : hovered
        ? colors.textBright
        : colors.textDim;
  const resolvedValueColor = active
    ? colors.selectedText
    : hovered
      ? colors.textBright
      : valueColor ?? (disabled ? colors.textMuted : colors.text);

  return (
    <Box
      key={id}
      width={itemWidth}
      minWidth={16}
      height={1}
      flexDirection="row"
      backgroundColor={backgroundColor}
      paddingX={1}
      marginRight={1}
      onMouseOver={() => {
        if (!disabled) setHoveredField((current) => (current === id ? current : id));
      }}
      onMouseDown={disabled ? undefined : () => {
        onEnterInteractive();
        onPress?.();
      }}
    >
      <Text fg={labelColor}>{label}</Text>
      <Text fg={resolvedValueColor} attributes={valueAttributes}>
        {` ${truncateText(value, valueWidth)}`}
      </Text>
    </Box>
  );
}

export function TradeTicketPanel({
  interactive,
  panelWidth,
  ticketPanelWidth,
  coreFieldWidth,
  orderFieldWidth,
  fieldWidth,
  fieldTextWidth,
  fieldHoverBg,
  hoveredField,
  setHoveredField,
  ticketHint,
  profileLabel,
  hasProfile,
  contractValue,
  hasContract,
  currentAccountId,
  hasAccount,
  ticketState,
  ticker,
  activeContract,
  showLimit,
  showStop,
  contractMeta,
  onEnterInteractive,
  onChooseBrokerInstance,
  onChooseInstrument,
  onChooseAccount,
  onToggleSide,
  onEditOrderType,
  onEditQuantity,
  onEditLimitPrice,
  onEditStopPrice,
}: {
  interactive: boolean;
  panelWidth?: number;
  ticketPanelWidth: number;
  coreFieldWidth: number;
  orderFieldWidth: number;
  fieldWidth: number;
  fieldTextWidth: number;
  fieldHoverBg: string;
  hoveredField: string | null;
  setHoveredField: Dispatch<SetStateAction<string | null>>;
  ticketHint: string;
  profileLabel?: string;
  hasProfile: boolean;
  contractValue: string;
  hasContract: boolean;
  currentAccountId?: string;
  hasAccount: boolean;
  ticketState: TradeTicketState;
  ticker: TickerRecord;
  activeContract: BrokerContractRef;
  showLimit: boolean;
  showStop: boolean;
  contractMeta: string;
  onEnterInteractive: () => void;
  onChooseBrokerInstance: () => void;
  onChooseInstrument: () => void;
  onChooseAccount: () => void;
  onToggleSide: () => void;
  onEditOrderType: () => void;
  onEditQuantity: () => void;
  onEditLimitPrice: () => void;
  onEditStopPrice: () => void;
}) {
  const fieldProps = {
    fieldWidth,
    fieldHoverBg,
    hoveredField,
    setHoveredField,
    onEnterInteractive,
  };

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      width={panelWidth}
      border
      borderStyle="rounded"
      borderColor={interactive ? colors.borderFocused : colors.border}
      paddingX={1}
    >
      <Box height={1} flexDirection="row">
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>Ticket</Text>
        <Box flexGrow={1} />
        <Text fg={interactive ? colors.positive : colors.textMuted}>
          {interactive ? "Captured" : "Ready"}
        </Text>
      </Box>
      <Text fg={colors.textMuted}>{truncateText(ticketHint, Math.max(ticketPanelWidth - 4, 24))}</Text>
      <Box height={1} />

      <Box flexDirection="row" flexWrap="wrap">
        <TradeFieldPill
          {...fieldProps}
          id="profile"
          label="Profile"
          value={profileLabel ?? "Choose profile"}
          active={hasProfile}
          widthOverride={coreFieldWidth}
          onPress={onChooseBrokerInstance}
        />
        <TradeFieldPill
          {...fieldProps}
          id="contract"
          label="Ticker"
          value={contractValue}
          active={hasContract}
          widthOverride={coreFieldWidth}
          onPress={onChooseInstrument}
        />
        <TradeFieldPill
          {...fieldProps}
          id="account"
          label="Account"
          value={currentAccountId || "Select account"}
          active={hasAccount}
          widthOverride={coreFieldWidth}
          onPress={onChooseAccount}
        />
      </Box>
      <Box height={1} />
      <Box flexDirection="row" flexWrap="wrap">
        <TradeFieldPill
          {...fieldProps}
          id="action"
          label="Side"
          value={ticketState.draft.action}
          valueColor={ticketState.draft.action === "BUY" ? colors.positive : colors.negative}
          valueAttributes={TextAttributes.BOLD}
          widthOverride={orderFieldWidth}
          onPress={onToggleSide}
        />
        <TradeFieldPill
          {...fieldProps}
          id="orderType"
          label="Type"
          value={ticketState.draft.orderType}
          widthOverride={orderFieldWidth}
          onPress={onEditOrderType}
        />
        <TradeFieldPill
          {...fieldProps}
          id="quantity"
          label="Qty"
          value={formatMarketQuantity(ticketState.draft.quantity, {
            assetCategory: ticker.metadata.assetCategory,
            contractSecType: activeContract.secType,
            maxWidth: fieldTextWidth,
          })}
          widthOverride={orderFieldWidth}
          onPress={onEditQuantity}
        />
        {showLimit && (
          <TradeFieldPill
            {...fieldProps}
            id="limitPrice"
            label="Limit"
            value={ticketState.draft.limitPrice != null
              ? formatMarketPrice(ticketState.draft.limitPrice, {
                assetCategory: ticker.metadata.assetCategory,
                contractSecType: activeContract.secType,
                maxWidth: fieldTextWidth,
              })
              : "—"}
            widthOverride={orderFieldWidth}
            onPress={onEditLimitPrice}
          />
        )}
        {showStop && (
          <TradeFieldPill
            {...fieldProps}
            id="stopPrice"
            label="Stop"
            value={ticketState.draft.stopPrice != null
              ? formatMarketPrice(ticketState.draft.stopPrice, {
                assetCategory: ticker.metadata.assetCategory,
                contractSecType: activeContract.secType,
                maxWidth: fieldTextWidth,
              })
              : "—"}
            widthOverride={orderFieldWidth}
            onPress={onEditStopPrice}
          />
        )}
        <TradeFieldPill
          {...fieldProps}
          id="tif"
          label="TIF"
          value={ticketState.draft.tif || "DAY"}
          widthOverride={orderFieldWidth}
        />
        {ticketState.editingOrderId && (
          <TradeFieldPill
            {...fieldProps}
            id="editing"
            label="Mode"
            value={`Edit #${ticketState.editingOrderId}`}
            valueColor={colors.textBright}
            widthOverride={orderFieldWidth}
          />
        )}
      </Box>
      <Box height={1} />
      <Text fg={colors.textMuted}>{contractMeta}</Text>
    </Box>
  );
}
