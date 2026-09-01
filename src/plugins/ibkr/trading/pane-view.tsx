import { useMemo } from "react";
import { Box, Text, TextAttributes } from "gloomberb/ui";
import { DataTableView, type DataTableCell, type DataTableColumn } from "gloomberb/components";
import { colors, priceColor } from "gloomberb/theme";
import type { BrokerInstanceConfig } from "gloomberb/types/config";
import type { Quote } from "gloomberb/types/financials";
import type { BrokerAccount } from "gloomberb/types/trading";
import { formatCurrency } from "gloomberb/utils";
import { formatMarketPrice, formatMarketQuantity } from "gloomberb/market-data";
import type { IbkrSnapshot } from "../gateway/types";
import type { TradingPaneState } from "./state";

type OpenOrder = IbkrSnapshot["openOrders"][number];
type Execution = IbkrSnapshot["executions"][number];

/** Below this the two panels cannot both hold a readable table, so they stack. */
const STACK_BELOW_WIDTH = 72;

const OPEN_ORDER_COLUMNS: DataTableColumn[] = [
  { id: "orderId", label: "ID", width: 7, align: "left" },
  { id: "action", label: "SIDE", width: 5, align: "left" },
  { id: "symbol", label: "SYMBOL", width: 14, align: "left" },
  { id: "status", label: "STATUS", width: 10, align: "left" },
  { id: "remaining", label: "QTY", width: 6, align: "right" },
  { id: "price", label: "PRICE", width: 9, align: "right" },
  { id: "bid", label: "BID", width: 8, align: "right" },
  { id: "ask", label: "ASK", width: 8, align: "right" },
];

const EXECUTION_COLUMNS: DataTableColumn[] = [
  { id: "side", label: "SIDE", width: 5, align: "left" },
  { id: "symbol", label: "SYMBOL", width: 16, align: "left" },
  { id: "shares", label: "QTY", width: 7, align: "right" },
  { id: "price", label: "PRICE", width: 10, align: "right" },
];

function renderOpenOrderCell(
  order: OpenOrder,
  column: DataTableColumn,
  getOrderQuote: (symbol: string) => Quote | null,
): DataTableCell {
  const secType = order.contract.secType;
  switch (column.id) {
    case "orderId":
      return { text: String(order.orderId), color: colors.text };
    case "action":
      return { text: order.action, color: priceColor(order.action.toUpperCase() === "BUY" ? 1 : -1) };
    case "symbol":
      return { text: order.contract.localSymbol || order.contract.symbol, color: colors.text, attributes: TextAttributes.BOLD };
    case "status":
      return { text: order.status, color: colors.textDim };
    case "remaining":
      return { text: formatMarketQuantity(order.remaining, { contractSecType: secType, maxWidth: 6 }), color: colors.text };
    case "price":
      return {
        text: order.limitPrice != null
          ? formatMarketPrice(order.limitPrice, { contractSecType: secType, maxWidth: 9 })
          : order.stopPrice != null
            ? formatMarketPrice(order.stopPrice, { contractSecType: secType, maxWidth: 9 })
            : "MKT",
        color: colors.text,
      };
    case "bid": {
      const bid = getOrderQuote(order.contract.symbol)?.bid;
      return {
        text: bid != null ? formatMarketPrice(bid, { contractSecType: secType, maxWidth: 8 }) : "---",
        color: colors.textDim,
      };
    }
    default: {
      const ask = getOrderQuote(order.contract.symbol)?.ask;
      return {
        text: ask != null ? formatMarketPrice(ask, { contractSecType: secType, maxWidth: 8 }) : "---",
        color: colors.textDim,
      };
    }
  }
}

function renderExecutionCell(execution: Execution, column: DataTableColumn): DataTableCell {
  const secType = execution.contract.secType;
  switch (column.id) {
    case "side":
      return { text: execution.side, color: priceColor(execution.side.toUpperCase() === "BOT" ? 1 : -1) };
    case "symbol":
      return { text: execution.contract.localSymbol || execution.contract.symbol, color: colors.text };
    case "shares":
      return { text: formatMarketQuantity(execution.shares, { contractSecType: secType, maxWidth: 7 }), color: colors.text };
    default:
      return { text: formatMarketPrice(execution.price, { contractSecType: secType }), color: colors.text };
  }
}

