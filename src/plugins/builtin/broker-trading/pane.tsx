import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button, EmptyState, Notice, PaneFooterScope, SelectButton, usePaneFooter, usePaneMenuItems, type SelectControl } from "../../../components";
import { useShortcut } from "../../../react/input";
import { useDialogState } from "../../../ui/dialog";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { usePaneVisible } from "../../../state/app/activity";
import { useAppGetState, usePaneAppConfig, usePaneStateValue } from "../../../state/app/context";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import type { BrokerAdapter } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { BrokerContractRef } from "../../../types/instrument";
import type { PaneProps, TickerResearchTabProps } from "../../../types/plugin";
import type { BrokerAccount, BrokerOrder } from "../../../types/trading";
import { Box, useUiCapabilities } from "../../../ui";
import { usePluginAppActions, usePluginBrokerActions } from "../../runtime";
import { BrokerTradingController } from "./controller";
import { takeTradeIntent } from "./command";
import { BrokerAccountPicker } from "./account-picker";
import { BrokerOrdersView } from "./orders";
import { brokerOrderKey, brokerOrderStatus } from "./orders-data";
import { availableTicketPosition, buildTicketAccountChoices, chooseTicketAccount, editTicketDraft, newTicketDraft, quickTicketQuantity, resolveTicketContract, subscribeTradingStatus, ticketAccountChoiceKey, ticketPositionContext, type ProfileAccountChoice, type TicketPositionSnapshot } from "./pane-model";
import { BrokerTicketView, type TicketAction, type TicketField } from "./ticket";
import { ticketChartLevels, ticketOrderMatches } from "./chart-levels";
import { useResearchTrading } from "../shared/research-trading";
import { useThemeColors } from "../../../theme/theme-context";

const ORDER_DONE = new Set(["Cancelled", "Filled", "Rejected", "Expired"]);
/** Filled quantity last seen per order, shared by every mounted ticket so a fill toasts once. */
const seenFills = new Map<string, number>();
/** Records an order's fill and returns what was seen before, if anything. */
function noteOrderFill(order: BrokerOrder): number | undefined {
  const key = brokerOrderKey(order);
  const before = seenFills.get(key);
  if (Number.isFinite(order.filled) && (before === undefined || order.filled > before)) seenFills.set(key, order.filled);
  if (seenFills.size > 500) seenFills.delete(seenFills.keys().next().value!);
  return before;
}
function orderToastBody(order: BrokerOrder): string {
  const symbol = order.contract.localSymbol || order.contract.symbol;
  const qty = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  const filled = order.filled > 0 && Number.isFinite(order.avgFillPrice) ? ` · ${qty(order.filled)} filled at ${order.avgFillPrice!.toLocaleString("en-US", { maximumFractionDigits: 4 })}` : "";
  const limit = order.orderType === "MKT" ? "market" : `${order.orderType === "STP" ? "stop" : "limit"} ${(order.limitPrice ?? order.stopPrice)?.toLocaleString("en-US", { maximumFractionDigits: 4 }) ?? ""}`.trim();
  return `${order.action === "BUY" ? "Buy" : "Sell"} ${qty(order.quantity)} ${symbol} ${limit}${filled}`;
}

