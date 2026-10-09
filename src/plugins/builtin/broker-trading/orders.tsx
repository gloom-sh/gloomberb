import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { Badge, Button, DataTableView, PaneStatusBody, RatioBar, SegmentedControl, confirmDialog, usePaneFooter, usePaneNoticeFooter, type DataTableCell, type DataTableColumn, type SelectControl } from "../../../components";
import { loadingErrorFooterInfo, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { usePaneVisible } from "../../../state/app/activity";
import { colors } from "../../../theme/colors";
import type { BrokerAdapter } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { BrokerAccount, BrokerExecution, BrokerOrder } from "../../../types/trading";
import { Box, Text, TextAttributes } from "../../../ui";
import { useDialog, useDialogState } from "../../../ui/dialog";
import { formatNumber } from "../../../utils/format";
import { BrokerTradingController, type BrokerTradingContext } from "./controller";
import { BrokerAccountPicker } from "./account-picker";
import { brokerOrderKey, brokerOrderStatus, canChangeBrokerOrder, loadBrokerOrdersSnapshot, type BrokerOrdersSnapshot } from "./orders-data";

export interface BrokerOrdersViewProps {
  broker: BrokerAdapter;
  instance: BrokerInstanceConfig;
  accounts: BrokerAccount[];
  accountId?: string;
  onAccountChange: (accountId: string) => void;
  onModify: (order: BrokerOrder) => void;
  onBack?: () => void;
  width: number;
  height: number;
  focused: boolean;
  active?: boolean;
  initialSnapshot?: BrokerOrdersSnapshot;
}

const orderColumns: DataTableColumn[] = [
  { id: "symbol", label: "Symbol", width: 8, align: "left" }, { id: "side", label: "Side", width: 6, align: "left" },
  { id: "status", label: "Status", width: 16, align: "left" }, { id: "quantity", label: "Filled / Qty", width: 14, align: "right" },
  { id: "type", label: "Type", width: 4, align: "left" }, { id: "price", label: "Price", width: 8, align: "right" },
  { id: "age", label: "Age", width: 4, align: "right" }, { id: "actions", label: "", width: 14, align: "right" },
];
const activityColumns: DataTableColumn[] = [
  { id: "symbol", label: "Symbol", width: 18, align: "left" }, { id: "side", label: "Side", width: 5, align: "left" },
  { id: "quantity", label: "Quantity", width: 12, align: "right" }, { id: "price", label: "Price", width: 12, align: "right" },
  { id: "fees", label: "Fees", width: 12, align: "right" }, { id: "age", label: "Age", width: 5, align: "right" },
];
const quantity = (value: number) => Number.isFinite(value) ? formatNumber(value, Number.isInteger(value) ? 0 : 4) : "--";
const price = (value: number | undefined) => value != null && Number.isFinite(value) ? formatNumber(value, 2) : "--";
const accountMode = (account: BrokerAccount | undefined) => account?.tradingMode === "simulation" ? "SIMULATION" : account?.tradingMode === "live" ? "LIVE" : "UNKNOWN";
const terminalStatuses = new Set(["Cancelled", "Filled", "Rejected", "Expired"]);

function age(timestamp: number, now: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "--";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function renderOrderCell(order: BrokerOrder, column: DataTableColumn, now: number): DataTableCell {
  const status = brokerOrderStatus(order.status);
  switch (column.id) {
    case "symbol": return { text: order.contract.localSymbol || order.contract.symbol, attributes: TextAttributes.BOLD };
    case "status": return { text: status, content: <Badge label={status === "Partially filled" ? "Partial fill" : status} variant={status === "Working" ? "solid" : "subtle"} tone={status === "Rejected" ? "negative" : status === "Filled" ? "positive" : ["UNKNOWN", "Pending cancel", "Partially filled"].includes(status) ? "warning" : "accent"} /> };
    case "side": return { text: order.action, content: <Badge label={order.action} tone={order.action === "BUY" ? "positive" : "negative"} /> };
    case "quantity": return { text: `${quantity(order.filled)} / ${quantity(order.quantity)}`, content: <Box flexDirection="row" gap={1} alignItems="center" justifyContent="flex-end" width={column.width}>
      <RatioBar ratio={order.quantity > 0 ? order.filled / order.quantity : 0} width={4} color={order.filled > 0 ? colors.positive : colors.textMuted} track thickness={5} />
      <Text fg={colors.text} truncate wrapMode="none">{`${quantity(order.filled)} / ${quantity(order.quantity)}`}</Text>
    </Box> };
    case "type": return { text: order.orderType };
    case "price": return { text: order.orderType === "MKT" ? "Market" : price(order.limitPrice ?? order.stopPrice) };
    default: return { text: age(order.updatedAt, now), color: colors.textDim };
  }
}

function renderExecutionCell(execution: BrokerExecution, column: DataTableColumn, now: number): DataTableCell {
  switch (column.id) {
    case "symbol": return { text: execution.contract.localSymbol || execution.contract.symbol };
    case "side": return { text: execution.side, content: <Badge label={execution.side} tone={["BUY", "BOT", "B"].includes(execution.side.toUpperCase()) ? "positive" : "negative"} /> };
    case "quantity": return { text: quantity(execution.shares), value: execution.shares };
    case "price": return { text: price(execution.price), value: execution.price };
    case "fees": return { text: execution.commission === undefined ? "--" : `${price(execution.commission)} ${execution.commissionCurrency ?? ""}`.trim() };
    default: return { text: age(execution.time, now), color: colors.textDim };
  }
}

export function BrokerOrdersView({ broker, instance, accounts, accountId, onAccountChange, onModify, onBack, width, height, focused, active = true, initialSnapshot }: BrokerOrdersViewProps) {
  const [view, setView] = useState<"open" | "activity">("open");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedKeyRef = useRef<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [, connectionChanged] = useReducer((value: number) => value + 1, 0);
  const dialog = useDialog();
  const dialogOpen = useDialogState((state) => state.isOpen);
  const accountControl = useRef<SelectControl>(null);
  const keyboardScope = `broker-orders:${useId()}`;
  const visible = usePaneVisible();
  const account = accounts.find((item) => item.accountId === accountId);
  const connection = broker.getStatus?.(instance) ?? { state: "disconnected" as const, updatedAt: 0 };
  const context = useRef<BrokerTradingContext>({ adapter: broker, instance, accounts, accountId, connection });
  context.current = { adapter: broker, instance, accounts, accountId, connection };
  const controller = useMemo(() => new BrokerTradingController({ getContext: () => context.current }), [broker, instance.id]);
  const trading = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => { controller.syncContext(); }, [controller, instance, accountId, accounts, connection.state]);
  useEffect(() => broker.subscribeStatus?.(instance, connectionChanged), [broker, instance]);

  const loader = useCallback(() => loadBrokerOrdersSnapshot(broker, instance, accountId!), [broker, instance, accountId]);
  const canRead = active && !!account && connection.state === "connected";
  const resource = useAsyncResource(canRead ? loader : null, { initialData: () => initialSnapshot && initialSnapshot.accountId === accountId && initialSnapshot.brokerInstanceId === instance.id ? initialSnapshot : null });
  const reconcile = useCallback(async () => {
    await controller.refreshResult();
    const result = controller.getSnapshot().result;
    if (!result) return;
    const status = brokerOrderStatus(result.status);
    setMessage(status === "Cancelled" ? "Cancelled. Broker confirmed." : status === "Filled" ? "Filled. The broker confirmed the order filled before cancellation."
      : status === "UNKNOWN" ? "Outcome unknown. Refresh and reconcile in your broker." : "Cancellation requested. Awaiting broker confirmation.");
  }, [controller]);
  useEffect(() => {
    if (!canRead || !visible || resource.loading || (!resource.data?.orders.length && !trading.result)) return;
    const timer = setTimeout(() => { void reconcile().catch(() => {}); void resource.reload(); }, 15_000);
    return () => clearTimeout(timer);
  }, [canRead, visible, resource.loading, resource.data, resource.updatedAt, resource.error, resource.reload, trading.result, reconcile]);
  const refresh = useCallback(() => {
    void reconcile().catch(() => setMessage("Could not reconcile this order. Check its status in your broker."));
    void resource.reload();
  }, [reconcile, resource.reload]);
  usePaneRefreshKey(refresh, { focused, enabled: active && !!account });

  const snapshot = resource.data;
  const rows = useMemo(() => {
    const source = snapshot?.orders ?? [];
    const result = trading.result;
    if (!result || result.accountId !== accountId) return source;
    const status = brokerOrderStatus(result.status);
    const pending = ["UNKNOWN", "Pending cancel"].includes(status);
    if (!pending && !terminalStatuses.has(status)) return source;
    const key = brokerOrderKey(result);
    return source.some((order) => brokerOrderKey(order) === key)
      ? source.map((order) => brokerOrderKey(order) === key ? result : order) : pending ? [result, ...source] : source;
  }, [snapshot, trading.result, accountId]);
  const selected = rows.find((order) => brokerOrderKey(order) === selectedKey) ?? rows[0];
  const capabilities = broker.getTradingCapabilities?.(instance, selected?.contract);
  const busy = trading.phase === "cancelling" || trading.phase === "cancel-review";
  const changeable = !!selected && canRead && capabilities?.enabled === true && canChangeBrokerOrder(selected) && !busy;
  const canModify = changeable && !!broker.modifyOrder && capabilities?.modify === true;
  const canCancel = changeable && !!broker.cancelOrder && capabilities?.cancel === true;
  const modifyOrder = useCallback((order: BrokerOrder) => {
    const capability = broker.getTradingCapabilities?.(instance, order.contract);
    if (canRead && !busy && broker.modifyOrder && capability?.enabled && capability.modify && canChangeBrokerOrder(order)) onModify(order);
  }, [broker, instance, canRead, busy, onModify]);
  const modify = useCallback(() => { const order = rows.find((row) => brokerOrderKey(row) === selectedKeyRef.current) ?? rows[0]; if (order) modifyOrder(order); }, [rows, modifyOrder]);
  const cancelOrder = useCallback(async (order: BrokerOrder) => {
    const capability = broker.getTradingCapabilities?.(instance, order.contract);
    if (!account || !canRead || busy || !broker.cancelOrder || !capability?.enabled || !capability.cancel || !canChangeBrokerOrder(order)) return;
    setMessage(null);
    try {
      controller.requestCancel(order);
      const confirmed = await confirmDialog(dialog, {
        title: `Cancel ${order.contract.localSymbol || order.contract.symbol} order?`,
        body: [`${order.action} ${quantity(order.quantity)} ${order.contract.localSymbol || order.contract.symbol}. ${quantity(order.remaining)} remaining.`, `${broker.name} ${accountMode(account)} · ${account.name}`],
        confirmLabel: "Cancel order", cancelLabel: "Keep order", confirmVariant: "danger",
      });
      await controller.confirmCancel(confirmed);
      if (confirmed) {
        const result = controller.getSnapshot().result;
        setMessage(result?.status === "UNKNOWN" ? "Outcome unknown. Refresh and reconcile in your broker." : "Cancellation requested. Awaiting broker confirmation.");
        if (result?.status !== "UNKNOWN") await reconcile().catch(() => {});
        void resource.reload();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Cancellation could not be confirmed.");
    }
  }, [account, canRead, busy, broker, instance, controller, dialog, resource.reload, reconcile]);
  const cancel = useCallback(() => { const order = rows.find((row) => brokerOrderKey(row) === selectedKeyRef.current) ?? rows[0]; return order ? cancelOrder(order) : Promise.resolve(); }, [rows, cancelOrder]);
  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped || event.targetEditable || event.ctrl || event.meta || event.alt || event.shift || event.super || busy) return;
    const invoke = event.name === "a" ? () => accountControl.current?.open()
      : event.name === "v" && account ? () => setView(view === "open" ? "activity" : "open")
        : event.name === "m" && view === "open" && canModify ? modify
          : event.name === "c" && view === "open" && canCancel ? () => { void cancel(); }
            : event.name === "r" && account ? refresh
              : event.name === "escape" && onBack ? onBack : undefined;
    if (!invoke) return;
    event.preventDefault(); event.stopPropagation(); invoke();
  }, { enabled: focused && active && !dialogOpen, phase: "before", scope: keyboardScope });

  const status = connection.state !== "connected" ? "Broker disconnected" : trading.error ?? message ?? resource.error
    ?? (capabilities?.enabled === false ? capabilities.disabledReason ?? "Trading is off" : null);
  usePaneNoticeFooter({ registrationId: "broker-orders-notices", focused, enabled: active, notices: [...(snapshot?.errors ?? []), ...(snapshot?.notes ?? [])] });
  usePaneFooter("broker-orders", () => active ? {
    info: loadingErrorFooterInfo(resource.loading || trading.phase === "cancelling", status),
    hints: busy ? [] : [
      ...(view === "open" && selected ? [
        ...(canModify ? [{ id: "modify-order", key: "m", label: "odify", onPress: modify }] : []),
        ...(canCancel ? [{ id: "cancel-order", key: "c", label: "ancel", onPress: () => { void cancel(); } }] : []),
      ] : []),
      { id: "account", key: "a", label: "ccount", onPress: () => accountControl.current?.open() },
      ...(account ? [{ id: "view", key: "v", label: view === "open" ? "Activity" : "Open orders", onPress: () => setView(view === "open" ? "activity" : "open") }, { id: "refresh", key: "r", label: "efresh", onPress: refresh }, { id: "navigate", key: "↑↓", label: "j/k Rows" }] : []),
      ...(onBack ? [{ id: "back", key: "Esc", label: "Ticket", onPress: onBack }] : []),
    ],
  } : null, [active, resource.loading, trading.phase, status, view, selected, canModify, canCancel, modify, cancel, busy, account, onBack, refresh]);
  const now = resource.updatedAt ?? Date.now();
  const summaries = snapshot?.executionKind === "order-summaries";

  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    <Box flexDirection="row" alignItems="center" gap={1} paddingX={1} height={2}>
      <Box flexGrow={1} minWidth={0}>
        <BrokerAccountPicker accounts={accounts.map((item) => ({ value: item.accountId, label: item.name, profileLabel: instance.label || broker.name, tradingMode: item.tradingMode }))}
          value={accountId} onChange={onAccountChange} controlRef={accountControl} disabled={busy} width={Math.max(16, Math.min(42, width - (summaries ? 49 : 43)))} />
      </Box>
      {account && <Badge label={accountMode(account)} tone={account.tradingMode === "simulation" ? "accent" : "negative"} />}
      <SegmentedControl value={view} options={[{ value: "open", label: "Open orders" }, { value: "activity", label: summaries ? "Order summaries" : "Activity" }]} onChange={(next) => setView(next === "activity" ? "activity" : "open")} />
    </Box>
    <PaneStatusBody subject="orders" loading={canRead && resource.loading && !snapshot} error={!snapshot ? resource.error : null}
      empty={!account || !canRead} emptyTitle={!account ? "Choose an account to see its orders." : "Connect this broker in Brokers to read orders."}>
      {view === "open" ? <DataTableView<BrokerOrder> rootWidth={width} rootHeight={Math.max(2, height - 2)} focused={focused && !busy && !dialogOpen}
        columns={orderColumns} items={rows} sortColumnId={null} sortDirection="desc" getItemKey={brokerOrderKey} renderCell={(order, column) => {
          if (column.id !== "actions") return renderOrderCell(order, column, now);
          if (terminalStatuses.has(brokerOrderStatus(order.status))) return { text: "" };
          const allowed = broker.getTradingCapabilities?.(instance, order.contract);
          const disabled = !canRead || busy || !allowed?.enabled || !canChangeBrokerOrder(order);
          return { text: "Modify Cancel", content: <Box flexDirection="row" gap={1} justifyContent="flex-end" width={column.width}>
            <Button label="Modify" compact variant="secondary" disabled={disabled || !broker.modifyOrder || !allowed?.modify} onPress={() => modifyOrder(order)} stopPropagation />
            <Button label="Cancel" compact variant="secondary" disabled={disabled || !broker.cancelOrder || !allowed?.cancel} onPress={() => { void cancelOrder(order); }} stopPropagation />
          </Box> };
        }}
        selection={{ kind: "id", selectedId: selected ? brokerOrderKey(selected) : "", getId: brokerOrderKey, onChange: (key) => { selectedKeyRef.current = key; setSelectedKey(key); } }}
        onActivate={modifyOrder} selectedTextOverridesCellColor emptyStateTitle="No open orders in this account." />
        : <DataTableView<BrokerExecution> rootWidth={width} rootHeight={Math.max(2, height - 2)} focused={focused && !dialogOpen}
          columns={activityColumns.map((column) => column.id === "quantity" && summaries ? { ...column, label: "Cumulative qty" } : column)}
          items={snapshot?.executions ?? []} sortColumnId={null} sortDirection="desc" getItemKey={(execution) => execution.execId}
          renderCell={(execution, column) => renderExecutionCell(execution, column, now)} selection={{ kind: "none" }}
          emptyStateTitle="No recent activity in this account." />}
    </PaneStatusBody>
  </Box>;
}