export function TradingPaneView({
  activeAccount,
  displayStatusState,
  gatewayInstancesCount,
  gatewaySnapshot,
  getOrderQuote,
  height,
  isGatewayMode,
  lockedBrokerInstanceId,
  onOpenSelectedOrder,
  onSelectExecutionSymbol,
  onSelectOpenOrderIndex,
  selectedInstance,
  tradeState,
  width,
  focused = false,
}: {
  activeAccount: BrokerAccount | undefined;
  displayStatusState: IbkrSnapshot["status"]["state"];
  gatewayInstancesCount: number;
  gatewaySnapshot: IbkrSnapshot;
  getOrderQuote: (symbol: string) => Quote | null;
  height: number;
  isGatewayMode: boolean;
  lockedBrokerInstanceId: string | null | undefined;
  onOpenSelectedOrder: () => void;
  onSelectExecutionSymbol: (symbol: string) => void;
  onSelectOpenOrderIndex: (index: number) => void;
  selectedInstance: BrokerInstanceConfig | undefined;
  tradeState: TradingPaneState;
  width: number;
  focused?: boolean;
}) {
  const stacked = width < STACK_BELOW_WIDTH;
  const bodyHeight = Math.max(4, height - 4);
  const orderPanelWidth = stacked ? Math.max(8, width - 2) : Math.max(24, Math.floor(width * 0.6));
  const listPanelWidth = stacked ? Math.max(8, width - 2) : Math.max(16, width - orderPanelWidth - 1);
  const orderPanelHeight = stacked ? Math.max(2, Math.ceil(bodyHeight / 2)) : bodyHeight;
  const executionPanelHeight = stacked ? Math.max(2, bodyHeight - orderPanelHeight) : bodyHeight;

  const executions = useMemo(
    () => gatewaySnapshot.executions.slice(0, 20),
    [gatewaySnapshot.executions],
  );

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box flexDirection="row" height={1}>
        <Box flexGrow={1} overflow="hidden">
          <Text fg={
            displayStatusState === "connected"
              ? colors.positive
              : displayStatusState === "error"
                ? colors.negative
                : colors.textDim
          }>
            {selectedInstance
              ? `${selectedInstance.label} · ${isGatewayMode ? "Gateway" : "Flex"} · ${displayStatusState}`
              : "IBKR · no profile selected"}
          </Text>
        </Box>
        {tradeState.busy && <Text fg={colors.textDim}>Working...</Text>}
      </Box>

      <Box height={1} overflow="hidden">
        <Text fg={colors.textDim}>
          {activeAccount
            ? `${selectedInstance?.label || "IBKR"} → ${activeAccount.accountId} · ${formatCurrency(activeAccount.netLiquidation || 0, activeAccount.currency || "USD")} net liq`
            : isGatewayMode
              ? lockedBrokerInstanceId
                ? `Locked to ${selectedInstance?.label || "IBKR"}`
                : "No account selected"
              : gatewayInstancesCount > 0
                ? "Choose a Gateway / TWS profile"
                : "Connect an IBKR profile"}
        </Text>
      </Box>

      <Box height={1} overflow="hidden">
        <Text fg={tradeState.lastError ? colors.negative : colors.textDim}>
          {tradeState.lastError
            || gatewaySnapshot.status.message
            || gatewaySnapshot.lastError
            || tradeState.lastInfo
            || "Use this console for profile status, accounts, open orders, and executions."}
        </Text>
      </Box>

      <Box height={1} width={Math.max(1, width - 2)} backgroundColor={colors.border} />

      <Box flexDirection={stacked ? "column" : "row"} height={bodyHeight}>
        <Box width={orderPanelWidth} height={orderPanelHeight} flexDirection="column">
          <Box height={1}>
            <Text attributes={TextAttributes.BOLD} fg={colors.textBright}>Open Orders</Text>
          </Box>
          <DataTableView<OpenOrder>
            focused={focused}
            columns={OPEN_ORDER_COLUMNS}
            items={gatewaySnapshot.openOrders}
            sortColumnId={null}
            sortDirection="asc"
            onHeaderClick={() => {}}
            getItemKey={(order) => String(order.orderId)}
            renderCell={(order, column) => renderOpenOrderCell(order, column, getOrderQuote)}
            selection={{
              kind: "index",
              selectedIndex: tradeState.selectedOpenOrderIndex,
              onChange: (index) => onSelectOpenOrderIndex(index),
            }}
            onActivate={onOpenSelectedOrder}
            emptyStateTitle="No open IBKR orders."
          />
        </Box>

        {!stacked && <Box width={1} height={bodyHeight} backgroundColor={colors.border} />}

        <Box width={listPanelWidth} height={executionPanelHeight} flexDirection="column">
          <Box height={1}>
            <Text attributes={TextAttributes.BOLD} fg={colors.textBright}>Executions</Text>
          </Box>
          <DataTableView<Execution>
            columns={EXECUTION_COLUMNS}
            items={executions}
            sortColumnId={null}
            sortDirection="asc"
            onHeaderClick={() => {}}
            getItemKey={(execution) => execution.execId}
            renderCell={renderExecutionCell}
            selection={{ kind: "none" }}
            onActivate={(execution) => {
              const symbol = execution.contract.symbol;
              if (symbol) onSelectExecutionSymbol(symbol);
            }}
            onRowMouseDown={(execution) => {
              const symbol = execution.contract.symbol;
              if (symbol) onSelectExecutionSymbol(symbol);
            }}
            emptyStateTitle="No recent executions."
          />
        </Box>
      </Box>
    </Box>
  );
}