/** The ticket talks to the selected broker directly, never to the market router. */
function ProfileTicket({ broker, instance, contract, width, height, focused, ordersFirst = false, accountChoices, selectedAccountId, onChooseProfileAccount, allowAutoAccount = true, onCapture, docked = false, onClose }: {
  broker: BrokerAdapter; instance: BrokerInstanceConfig; contract: BrokerContractRef;
  width: number; height: number; focused: boolean; ordersFirst?: boolean;
  accountChoices?: ProfileAccountChoice[]; selectedAccountId?: string;
  onChooseProfileAccount?: (choice: ProfileAccountChoice) => void; allowAutoAccount?: boolean;
  onCapture?: (capturing: boolean) => void; docked?: boolean; onClose?: () => void;
}) {
  const trade = useResearchTrading();
  const publish = trade?.publish;
  const colors = useThemeColors();
  const native = useUiCapabilities().nativePaneChrome;
  const [ticketContentHeight, setTicketContentHeight] = useState<number>();
  const [openOrders, setOpenOrders] = useState<BrokerOrder[]>([]);
  const visible = usePaneVisible();
  const getState = useAppGetState();
  const { updateBrokerInstance, getBrokerAdapter } = usePluginBrokerActions();
  const { notify } = usePluginAppActions();
  const [accounts, setAccounts] = useState<BrokerAccount[]>([]);
  const [positions, setPositions] = useState<TicketPositionSnapshot>();
  const [accountId, setAccountId] = useState<string | undefined>(selectedAccountId);
  const [page, setPage] = useState<"ticket" | "enable" | "orders">(ordersFirst ? "orders" : "ticket");
  const [error, setError] = useState<string>();
  const [typed, setTyped] = useState("");
  const [statusVersion, setStatusVersion] = useState(0);
  const [defaultPriceLabel, setDefaultPriceLabel] = useState<string>();
  const [tradeIntent, setTradeIntent] = usePaneStateValue<string | null>("brokerTradeIntent", null);
  const [focusRevision, setFocusRevision] = useState(0);
  const [pendingModify, setPendingModify] = useState<BrokerOrder>();
  const refreshResources = useRef<() => void>(() => {});
  const current = useRef({ broker, instance, accounts, accountId, positions });
  current.current = { broker, instance, accounts, accountId, positions };
  const controller = useMemo(() => new BrokerTradingController({ getContext: (request) => {
    const values = current.current;
    const latest = getState().config.brokerInstances.find((profile) => profile.id === values.instance.id);
    const adapter = getBrokerAdapter(values.instance.brokerType) ?? values.broker;
    return { adapter, instance: latest ?? { ...values.instance, enabled: false }, accounts: values.accounts, accountId: values.accountId,
      availablePosition: availableTicketPosition(values.positions, latest ?? values.instance, values.accountId, request?.contract ?? contract),
      connection: adapter.getStatus?.(latest ?? values.instance) ?? { state: "disconnected", updatedAt: 0 } };
  } }), [instance.id, getState, getBrokerAdapter]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const draft = state.draft;
  const caps = broker.getTradingCapabilities?.(instance, draft?.contract ?? contract, draft?.orderType);
  const connection = broker.getStatus?.(instance);
  const connected = connection?.state === "connected";
  const reconnecting = connection?.state === "connecting";
  const ticketContract = draft?.contract ?? contract;
  const contractKey = JSON.stringify(ticketContract);
  const [ordersBusy, setOrdersBusy] = useState(false);
  const ticketBusy = state.phase === "previewing" || state.phase === "submitting" || state.phase === "cancelling";
  const busy = ticketBusy || ordersBusy;
  const reportError = (failure: unknown) => setError(failure instanceof Error ? failure.message : "This broker action could not be completed.");
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    controller.setDraft(newTicketDraft(broker, instance, contract, current.current.accountId));
  }, [controller, instance.id, contract]);
  useEffect(() => {
    if (!tradeIntent || ordersFirst) return;
    const intent = takeTradeIntent(tradeIntent);
    setTradeIntent(null);
    if (!intent) return;
    // An order picked elsewhere (Overview) loads once its account has.
    if (intent.modify) { setPendingModify(intent.modify); return; }
    try {
      if (controller.uncertain()) throw new Error("Refresh and reconcile the unknown order before starting another order.");
      const next = newTicketDraft(broker, instance, contract, current.current.accountId, intent.action);
      if (intent.quantity !== undefined) next.quantity = intent.quantity;
      if (intent.limitPrice !== undefined) {
        if (!broker.getTradingCapabilities?.(instance, contract).orderTypes.includes("LMT")) throw new Error("This broker does not support limit orders for this instrument.");
        Object.assign(next, editTicketDraft(broker, instance, next, "orderType", "LMT"), { limitPrice: intent.limitPrice });
      }
      controller.reset();
      controller.setDraft(next);
      setTyped(""); setError(undefined); setDefaultPriceLabel(undefined); setPage("ticket");
      setFocusRevision((revision) => revision + 1);
    } catch (failure) { reportError(failure); }
  }, [tradeIntent, setTradeIntent, controller, broker, instance, contract, ordersFirst]);
  useEffect(() => { const before = controller.getSnapshot(); controller.syncContext(); if (controller.getSnapshot() !== before) setTyped(""); }, [controller, instance, accounts, accountId, positions, statusVersion]);
  useEffect(() => subscribeTradingStatus(broker, instance, () => setStatusVersion((value) => value + 1)), [broker, instance]);
  const selectAccount = useCallback((id: string | undefined) => {
    if (id !== undefined && !current.current.accounts.some((account) => account.accountId === id)) throw new Error("Choose an available account.");
    const phase = controller.getSnapshot().phase;
    if (phase === "submitting" || phase === "cancelling") {
      if (current.current.accountId === id) return;
      throw new Error("Wait for the pending order action before changing accounts.");
    }
    if (controller.uncertain() && current.current.accountId !== id) throw new Error("Refresh and reconcile the unknown order before changing accounts.");
    // The controller reads this ref synchronously, before React commits the selection.
    const changedAccount = current.current.accountId !== id;
    const before = controller.getSnapshot();
    current.current.accountId = id;
    setAccountId(id);
    controller.syncContext();
    const latestDraft = controller.getSnapshot().draft;
    if (latestDraft && latestDraft.accountId !== id) controller.setDraft({ ...latestDraft, accountId: id });
    if (changedAccount || controller.getSnapshot() !== before) { setTyped(""); setDefaultPriceLabel(undefined); }
    setError(undefined);
  }, [controller]);
  useEffect(() => {
    if (selectedAccountId && current.current.accounts.some((account) => account.accountId === selectedAccountId) && current.current.accountId !== selectedAccountId) {
      try { selectAccount(selectedAccountId); } catch (failure) { reportError(failure); }
    }
  }, [selectedAccountId, accounts, selectAccount]);
  useEffect(() => {
    if (!visible || !connected) return;
    let active = true;
    let loading = false;
    const refresh = () => {
      if (loading) return;
      loading = true;
      void Promise.allSettled([broker.listAccounts?.(instance) ?? Promise.resolve([]), broker.importPositions(instance)]).then(([accountResult, positionResult]) => {
      if (!active) return;
      if (accountResult.status === "fulfilled") {
        const nextAccounts = accountResult.value;
        current.current.accounts = nextAccounts;
        setAccounts(nextAccounts);
        const previous = current.current.accountId;
        selectAccount(allowAutoAccount ? chooseTicketAccount(nextAccounts, previous) : nextAccounts.some((account) => account.accountId === previous) ? previous : undefined);
      } else setError("Broker accounts are unavailable. Reconnect in Brokers to try again.");
      const nextPositions = positionResult.status === "fulfilled" ? { profile: instance, positions: positionResult.value, fetchedAt: Date.now() } : undefined;
      current.current.positions = nextPositions;
      setPositions(nextPositions);
      if (positionResult.status === "rejected") setError("Current positions are unavailable. Check the account in your broker before ordering.");
    }).catch((failure) => { if (active) reportError(failure); }).finally(() => { loading = false; });
    };
    refreshResources.current = refresh;
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => { active = false; clearInterval(timer); if (refreshResources.current === refresh) refreshResources.current = () => {}; };
  }, [broker, instance, connected, visible, selectAccount, allowAutoAccount, statusVersion]);
  const quote = useCallback(async (prefill = false) => {
    try {
      await controller.loadQuote();
      const latest = controller.getSnapshot();
      const currentDraft = latest.draft;
      if (prefill && currentDraft && latest.phase === "editing" && !latest.modifying) {
        const q = latest.quote?.quote;
        const source = currentDraft.action === "BUY" && q?.ask !== undefined ? "ask" : currentDraft.action === "SELL" && q?.bid !== undefined ? "bid" : "last";
        if ((currentDraft.orderType === "LMT" || currentDraft.orderType === "STP LMT") && currentDraft.limitPrice === undefined) {
          controller.applyPriceDefault(source);
          setDefaultPriceLabel(`Broker ${source}. Editable.`);
        }
        if ((currentDraft.orderType === "STP" || currentDraft.orderType === "STP LMT") && currentDraft.stopPrice === undefined) controller.applyPriceDefault(source, "stopPrice");
      }
    } catch { /* The controller owns safe error state. */ }
  }, [controller]);
  usePaneRefreshKey(() => { refreshResources.current(); if (accountId && ticketContract.symbol) void quote(); }, { focused, enabled: page === "ticket" && !busy });
  useEffect(() => {
    if (!visible || !connected || page !== "ticket" || !accountId || !ticketContract.symbol || state.phase !== "editing") return;
    void quote(true);
    const timer = setInterval(() => { void quote(); }, 15_000);
    return () => clearInterval(timer);
  }, [connected, visible, page, accountId, contractKey, draft?.orderType, state.phase, quote, instance.id, statusVersion, focusRevision]);
  useEffect(() => {
    if (!visible || !connected || state.phase !== "result" || !state.result || ["FILLED", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED", "SUPERSEDED"].includes(state.result.status.toUpperCase())) return;
    const timer = setInterval(() => { void controller.refreshResult().catch(() => {}); }, 10_000);
    return () => clearInterval(timer);
  }, [visible, connected, state.phase, state.result?.orderId, state.result?.status, controller]);
  // A placed order and each new fill say so in a toast, also when the
  // ticket has moved on. One toast per order and fill across tickets.
  const lastPhase = useRef(state.phase);
  useEffect(() => {
    const placed = lastPhase.current === "submitting" && state.phase === "result" && state.result;
    lastPhase.current = state.phase;
    if (!placed || !state.result) return;
    const order = state.result;
    noteOrderFill(order);
    const status = brokerOrderStatus(order.status);
    if (status === "UNKNOWN") return;
    notify({ type: status === "Rejected" ? "error" : "success", desktop: "when-inactive",
      title: status === "Rejected" ? "Order rejected" : status === "Filled" ? "Order filled" : state.modifying ? "Order replaced" : "Order placed",
      body: orderToastBody(order) });
  }, [state.phase, state.result, state.modifying, notify]);
  useEffect(() => {
    for (const order of [...openOrders, ...(state.result ? [state.result] : [])]) {
      const before = noteOrderFill(order);
      if (before === undefined || !(order.filled > before)) continue;
      notify({ type: "success", desktop: "when-inactive", title: order.filled >= order.quantity ? "Order filled" : "Partial fill", body: orderToastBody(order) });
    }
  }, [openOrders, state.result, notify]);
  const onEdit = (field: TicketField, value: string | boolean) => {
    if (ordersBusy) return;
    if (field === "typedConfirmation") { setTyped(String(value)); return; }
    if (field === "confirmOrders") {
      try { controller.setConfirmOrders(value === true); setError(undefined); } catch (failure) { reportError(failure); }
      return;
    }
    const latestDraft = controller.getSnapshot().draft;
    if (!latestDraft) return;
    try {
      const next = editTicketDraft(broker, instance, latestDraft, field, value);
      // Controlled inputs can echo a programmatic value before React commits the next render.
      if (Object.entries(next).every(([key, nextValue]) => Object.is(nextValue, latestDraft[key as keyof typeof latestDraft]))) return;
      controller.setDraft(next);
      setTyped(""); setError(undefined);
      if (field === "limitPrice" || field === "orderType") setDefaultPriceLabel(undefined);
    } catch (failure) { reportError(failure); }
  };
  const onAction = (action: TicketAction) => {
    void (async () => {
      try {
        setError(undefined);
        if (busy) return;
        if (action === "enable") {
          if (page !== "enable") { setPage("enable"); return; }
          const values = broker.getTradingConfigUpdate?.(instance, true);
          if (!values) throw new Error("This broker does not support enabling trading here. Open Brokers.");
          await updateBrokerInstance(instance.id, values);
          setPage("ticket");
        } else if (action === "back") {
          setPage("ticket"); setTyped(""); if (draft) controller.setDraft({ ...draft });
        } else if (action === "submit") await controller.submitFromEntry();
        else if (action === "review") await controller.review();
        else if (action === "confirm") await controller.confirm(typed);
        else if (action === "cancel") await controller.confirmCancel(true);
        else if (action === "refresh") await controller.refreshResult();
        else if (action === "all" || action === "quantity25" || action === "quantity50") {
          const latestDraft = controller.getSnapshot().draft;
          const held = latestDraft ? availableTicketPosition(current.current.positions, current.current.instance, current.current.accountId, latestDraft.contract) : undefined;
          if (!latestDraft) throw new Error("Enter an order first.");
          const capabilities = broker.getTradingCapabilities?.(instance, latestDraft.contract, latestDraft.orderType);
          if (!capabilities) throw new Error("This broker does not declare quantity constraints.");
          const account = current.current.accounts.find((value) => value.accountId === current.current.accountId);
          const quantity = quickTicketQuantity(latestDraft, capabilities, controller.getSnapshot().quote?.quote, account, held, action === "quantity25" ? 0.25 : action === "quantity50" ? 0.5 : 1);
          controller.setDraft({ ...latestDraft, quantity });
          setTyped("");
        }
        else if (action === "priceBid" || action === "priceMid" || action === "priceAsk" || action === "priceLast") {
          const latestDraft = controller.getSnapshot().draft;
          if (!latestDraft || latestDraft.orderType === "MKT") throw new Error("Choose a limit or stop order before setting a price.");
          const source = ({ priceBid: "bid", priceMid: "mid", priceAsk: "ask", priceLast: "last" } as const)[action];
          controller.applyPriceDefault(source, latestDraft.orderType === "STP" ? "stopPrice" : "limitPrice");
          setDefaultPriceLabel(`Broker ${source}. Editable.`); setTyped("");
        }
        else if (action === "orders") setPage("orders");
        else if (action === "new") {
          controller.reset();
          controller.setDraft(newTicketDraft(broker, instance, ticketContract, accountId));
          setTyped(""); setDefaultPriceLabel(undefined); setPage("ticket");
        }
      } catch (failure) { reportError(failure); }
    })();
  };
  const onAccountChange = (id: string) => { if (busy) return; try { selectAccount(id); } catch (failure) { reportError(failure); } };
  const onTicketAccountChange = (value: string) => {
    if (!accountChoices) { onAccountChange(value); return; }
    const choice = accountChoices.find((item) => item.value === value);
    if (!choice || busy) return;
    if (choice.profileId === instance.id) onAccountChange(choice.accountId);
    onChooseProfileAccount?.(choice);
  };
  const onModify = (order: BrokerOrder, edit?: { price: number; review: boolean }) => {
    try {
      if (!order.accountId) throw new Error("This order has no account. Refresh it in your broker.");
      selectAccount(order.accountId);
      controller.beginModify(order);
      if (edit) {
        const next = controller.getSnapshot().draft!;
        controller.setDraft({ ...next, ...(next.orderType === "STP" ? { stopPrice: edit.price } : { limitPrice: edit.price }) });
        if (edit.review) void controller.review().catch(reportError);
      }
      setTyped(""); setError(undefined); setPage("ticket");
      setFocusRevision((revision) => revision + 1);
    } catch (failure) { reportError(failure); }
  };
  useEffect(() => {
    if (!pendingModify) return;
    if (pendingModify.brokerInstanceId && pendingModify.brokerInstanceId !== instance.id) {
      setPendingModify(undefined); reportError(new Error("Choose this order's broker profile in the ticket to change it.")); return;
    }
    if (!accounts.some((account) => account.accountId === pendingModify.accountId)) return;
    setPendingModify(undefined);
    onModify(pendingModify);
  });
  const position = ticketPositionContext(positions, instance, accountId, ticketContract);
  const mode = accounts.find((account) => account.accountId === accountId)?.tradingMode;
  useEffect(() => {
    const orders = openOrders.filter((order) => ticketOrderMatches(order, ticketContract, instance.id, accountId));
    const latestOrder = state.result && ticketOrderMatches(state.result, ticketContract, instance.id, accountId) ? state.result : undefined;
    publish?.({ mode, busy, contract: ticketContract, levels: ticketChartLevels({ draft, editing: state.phase === "editing" && trade?.visible !== false, orders, latestOrder, avgCost: position?.avgCost, position: position?.quantity, colors, priceStep: caps?.priceStep, priceDecimals: caps?.priceDecimals }) });
  }, [publish, mode, busy, draft, trade?.visible, state.phase, state.result, openOrders, ticketContract, instance.id, accountId, position?.avgCost, position?.quantity, colors, caps?.priceStep, caps?.priceDecimals]);
  useEffect(() => () => publish?.({ levels: [] }), [publish]);
  // Docked, the open orders show only while this ticker has some, or when asked
  // for: o focuses them, Shift+O or Hide/Show orders toggles them.
  const tickerOrderCount = openOrders.filter((order) => ticketOrderMatches(order, ticketContract, instance.id, accountId) && !ORDER_DONE.has(brokerOrderStatus(order.status))).length;
  const [ordersPinned, setOrdersPinned] = useState<boolean>();
  // A review needs the room: unless asked for, the orders step aside until it is placed or edited.
  const reviewing = state.phase === "review" || state.phase === "submitting" || state.phase === "cancel-review";
  const ordersShown = !!docked && (page === "orders" || (ordersPinned ?? (tickerOrderCount > 0 && !reviewing)));
  const [drawerRows, setDrawerRows] = useState(1);
  const toggleOrders = useCallback(() => {
    if (ordersShown) { setOrdersPinned(false); if (page === "orders") setPage("ticket"); } else setOrdersPinned(true);
  }, [ordersShown, page]);
  const dialogOpen = useDialogState((dialog) => dialog.isOpen);
  useShortcut((event) => {
    if (event.ctrl || event.meta || event.alt || event.super || event.targetEditable || event.defaultPrevented) return;
    if (event.name !== "O" && !(event.shift && event.name === "o")) return;
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat) toggleOrders();
  }, { enabled: focused && !!docked && !busy && !dialogOpen, phase: "before", scope: "broker-ticket:orders-toggle" });
  usePaneMenuItems("broker-ticket:orders-toggle", () => focused && docked ? [{ id: "ticket-orders-toggle", label: ordersShown ? "Hide open orders" : "Show open orders", accelerator: "Shift+O", enabled: !busy, onSelect: toggleOrders }] : null, [focused, docked, ordersShown, busy, toggleOrders]);
  // The drawer is as tall as its rows, up to a third of the panel: one order is three lines, not a quarter of the screen.
  const rowHeight = native ? 1.6 : 1;
  const ordersHeight = ordersShown ? Math.min(Math.max(4, Math.floor(height / 3)), (native ? 2.6 : 2) + Math.max(1, drawerRows) * rowHeight) : 0;
  // On the desktop the ticket comes first: the drawer gives up its spare rows, down to its heading and one
  // row, before the ticket's last control is cut off. The terminal measures the ticket and sizes both.
  const drawerFloor = native ? Math.min(ordersHeight, 1.2 + rowHeight) : ordersHeight;
  const receipt = state.phase === "result" ? state.receipt : undefined;
  const ticketHeight = Math.min(height - drawerFloor - (ordersShown && !native ? 1 : 0), docked && !native ? ticketContentHeight ?? Infinity : Infinity);
  return <Box flexDirection="column" width={width} height={height}>
    <Box visible={docked || page !== "orders"} height={docked && native ? undefined : ticketHeight} maxHeight={ticketHeight} flexShrink={0}>
    <PaneFooterScope active={page !== "orders"}>
    <BrokerTicketView onContentHeight={setTicketContentHeight} blocked={ordersBusy} width={width} height={ticketHeight} focused={focused && page !== "orders"} onCapture={onCapture} docked={docked} onClose={onClose} model={{
    brokerName: broker.name, symbol: ticketContract.localSymbol ?? ticketContract.symbol, accounts, accountId,
    accountChoices, accountChoiceValue: accountChoices && accountId ? ticketAccountChoiceKey(instance.id, accountId) : undefined,
    accountType: accounts.find((account) => account.accountId === accountId)?.accountType,
    quote: state.quote?.quote, quoteData: connection?.quoteData,
    phase: page === "enable" ? "enable" : state.phase, draft: receipt?.request ?? draft, preview: state.review?.preview ?? receipt?.preview, warnings: state.review?.warnings ?? [], result: state.result, resultQuantities: state.resultQuantities,
    error: connection?.state === "error" && connection.message ? connection.message : error ?? state.error, reconnecting,
    position: position?.quantity, avgCost: position?.avgCost, positionPnl: position?.pnl, tradingEnabled: caps?.enabled === true,
    typedConfirmation: typed, connected, capabilities: caps, modifying: state.modifying, defaultPriceLabel, confirmOrders: state.confirmOrders,
    initialFocus: state.modifying ? draft?.orderType === "STP" ? "stopPrice" : "limitPrice" : focusRevision ? "review" : undefined, focusRevision,
  }} onEdit={onEdit} onAction={onAction} onAccountChange={onTicketAccountChange} />
    </PaneFooterScope>
    </Box>
    <Box visible={ordersShown || !docked && page === "orders"} onMouseDown={() => setPage("orders")} marginTop={ordersShown && !native ? 1 : 0}
      flexShrink={docked && native ? 1 : 0} minHeight={docked && native ? drawerFloor : undefined} height={docked ? ordersHeight : height}><PaneFooterScope active={page === "orders"}>
      <BrokerOrdersView onHide={docked ? toggleOrders : undefined} onContentRows={setDrawerRows} latestOrder={state.result} blocked={ticketBusy} onBusy={setOrdersBusy} compact={docked} contract={docked ? ticketContract : undefined} onOrders={setOpenOrders} broker={broker} instance={instance} accounts={accounts} accountId={accountId}
        onAccountChange={onAccountChange} onModify={onModify} onBack={ticketContract.symbol ? () => setPage("ticket") : undefined} width={width} height={docked ? ordersHeight : height} focused={focused && page === "orders"} active={trade?.visible !== false && (docked || page === "orders")} />
    </PaneFooterScope></Box>
  </Box>;
}

