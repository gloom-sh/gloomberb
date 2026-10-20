import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import {
  Badge, Button, DataTableView, IconButton, PaneStatusBody, RatioBar, SegmentedControl, Notice, SectionHeading, confirmDialog, usePaneFooter, usePaneNoticeFooter,
  type DataTableCell, type DataTableColumn, type SelectControl,
} from "../../../components";
import { loadingErrorFooterInfo, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { usePaneVisible } from "../../../state/app/activity";
import { colors } from "../../../theme/colors";
import type { BrokerAdapter } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { BrokerAccount, BrokerExecution, BrokerOrder, BrokerOrderType } from "../../../types/trading";
import { Box, ScrollBox, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import { useDialog, useDialogState } from "../../../ui/dialog";
import { BrokerTradingController, type BrokerOrderOutcome, type BrokerTradingContext } from "./controller";
import { usePluginAppActions } from "../../runtime";
import { BrokerAccountPicker } from "./account-picker";
import { brokerOrderDone, brokerOrderKey, brokerOrderStatus, canChangeBrokerOrder, ticketEditingPriceStep, withLatestOrder, formatOrderPrice as price, formatOrderQuantity as quantity, isBuySide, loadBrokerOrdersSnapshot, type BrokerOrdersSnapshot } from "./orders-data";
import { accountModeLabel } from "./account-picker";
import type { BrokerContractRef } from "../../../types/instrument";
import { ticketOrderMatches } from "./chart-levels";
import { brokerOrderFeed, orderToastBody, useBrokerOrderFeed, useFeedOrderResult } from "./order-feed";
import { orderInstrumentLabel, strategyShape } from "./strategy";
import { stepNumber } from "../../../components/ui/number-step";
import { ticketTypeName } from "./ticket-parts";
import { wrapTextLines } from "../../../utils/text-wrap";

export interface BrokerOrdersViewProps {
  broker: BrokerAdapter;
  instance: BrokerInstanceConfig;
  accounts: BrokerAccount[];
  accountId?: string;
  onAccountChange: (accountId: string) => void;
  onModify: (order: BrokerOrder, edit?: { price: number; review: boolean }) => void;
  compact?: boolean;
  /** Docked: collapse the orders section beside the ticket. */
  onHide?: () => void;
  blocked?: boolean;
  onBusy?(busy: boolean): void;
  /** A cancel question is open in the drawer, whose buttons must stay in view. */
  onConfirming?(confirming: boolean): void;
  contract?: BrokerContractRef;
  onOrders?: (orders: BrokerOrder[]) => void;
  /** Compact: the rows it has to show, so the drawer can be as tall as its content. */
  onContentRows?: (rows: number) => void;
  latestOrder?: BrokerOrder;
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
/** An order's type, prices and time in force, as a cancellation names them: "Limit 336.50 · DAY". */
function orderTerms(order: BrokerOrder): string {
  const prices = order.orderType === "MKT" ? "" : order.orderType === "STP LMT" ? ` ${price(order.stopPrice)}, limit ${price(order.limitPrice)}` : ` ${price(order.limitPrice ?? order.stopPrice)}`;
  return `${ticketTypeName[order.orderType] ?? order.orderType}${prices} · ${order.tif ?? "DAY"}`;
}

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
    case "symbol": return { text: orderInstrumentLabel(order), attributes: TextAttributes.BOLD };
    case "status": {
      const tone = status === "Rejected" ? "negative" : status === "Filled" ? "positive" : ["UNKNOWN", "Pending cancel", "Partially filled"].includes(status) ? "warning" : "accent";
      return { text: status, content: <Badge label={status === "Partially filled" ? "Partial fill" : status} variant={status === "Working" ? "solid" : "subtle"} tone={tone} /> };
    }
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

const CANCEL_NOTE = "The order can still fill before cancellation is confirmed.";
/**
 * "Cancel Buy 1 SPY?" over "Limit 759.50 · DAY": which order, when two of the same size wait at different prices.
 * The terms keep a line of their own, so a narrow drawer never breaks a price across lines.
 */
function cancelLines(order: BrokerOrder | undefined): string[] {
  return order ? [`Cancel ${order.action === "BUY" ? "Buy" : "Sell"} ${quantity(order.quantity)} ${orderInstrumentLabel(order)}?`, orderTerms(order)] : ["Cancel this order?"];
}

/** Until the broker takes a change, the order can be cancelled but not changed again. */
/** Cancel, not change: the broker has not taken the last change, or not yet acknowledged the order. */
const unsettled = (order: BrokerOrder) => ["Replacing", "Submitted"].includes(brokerOrderStatus(order.status));

/** A drawer row's state in a word: working is what an open order is, so it says nothing. */
function compactOrderState(order: BrokerOrder): string {
  const status = brokerOrderStatus(order.status);
  if (status === "Partially filled") return `${quantity(order.filled)}/${quantity(order.quantity)}`;
  return ({ Working: "", Submitted: "Sent", "Pending cancel": "Cancelling", UNKNOWN: "Unknown" } as Record<string, string>)[status] ?? status;
}

function renderExecutionCell(execution: BrokerExecution, column: DataTableColumn, now: number): DataTableCell {
  switch (column.id) {
    case "symbol": return { text: execution.contract.localSymbol || execution.contract.symbol };
    case "side": return { text: execution.side, content: <Badge label={execution.side} tone={isBuySide(execution.side) ? "positive" : "negative"} /> };
    case "quantity": return { text: quantity(execution.shares), value: execution.shares };
    case "price": return { text: price(execution.price), value: execution.price };
    case "fees": return { text: execution.commission === undefined ? "--" : `${price(execution.commission)} ${execution.commissionCurrency ?? ""}`.trim() };
    default: return { text: age(execution.time, now), color: colors.textDim };
  }
}

export function BrokerOrdersView({
  broker, instance, accounts, accountId, onAccountChange, onModify, onBack, onHide, width, height, focused,
  active = true, initialSnapshot, compact = false, contract, onOrders, onContentRows, blocked = false, onBusy, onConfirming, latestOrder,
}: BrokerOrdersViewProps) {
  const [view, setView] = useState<"open" | "activity">("open");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedKeyRef = useRef<string | null>(null);
  const [priceEdit, setPriceEdit] = useState<{ key: string; value: string }>();
  const priceEditRef = useRef(priceEdit); priceEditRef.current = priceEdit;
  const [keepOrder, setKeepOrder] = useState(false);
  const [inlineCancel, setInlineCancel] = useState(false);
  const [, connectionChanged] = useReducer((value: number) => value + 1, 0);
  const native = useUiCapabilities().nativePaneChrome;
  const dialog = useDialog();
  const dialogOpen = useDialogState((state) => state.isOpen);
  const accountControl = useRef<SelectControl>(null);
  const keyboardScope = `broker-orders:${useId()}`;
  const visible = usePaneVisible();
  const account = accounts.find((item) => item.accountId === accountId);
  const connection = broker.getStatus?.(instance) ?? { state: "disconnected" as const, updatedAt: 0 };
  const context = useRef<BrokerTradingContext>({ adapter: broker, instance, accounts, accountId, connection });
  context.current = { adapter: broker, instance, accounts, accountId, connection };
  const { notify } = usePluginAppActions();
  // What a refused cancel came to, said once: the order feed records it quietly and reads the list again.
  const onOutcome = useRef<(outcome: BrokerOrderOutcome) => void>(() => {});
  onOutcome.current = (outcome) => {
    brokerOrderFeed.note(instance.id, outcome.order);
    brokerOrderFeed.refresh(instance.id);
    notify({ type: outcome.type, title: outcome.title, body: orderToastBody(outcome.order) });
  };
  const controller = useMemo(() => new BrokerTradingController({ getContext: () => context.current, onOutcome: (outcome) => onOutcome.current(outcome) }), [broker, instance.id]);
  const failed = useCallback((error: unknown, fallback: string) => notify({ type: "error", body: error instanceof Error && error.message ? error.message : fallback }), [notify]);
  const trading = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => { controller.syncContext(); }, [controller, instance, accountId, accounts, connection.state]);
  useEffect(() => broker.subscribeStatus?.(instance, connectionChanged), [broker, instance]);

  const canRead = active && !!account && connection.state === "connected";
  // Open orders come from the app's order feed, which the broker's pushes or polling keep current; activity is read here.
  const feed = useBrokerOrderFeed(broker, instance, canRead);
  const loader = useCallback(() => loadBrokerOrdersSnapshot(broker, instance, accountId!, undefined, { orders: [], failed: false }), [broker, instance, accountId]);
  const resource = useAsyncResource(canRead ? loader : null, { initialData: () => initialSnapshot && initialSnapshot.accountId === accountId && initialSnapshot.brokerInstanceId === instance.id ? initialSnapshot : null });
  const reload = resource.reload;
  // A new fill is new activity.
  const fillsSeen = useRef(feed.fills);
  useEffect(() => {
    if (feed.fills === fillsSeen.current) return;
    fillsSeen.current = feed.fills;
    if (canRead) void reload();
  }, [feed.fills, canRead, reload]);
  // A cancel this view sent follows the order feed, and is asked for every 15 seconds without pushed changes or while
  // its outcome is unknown, which only the broker's answer settles. The fills and the end toast from the feed.
  useFeedOrderResult(feed, instance.id, trading.result, controller.applyOrderUpdate);
  const unknown = trading.result?.status.toUpperCase() === "UNKNOWN";
  useEffect(() => {
    if (!canRead || !visible || (feed.live && !unknown) || !trading.result || brokerOrderDone(trading.result.status)) return;
    const timer = setInterval(() => { void controller.refreshResult().catch(() => {}); }, 15_000);
    return () => clearInterval(timer);
  }, [canRead, visible, feed.live, unknown, trading.result, controller]);
  const refresh = useCallback(() => {
    void controller.refreshResult().catch(() => {});
    brokerOrderFeed.refresh(instance.id);
    void reload();
  }, [controller, reload, instance.id]);
  usePaneRefreshKey(refresh, { focused, enabled: active && !!account });

  const snapshot = useMemo((): BrokerOrdersSnapshot | null => {
    const data = resource.data;
    if (!data) return null;
    // Orders that ended moments ago stay in: they say what became of an order shown as working.
    const orders = feed.orders.filter((order) => order.accountId === accountId
      && (!order.brokerInstanceId || order.brokerInstanceId === instance.id) && (!order.contract.brokerInstanceId || order.contract.brokerInstanceId === instance.id));
    return { ...data, orders, errors: [...(feed.failed ? ["Open orders are unavailable. Refresh to try again."] : []), ...data.errors] };
  }, [resource.data, feed.orders, feed.failed, accountId, instance.id]);
  const reconciledRows = useMemo(() => {
    let source = snapshot && snapshot.accountId === accountId && snapshot.brokerInstanceId === instance.id
      ? snapshot.orders.filter((order) => !contract || ticketOrderMatches(order, contract, instance.id, accountId)) : [];
    if (latestOrder && latestOrder.accountId === accountId && (!contract || ticketOrderMatches(latestOrder, contract, instance.id, accountId))) source = withLatestOrder(source, latestOrder);
    const result = trading.result;
    if (!result || result.accountId !== accountId || contract && !ticketOrderMatches(result, contract, instance.id, accountId)) return source;
    const status = brokerOrderStatus(result.status);
    const pending = ["UNKNOWN", "Pending cancel"].includes(status);
    if (!pending && !brokerOrderDone(status)) return source;
    const key = brokerOrderKey(result);
    return source.some((order) => brokerOrderKey(order) === key)
      ? source.map((order) => brokerOrderKey(order) === key ? result : order) : pending ? [result, ...source] : source;
  }, [snapshot, trading.result, accountId, instance.id, contract, latestOrder]);
  // Keep terminal acknowledgements in the projection even after hiding their rows.
  // The full list shows an order that ended only when it is the one this view just acted on.
  const rows = useMemo(() => reconciledRows.filter((order) => !brokerOrderDone(order.status)
    || (!compact && !!trading.result && brokerOrderKey(order) === brokerOrderKey(trading.result))), [compact, reconciledRows, trading.result]);
  useEffect(() => { onOrders?.(reconciledRows); }, [reconciledRows, onOrders]);
  // Only an order the trader chose is selected: c, m and Enter never fall back to another row.
  const selected = rows.find((order) => brokerOrderKey(order) === selectedKey);
  // A selected order that leaves the list (filled, cancelled, gone on a refresh) clears the selection.
  useEffect(() => {
    if (selectedKeyRef.current === null || rows.some((order) => brokerOrderKey(order) === selectedKeyRef.current)) return;
    selectedKeyRef.current = null; setSelectedKey(null); setPriceEdit(undefined);
  }, [rows]);
  const capabilities = broker.getTradingCapabilities?.(instance, selected?.contract);
  const ownBusy = trading.phase === "cancelling" || trading.phase === "cancel-review";
  useEffect(() => { onBusy?.(ownBusy); }, [ownBusy, onBusy]);
  useEffect(() => { onConfirming?.(trading.phase === "cancel-review"); }, [trading.phase, onConfirming]);
  const busy = ownBusy || blocked;
  const changeable = !!selected && canRead && capabilities?.enabled === true && canChangeBrokerOrder(selected) && !busy;
  const canModify = changeable && !unsettled(selected) && !!broker.modifyOrder && capabilities?.modify === true;
  const canCancel = changeable && !!broker.cancelOrder && capabilities?.cancel === true;
  const modifyOrder = useCallback((order: BrokerOrder) => {
    const capability = broker.getTradingCapabilities?.(instance, order.contract);
    if (canRead && !busy && broker.modifyOrder && capability?.enabled && capability.modify && canChangeBrokerOrder(order)) onModify(order);
  }, [broker, instance, canRead, busy, onModify]);
  const modify = useCallback(() => { const order = rows.find((row) => brokerOrderKey(row) === selectedKeyRef.current); if (order) modifyOrder(order); }, [rows, modifyOrder]);
  const cancelOrder = useCallback(async (order: BrokerOrder) => {
    const capability = broker.getTradingCapabilities?.(instance, order.contract);
    if (!account || !canRead || busy || !broker.cancelOrder || !capability?.enabled || !capability.cancel || !canChangeBrokerOrder(order)) return;
    try {
      controller.requestCancel(order);
      if (compact) { setInlineCancel(true); setKeepOrder(false); return; }
      const confirmed = await confirmDialog(dialog, {
        title: `Cancel ${orderInstrumentLabel(order)} order?`,
        body: [`${order.action} ${quantity(order.quantity)} ${orderInstrumentLabel(order)}, ${orderTerms(order)}. ${quantity(order.remaining)} remaining.`, `${broker.name} ${accountModeLabel(account?.tradingMode)} · ${account.name}`],
        confirmLabel: "Cancel order", cancelLabel: "Keep order", confirmVariant: "danger",
      });
      await controller.confirmCancel(confirmed);
      if (confirmed) {
        if (controller.getSnapshot().result?.status === "PENDING_CANCEL") await controller.refreshResult().catch(() => {});
        brokerOrderFeed.refresh(instance.id);
      }
    } catch (error) {
      failed(error, "Cancellation could not be confirmed.");
    }
  }, [account, canRead, busy, broker, instance, controller, dialog, compact, failed]);
  const cancel = useCallback(() => { const order = rows.find((row) => brokerOrderKey(row) === selectedKeyRef.current); return order ? cancelOrder(order) : Promise.resolve(); }, [rows, cancelOrder]);
  const confirmInline = async (confirmed: boolean) => {
    if (controller.getSnapshot().phase !== "cancel-review") return;
    try { await controller.confirmCancel(confirmed); setInlineCancel(false); if (confirmed) brokerOrderFeed.refresh(instance.id); }
    catch (failure) { failed(failure, "Cancellation could not be confirmed."); }
  };
  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped || event.targetEditable || event.ctrl || event.meta || event.alt || event.super) return;
    if (inlineCancel && trading.phase === "cancel-review") {
      if (event.name === "tab") { event.preventDefault(); event.stopPropagation(); setKeepOrder((value) => !value); }
      else if (event.name === "escape" || event.name === "return" || event.name === "enter") {
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) void confirmInline(event.name !== "escape" && !keepOrder);
      }
      return;
    }
    if (event.shift || busy) return;
    // With nothing chosen, j starts at the first order and k at the last (the arrows too, in the table).
    const starts = event.name === "j" || event.name === "k" || !compact && (event.name === "down" || event.name === "up");
    if (view === "open" && rows.length && starts && !rows.some((row) => brokerOrderKey(row) === selectedKeyRef.current)) {
      event.preventDefault(); event.stopPropagation();
      selectedKeyRef.current = brokerOrderKey(rows[event.name === "j" || event.name === "down" ? 0 : rows.length - 1]!);
      setSelectedKey(selectedKeyRef.current); setPriceEdit(undefined);
      return;
    }
    if (compact && view === "open" && rows.length && ["j", "k", "up", "down", "return", "enter"].includes(event.name ?? "")) {
      event.preventDefault(); event.stopPropagation();
      const index = rows.findIndex((row) => brokerOrderKey(row) === selectedKeyRef.current);
      const order = rows[index];
      if (event.name === "j" || event.name === "k") {
        const next = rows[(index + (event.name === "j" ? 1 : rows.length - 1)) % rows.length]!;
        selectedKeyRef.current = brokerOrderKey(next); setSelectedKey(selectedKeyRef.current); setPriceEdit(undefined);
      } else if (!order) {
        // The arrows and Enter act on a chosen order only.
      } else if ((event.name === "up" || event.name === "down") && canModify && order.orderType !== "MKT") {
        const key = brokerOrderKey(order);
        const current = priceEditRef.current?.key === key ? priceEditRef.current.value : String(order.limitPrice ?? order.stopPrice ?? "");
        const caps = broker.getTradingCapabilities?.(instance, order.contract, order.orderType as BrokerOrderType);
        const step = caps?.priceStep ?? ticketEditingPriceStep(Number(current) || undefined, caps?.priceDecimals);
        const value = stepNumber(current, event.name === "up" ? 1 : -1, step, step);
        if (value !== undefined) { priceEditRef.current = { key, value }; setPriceEdit(priceEditRef.current); }
      } else if ((event.name === "enter" || event.name === "return") && !event.repeat && canModify) {
        const edit = priceEditRef.current;
        if (edit?.key === brokerOrderKey(order)) { onModify(order, { price: Number(edit.value), review: true }); setPriceEdit(undefined); }
        else modifyOrder(order);
      }
      return;
    }
    const invoke = event.name === "a" && !compact ? () => accountControl.current?.open()
      : event.name === "v" && account ? () => setView(view === "open" ? "activity" : "open")
        : event.name === "m" && view === "open" && canModify ? modify
          : event.name === "c" && view === "open" && canCancel ? () => { void cancel(); }
            : event.name === "r" && account ? refresh
              : event.name === "escape" && onBack ? onBack : undefined;
    if (!invoke) return;
    event.preventDefault(); event.stopPropagation();
    // A held key acts once, so a repeat never opens a second cancel or change.
    if (!event.repeat) invoke();
  }, { enabled: focused && active && !dialogOpen, phase: "before", scope: keyboardScope });

  const status = connection.state !== "connected" ? "Broker disconnected" : trading.error ?? resource.error
    ?? (capabilities?.enabled === false ? capabilities.disabledReason ?? "Trading is off" : null);
  usePaneNoticeFooter({ registrationId: "broker-orders-notices", focused, enabled: active, notices: [...(snapshot?.errors ?? []), ...(snapshot?.notes ?? [])] });
  usePaneFooter("broker-orders", () => active ? {
    info: loadingErrorFooterInfo(resource.loading || trading.phase === "cancelling", status),
    hints: busy ? inlineCancel && trading.phase === "cancel-review" ? [
      { id: "cancel-confirm", key: "Enter", label: keepOrder ? "Keep order" : "Cancel order" },
      { id: "cancel-back", key: "Esc", label: "Back" },
    ] : [] : [
      ...(view === "open" && selected ? [
        ...(canModify ? [{ id: "modify-order", key: "m", label: "odify", onPress: modify }] : []),
        ...(canCancel ? [{ id: "cancel-order", key: "c", label: "ancel", onPress: () => { void cancel(); } }] : []),
      ] : []),
      ...(compact ? [] : [{ id: "account", key: "a", label: "ccount", onPress: () => accountControl.current?.open() }]),
      ...(account ? [
        { id: "view", key: "v", label: view === "open" ? "Activity" : "Open orders", onPress: () => setView(view === "open" ? "activity" : "open") },
        { id: "refresh", key: "r", label: "efresh", onPress: refresh },
        ...(view === "open" ? [{ id: "navigate", key: compact ? "j/k" : "↑↓", label: compact ? "Rows · ↑↓ Price · Enter Review" : "j/k Rows" }] : []),
      ] : []),
      ...(onBack ? [{ id: "back", key: "Esc", label: "Ticket", onPress: onBack }] : []),
    ],
  } : null, [active, resource.loading, trading.phase, status, view, selected, canModify, canCancel, modify, cancel, busy, account, onBack, refresh, compact, keepOrder, inlineCancel]);
  const now = resource.updatedAt ?? Date.now();
  const summaries = snapshot?.executionKind === "order-summaries";
  const executions = (snapshot?.executions ?? []).filter((execution) => !compact || !contract || ticketOrderMatches(execution, contract, instance.id, accountId));
  // Confirming a cancel takes a question, its wrapped note and the two buttons (the note's width is allowed some slack).
  const contentRows = trading.phase === "cancel-review" ? 1 + [...cancelLines(trading.cancelOrder), CANCEL_NOTE]
    .reduce((rows, text) => rows + Math.max(1, wrapTextLines(text, Math.max(12, width - 6)).length), 0)
    : (view === "open" ? rows.length : executions.length) + (snapshot?.errors?.length ?? 0);
  useEffect(() => { if (compact) onContentRows?.(contentRows); }, [compact, contentRows, onContentRows]);


  // Docked on the desktop, the drawer fills what the ticket above leaves it.
  if (compact || inlineCancel && trading.phase === "cancel-review") return <Box width={width} height={compact && native ? "100%" : height} flexDirection="column" overflow="hidden"
    border={native ? undefined : ["top"]} borderColor={colors.border} style={native ? { borderTop: `1px solid ${colors.border}` } : undefined}>
    <Box flexDirection="row" paddingX={1} alignItems="center" justifyContent="space-between" flexShrink={0}>
      <SectionHeading title={view === "open" ? `Open orders (${rows.length})` : summaries ? "Order summaries" : "Activity"} />
      <Box flexDirection="row" alignItems="center" gap={native ? 0.5 : 0}>
        <Button label={view === "open" ? "Show activity" : "Show open orders"} displayLabel={view === "open" ? "Activity" : "Open"} variant="plain" compact disabled={busy} onPress={() => setView(view === "open" ? "activity" : "open")} />
        {onHide ? <IconButton icon="close" label="Hide open orders" shortcut="o" onPress={onHide} /> : null}
      </Box>
    </Box>
    {trading.phase === "cancel-review" ? <Box flexDirection="column" paddingX={1} gap={native ? 0.5 : 0}>
      {cancelLines(trading.cancelOrder).map((line, index) => <Text key={index} fg={index ? colors.text : colors.textBright} wrapText>{line}</Text>)}
      <Text fg={colors.textDim} wrapText>{CANCEL_NOTE}</Text>
      <Box flexDirection="row" gap={1}>
        <Button label="Cancel order" variant="primary" tone="negative" active={!keepOrder} onPress={() => { void confirmInline(true); }} />
        <Button label="Keep order" variant="quiet" active={keepOrder} onPress={() => { void confirmInline(false); }} />
      </Box>
    </Box> : <ScrollBox flexGrow={1} scrollY>
      {(snapshot?.errors ?? []).map((error) => <Notice key={error} tone="negative">{error}</Notice>)}
      {view === "open" ? rows.map((order) => {
        const key = brokerOrderKey(order), picked = selected === order;
        const allowed = broker.getTradingCapabilities?.(instance, order.contract);
        const disabled = !canRead || busy || !allowed?.enabled || !canChangeBrokerOrder(order);
        const state = brokerOrderStatus(order.status);
        // One line: side and size, price, state, then edit and cancel as icons.
        return <Box key={key} position="relative" flexDirection="row" alignItems="center" gap={1} paddingLeft={1} height={native ? 1.6 : 1} backgroundColor={picked ? colors.panel : undefined}>
          {picked ? <Box position="absolute" left={0} top={0} width={1} height="100%" backgroundColor={focused ? colors.borderFocused : colors.border} style={native ? { width: 2 } : undefined} /> : null}
          <Box flexGrow={1} minWidth={0}>
            <Button label={`${order.action} ${quantity(order.quantity)} ${orderInstrumentLabel(order)}, ${state}`} width={native ? undefined : Math.max(10, width - 9)}
              active={focused && picked} variant="quiet" flush onPress={() => { selectedKeyRef.current = key; setSelectedKey(key); setPriceEdit(undefined); }}>
              <Box flexDirection="row" gap={1} alignItems="center" width="100%">
                <Text fg={order.action === "BUY" ? colors.positive : colors.negative} attributes={TextAttributes.BOLD} flexShrink={0}>{`${order.action === "BUY" ? "Buy" : "Sell"} ${quantity(order.quantity)}`}</Text>
                {/* The drawer is the ticker's: a spread names its shape, the stock needs no name. */}
                {order.legs?.length ? <Text fg={colors.text} truncate wrapMode="none" flexShrink={1} minWidth={0}>{strategyShape(order.legs)}</Text> : null}
                <Text fg={colors.text} selectable flexShrink={0}>{priceEdit?.key === key ? `→ ${priceEdit.value}` : order.orderType === "MKT" ? "Mkt" : price(order.limitPrice ?? order.stopPrice)}</Text>
                <Text fg={colors.warning} truncate wrapMode="none" flexShrink={1} minWidth={0}>{compactOrderState(order)}</Text>
              </Box>
            </Button>
          </Box>
          <Box flexDirection="row" flexShrink={0}>
            <IconButton icon="edit" label="Modify order" shortcut="Enter" disabled={disabled || unsettled(order) || !broker.modifyOrder || !allowed?.modify} onPress={() => modifyOrder(order)} />
            <IconButton icon="close" label="Cancel order" shortcut="c" color={colors.negative} disabled={disabled || !broker.cancelOrder || !allowed?.cancel} onPress={() => { void cancelOrder(order); }} />
          </Box>
        </Box>;
      }) : executions.map((execution) => <Box key={execution.execId} paddingX={1} height={native ? 1.6 : 1} flexDirection="row" alignItems="center">
        <Text selectable>{`${execution.side} ${quantity(execution.shares)} @ ${price(execution.price)}`}</Text>
      </Box>)}
      {!resource.loading && (view === "open" ? feed.loaded && !rows.length : !executions.length) ? <Box paddingX={1}><Text fg={colors.textDim}>{view === "open" ? "No open orders for this ticker." : "No recent activity."}</Text></Box> : null}
    </ScrollBox>}
  </Box>;
  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    <Box flexDirection="row" alignItems="center" gap={1} paddingX={1} height={2}>
      <Box flexGrow={1} minWidth={0}>
        <BrokerAccountPicker accounts={accounts.map((item) => ({ value: item.accountId, label: item.name, profileLabel: instance.label || broker.name, tradingMode: item.tradingMode }))}
          value={accountId} onChange={onAccountChange} controlRef={accountControl} disabled={busy} width={Math.max(16, Math.min(42, width - (summaries ? 49 : 43)))} />
      </Box>
      {account && <Badge label={accountModeLabel(account?.tradingMode)} tone={account.tradingMode === "simulation" ? "accent" : "negative"} />}
      <SegmentedControl value={view} options={[{ value: "open", label: "Open orders" }, { value: "activity", label: summaries ? "Order summaries" : "Activity" }]} onChange={(next) => setView(next === "activity" ? "activity" : "open")} />
    </Box>
    <PaneStatusBody subject="orders" loading={canRead && resource.loading && !snapshot} error={!snapshot ? resource.error : null}
      empty={!account || !canRead} emptyTitle={!account ? "Choose an account to see its orders." : "Connect this broker in Brokers to read orders."}>
      {view === "open" ? <DataTableView<BrokerOrder> rootWidth={width} rootHeight={Math.max(2, height - 2)} focused={focused && !busy && !dialogOpen}
        columns={orderColumns} items={rows} sortColumnId={null} sortDirection="desc" getItemKey={brokerOrderKey} renderCell={(order, column) => {
          if (column.id !== "actions") return renderOrderCell(order, column, now);
          if (brokerOrderDone(order.status)) return { text: "" };
          const allowed = broker.getTradingCapabilities?.(instance, order.contract);
          const disabled = !canRead || busy || !allowed?.enabled || !canChangeBrokerOrder(order);
          return { text: "Modify Cancel", content: <Box flexDirection="row" gap={1} justifyContent="flex-end" width={column.width}>
            <Button label="Modify" compact variant="secondary" disabled={disabled || unsettled(order) || !broker.modifyOrder || !allowed?.modify} onPress={() => modifyOrder(order)} stopPropagation />
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
