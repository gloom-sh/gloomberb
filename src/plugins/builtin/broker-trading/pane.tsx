import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button, EmptyState, Notice, SelectButton, usePaneFooter } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { usePaneVisible } from "../../../state/app/activity";
import { useAppGetState, usePaneAppConfig } from "../../../state/app/context";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import type { BrokerAdapter } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { BrokerContractRef } from "../../../types/instrument";
import type { PaneProps, TickerResearchTabProps } from "../../../types/plugin";
import type { BrokerAccount, BrokerOrder } from "../../../types/trading";
import { Box } from "../../../ui";
import { usePluginAppActions, usePluginBrokerActions } from "../../runtime";
import { BrokerTradingController } from "./controller";
import { BrokerAccountPicker } from "./account-picker";
import { BrokerOrdersView } from "./orders";
import { availableTicketPosition, buildTicketAccountChoices, chooseTicketAccount, editTicketDraft, newTicketDraft, quickTicketQuantity, resolveTicketContract, subscribeTradingStatus, ticketAccountChoiceKey, ticketPositionContext, type ProfileAccountChoice, type TicketPositionSnapshot } from "./pane-model";
import { BrokerTicketView, type TicketAction, type TicketField } from "./ticket";

const tradeIntents = new Map<string, "BUY" | "SELL">();
export function setTradeIntent(symbol: string, action: "BUY" | "SELL") { tradeIntents.set(symbol, action); }
function takeTradeIntent(symbol: string) { const value = tradeIntents.get(symbol); tradeIntents.delete(symbol); return value ?? "BUY"; }