export function BrokerTradeTab({ width, height, focused, onCapture, docked, onClose }: TickerResearchTabProps & { docked?: boolean; onClose?: () => void }) {
  const identity = usePaneTickerIdentity();
  const config = usePaneAppConfig();
  const visible = usePaneVisible();
  const { getBrokerAdapter } = usePluginBrokerActions();
  const { showPane } = usePluginAppActions();
  const [selectedBroker, setSelectedBroker] = useState<string>();
  const brokerControl = useRef<SelectControl>(null);
  const [selectedAccount, setSelectedAccount] = useState<ProfileAccountChoice>();
  const [accountChoices, setAccountChoices] = useState<ProfileAccountChoice[]>([]);
  const lastAccounts = useRef(new Map<string, BrokerAccount[]>());
  const [statusVersion, setStatusVersion] = useState(0);
  const profiles = useMemo(() => config.brokerInstances.filter((profile) => profile.enabled !== false && !!getBrokerAdapter(profile.brokerType)?.placeOrder), [config.brokerInstances, getBrokerAdapter]);
  const brokerTypes = useMemo(() => [...new Set(profiles.map((profile) => profile.brokerType))], [profiles]);
  usePaneFooter("broker-ticket-profile", () => focused && brokerTypes.length > 1 ? {
    hints: [{ id: "ticket-broker", key: "d", label: "Broker", onPress: () => brokerControl.current?.open() }],
  } : null, [focused, brokerTypes.length]);
  const brokerType = brokerTypes.includes(selectedBroker ?? "") ? selectedBroker : brokerTypes.length === 1 ? brokerTypes[0] : undefined;
  const groupProfiles = useMemo(() => profiles.filter((profile) => profile.brokerType === brokerType), [profiles, brokerType]);
  const instance = groupProfiles.find((value) => value.id === selectedAccount?.profileId) ?? groupProfiles.find((value) => value.id === identity.contract?.brokerInstanceId) ?? groupProfiles[0];
  const broker = instance ? getBrokerAdapter(instance.brokerType) : null;
  useEffect(() => {
    const dispose = groupProfiles.map((profile) => {
      const adapter = getBrokerAdapter(profile.brokerType);
      return adapter ? subscribeTradingStatus(adapter, profile, () => setStatusVersion((value) => value + 1)) : undefined;
    });
    return () => { for (const unsubscribe of dispose) unsubscribe?.(); };
  }, [groupProfiles, getBrokerAdapter]);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    let pending = false;
    const refresh = () => {
      if (pending) return;
      pending = true;
      void Promise.allSettled(groupProfiles.map(async (profile) => {
        const adapter = getBrokerAdapter(profile.brokerType);
        const state = adapter?.getStatus?.(profile).state;
        // A profile reconnecting keeps its accounts, so the ticket does not ask to choose one again.
        const accounts = state === "connected" ? await adapter!.listAccounts?.(profile) ?? [] : state === "connecting" ? lastAccounts.current.get(profile.id) ?? [] : [];
        lastAccounts.current.set(profile.id, accounts);
        return { profile, accounts };
      })).then((results) => {
        if (active) setAccountChoices(buildTicketAccountChoices(results.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])));
      }).finally(() => { pending = false; });
    };
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [groupProfiles, getBrokerAdapter, visible, statusVersion]);
  const resolution = useMemo(() => broker && instance ? resolveTicketContract(identity, broker, instance) : {}, [identity, instance?.id, broker]);
  const contract = resolution.contract;
  if (!identity.symbol || identity.error) return <EmptyState title={identity.error ?? "Choose a ticker to trade."} />;
  if (!profiles.length) return <EmptyState title="Connect a broker to trade" message="Add a trading-capable broker profile in Brokers." actions={<Button label="Open Brokers" onPress={() => showPane("brokers")} />} />;
  return <Box flexDirection="column" flexGrow={1} minHeight={0}>
    {brokerTypes.length > 1 ? <Box paddingX={1}><SelectButton label="Broker" controlRef={brokerControl} emphasized={focused && !brokerType} value={brokerType ?? ""} options={[{ value: "", label: "Choose a broker", disabled: true }, ...brokerTypes.map((value) => ({ value, label: getBrokerAdapter(value)?.name ?? value }))]} onChange={(value) => { setSelectedBroker(value); setSelectedAccount(undefined); }} /></Box> : null}
    {broker && instance && contract ? <ProfileTicket key={`${instance.id}:${JSON.stringify(contract)}`} broker={broker} instance={instance} contract={contract} width={width} height={height - (brokerTypes.length > 1 ? 1 : 0)} focused={focused} onCapture={onCapture} docked={docked} onClose={onClose} accountChoices={accountChoices} selectedAccountId={selectedAccount?.profileId === instance.id ? selectedAccount.accountId : undefined} onChooseProfileAccount={setSelectedAccount} allowAutoAccount={groupProfiles.length === 1} /> : <Box flexDirection="column">{accountChoices.length ? <BrokerAccountPicker accounts={accountChoices} value={selectedAccount?.value} onChange={(value) => setSelectedAccount(accountChoices.find((choice) => choice.value === value))} /> : null}<Notice tone={resolution.error ? "warning" : "muted"}>{resolution.error ?? "Choose the broker for this order."}</Notice></Box>}
  </Box>;
}

export function BrokerOrdersPane({ width, height, focused }: PaneProps) {
  const config = usePaneAppConfig();
  const { getBrokerAdapter } = usePluginBrokerActions();
  const [selected, setSelected] = useState<string>();
  const profileControl = useRef<SelectControl>(null);
  const profiles = config.brokerInstances.filter((instance) => instance.enabled !== false && !!getBrokerAdapter(instance.brokerType)?.listOpenOrders);
  usePaneFooter("broker-orders-profile", () => focused && profiles.length ? {
    hints: [{ id: "orders-profile", key: "d", label: "Broker profile", onPress: () => profileControl.current?.open() }],
  } : null, [focused, profiles.length]);
  const instance = profiles.find((value) => value.id === selected) ?? (profiles.length === 1 ? profiles[0] : undefined);
  const broker = instance ? getBrokerAdapter(instance.brokerType) : null;
  const contract = useMemo(() => ({ brokerId: broker?.id ?? "", brokerInstanceId: instance?.id, symbol: "", currency: "USD", secType: "STK" }), [broker?.id, instance?.id]);
  return <Box flexGrow={1} flexDirection="column"><Box paddingX={1}><SelectButton label="Broker profile" controlRef={profileControl} emphasized={focused && !instance} value={instance?.id ?? ""} options={[{ value: "", label: "Choose a profile", disabled: true }, ...profiles.map((value) => ({ value: value.id, label: value.label }))]} onChange={setSelected} /></Box>{broker && instance ? <ProfileTicket key={instance.id} broker={broker} instance={instance} contract={contract} width={width} height={height - 1} focused={focused} ordersFirst /> : <EmptyState title="Choose a broker profile" />}</Box>;
}