/** The ticket talks to the selected broker directly, never to the market router. */
function ProfileTicket({ broker, instance, contract, width, height, focused, ordersFirst = false, accountChoices, selectedAccountId, onChooseProfileAccount, allowAutoAccount = true }: {
  broker: BrokerAdapter; instance: BrokerInstanceConfig; contract: BrokerContractRef;
  width: number; height: number; focused: boolean; ordersFirst?: boolean;
  accountChoices?: ProfileAccountChoice[]; selectedAccountId?: string;
  onChooseProfileAccount?: (choice: ProfileAccountChoice) => void; allowAutoAccount?: boolean;
}) {
  const visible = usePaneVisible();
  const getState = useAppGetState();
  const { updateBrokerInstance, getBrokerAdapter } = usePluginBrokerActions();
  const { showPane } = usePluginAppActions();
  const [accounts, setAccounts] = useState<BrokerAccount[]>([]);
  const [positions, setPositions] = useState<TicketPositionSnapshot>();
  const [accountId, setAccountId] = useState<string | undefined>(selectedAccountId);
  const [page, setPage] = useState<"ticket" | "enable" | "orders">(ordersFirst ? "orders" : "ticket");
  const [error, setError] = useState<string>();
  const [typed, setTyped] = useState("");
  const [statusVersion, setStatusVersion] = useState(0);
  const [defaultPriceLabel, setDefaultPriceLabel] = useState<string>();
  const footerId = `broker-ticket:${useId()}`;
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
  const connected = broker.getStatus?.(instance)?.state === "connected";
  const ticketContract = draft?.contract ?? contract;
  const contractKey = JSON.stringify(ticketContract);
  const busy = state.phase === "submitting" || state.phase === "cancelling";
  const reportError = (failure: unknown) => setError(failure instanceof Error ? failure.message : "This broker action could not be completed.");
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {
    controller.setDraft(newTicketDraft(broker, instance, contract, current.current.accountId, takeTradeIntent(contract.symbol)));
  }, [controller, instance.id, contract]);
  useEffect(() => { const before = controller.getSnapshot(); controller.syncContext(); if (controller.getSnapshot() !== before) setTyped(""); }, [controller, instance, accounts, accountId, positions, statusVersion]);
  useEffect(() => subscribeTradingStatus(broker, instance, () => setStatusVersion((value) => value + 1)), [broker, instance]);
  const selectAccount = useCallback((id: string | undefined) => {
    if (id !== undefined && !current.current.accounts.some((account) => account.accountId === id)) throw new Error("Choose an available account.");
    const phase = controller.getSnapshot().phase;
    if (phase === "submitting" || phase === "cancelling") {
      if (current.current.accountId === id) return;
      throw new Error("Wait for the pending order action before changing accounts.");
    }
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
  }, [connected, visible, page, accountId, contractKey, draft?.orderType, state.phase, quote, instance.id, statusVersion]);
  useEffect(() => {
    if (!visible || !connected || state.phase !== "result" || !state.result || ["FILLED", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED", "SUPERSEDED"].includes(state.result.status.toUpperCase())) return;
    const timer = setInterval(() => { void controller.refreshResult().catch(() => {}); }, 10_000);
    return () => clearInterval(timer);
  }, [visible, connected, state.phase, state.result?.orderId, state.result?.status, controller]);
  const onEdit = (field: TicketField, value: string | boolean) => {
    if (field === "typedConfirmation") { setTyped(String(value)); return; }
    if (!draft) return;
    try {
      controller.setDraft(editTicketDraft(broker, instance, draft, field, value));
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
        } else if (action === "review") await controller.review();
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
  usePaneFooter(footerId, () => ({
    info: state.phase === "previewing" || state.phase === "submitting" ? [{ id: "progress", parts: [{ text: state.phase === "previewing" ? "Requesting broker preview..." : "Submitting..." }] }] : undefined,
    hints: page === "orders" ? ticketContract.symbol ? [{ id: "ticket", key: "t", label: "icket", onPress: () => setPage("ticket") }] : [] : state.phase === "editing" ? [{ id: "orders", key: "v", label: "iew orders", title: "View orders", onPress: () => setPage("orders") }, { id: "brokers", key: "b", label: "rokers", onPress: () => showPane("brokers") }] : [],
  }), [state.phase, page, ticketContract.symbol, showPane]);
  const onAccountChange = (id: string) => { try { selectAccount(id); } catch (failure) { reportError(failure); } };
  const onTicketAccountChange = (value: string) => {
    if (!accountChoices) { onAccountChange(value); return; }
    const choice = accountChoices.find((item) => item.value === value);
    if (!choice || busy) return;
    if (choice.profileId === instance.id) onAccountChange(choice.accountId);
    onChooseProfileAccount?.(choice);
  };
  const onModify = (order: BrokerOrder) => {
    try {
      if (!order.accountId) throw new Error("This order has no account. Refresh it in your broker.");
      selectAccount(order.accountId);
      controller.beginModify(order);
      setPage("ticket");
    } catch (failure) { reportError(failure); }
  };
  if (page === "orders") return <Box flexDirection="column" flexGrow={1} minHeight={0}>{error ? <Notice tone="negative">{error}</Notice> : null}<BrokerOrdersView broker={broker} instance={instance} accounts={accounts} accountId={accountId} onAccountChange={onAccountChange} onModify={onModify} width={width} height={height} focused={focused} /></Box>;
  const position = ticketPositionContext(positions, instance, accountId, ticketContract);
  return <BrokerTicketView width={width} height={height} focused={focused} model={{
    brokerName: broker.name, symbol: ticketContract.localSymbol ?? ticketContract.symbol, accounts, accountId,
    accountChoices, accountChoiceValue: accountChoices && accountId ? ticketAccountChoiceKey(instance.id, accountId) : undefined,
    accountType: accounts.find((account) => account.accountId === accountId)?.accountType,
    quote: state.quote?.quote, quoteData: broker.getStatus?.(instance)?.quoteData,
    phase: page === "enable" ? "enable" : state.phase, draft, preview: state.review?.preview, warnings: state.review?.warnings ?? [], result: state.result,
    error: error ?? state.error, position: position?.quantity, avgCost: position?.avgCost, positionPnl: position?.pnl, tradingEnabled: caps?.enabled === true,
    typedConfirmation: typed, connected, capabilities: caps, modifying: state.modifying, defaultPriceLabel,
  }} onEdit={onEdit} onAction={onAction} onAccountChange={onTicketAccountChange} />;
}

export function BrokerTradeTab({ width, height, focused, onCapture }: TickerResearchTabProps) {
  const identity = usePaneTickerIdentity();
  const config = usePaneAppConfig();
  const visible = usePaneVisible();
  const { getBrokerAdapter } = usePluginBrokerActions();
  const { showPane } = usePluginAppActions();
  const [selectedBroker, setSelectedBroker] = useState<string>();
  const [selectedAccount, setSelectedAccount] = useState<ProfileAccountChoice>();
  const [accountChoices, setAccountChoices] = useState<ProfileAccountChoice[]>([]);
  const [statusVersion, setStatusVersion] = useState(0);
  const profiles = useMemo(() => config.brokerInstances.filter((profile) => profile.enabled !== false && !!getBrokerAdapter(profile.brokerType)?.placeOrder), [config.brokerInstances, getBrokerAdapter]);
  const brokerTypes = useMemo(() => [...new Set(profiles.map((profile) => profile.brokerType))], [profiles]);
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
        const accounts = adapter?.getStatus?.(profile).state === "connected" ? await adapter.listAccounts?.(profile) ?? [] : [];
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
  useEffect(() => { onCapture(focused); return () => onCapture(false); }, [focused, onCapture]);
  if (!identity.symbol || identity.error) return <EmptyState title={identity.error ?? "Choose a ticker to trade."} />;
  if (!profiles.length) return <EmptyState title="Connect a broker to trade" message="Add a trading-capable broker profile in Brokers." actions={<Button label="Open Brokers" onPress={() => showPane("brokers")} />} />;
  return <Box flexDirection="column" flexGrow={1} minHeight={0}>
    {brokerTypes.length > 1 ? <Box paddingX={1}><SelectButton label="Broker" value={brokerType ?? ""} options={[{ value: "", label: "Choose a broker", disabled: true }, ...brokerTypes.map((value) => ({ value, label: getBrokerAdapter(value)?.name ?? value }))]} onChange={(value) => { setSelectedBroker(value); setSelectedAccount(undefined); }} /></Box> : null}
    {broker && instance && contract ? <ProfileTicket key={`${instance.id}:${JSON.stringify(contract)}`} broker={broker} instance={instance} contract={contract} width={width} height={height - (brokerTypes.length > 1 ? 1 : 0)} focused={focused} accountChoices={accountChoices} selectedAccountId={selectedAccount?.profileId === instance.id ? selectedAccount.accountId : undefined} onChooseProfileAccount={setSelectedAccount} allowAutoAccount={groupProfiles.length === 1} /> : <Box flexDirection="column">{accountChoices.length ? <BrokerAccountPicker accounts={accountChoices} value={selectedAccount?.value} onChange={(value) => setSelectedAccount(accountChoices.find((choice) => choice.value === value))} /> : null}<Notice tone={resolution.error ? "warning" : "muted"}>{resolution.error ?? "Choose the broker for this order."}</Notice></Box>}
  </Box>;
}

export function BrokerOrdersPane({ width, height, focused }: PaneProps) {
  const config = usePaneAppConfig();
  const { getBrokerAdapter } = usePluginBrokerActions();
  const [selected, setSelected] = useState<string>();
  const profiles = config.brokerInstances.filter((instance) => instance.enabled !== false && !!getBrokerAdapter(instance.brokerType)?.listOpenOrders);
  const instance = profiles.find((value) => value.id === selected) ?? (profiles.length === 1 ? profiles[0] : undefined);
  const broker = instance ? getBrokerAdapter(instance.brokerType) : null;
  const contract = useMemo(() => ({ brokerId: broker?.id ?? "", brokerInstanceId: instance?.id, symbol: "", currency: "USD", secType: "STK" }), [broker?.id, instance?.id]);
  return <Box flexGrow={1} flexDirection="column"><Box paddingX={1}><SelectButton label="Broker profile" value={instance?.id ?? ""} options={[{ value: "", label: "Choose a profile", disabled: true }, ...profiles.map((value) => ({ value: value.id, label: value.label }))]} onChange={setSelected} /></Box>{broker && instance ? <ProfileTicket key={instance.id} broker={broker} instance={instance} contract={contract} width={width} height={height - 1} focused={focused} ordersFirst /> : <EmptyState title="Choose a broker profile" />}</Box>;
}
