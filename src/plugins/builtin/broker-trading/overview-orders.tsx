import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionRow, SectionHeading } from "../../../components";
import { useAsyncResource } from "../../../react/async-resource";
import { usePaneVisible } from "../../../state/app/activity";
import { usePaneAppConfig } from "../../../state/app/context";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { useThemeColors } from "../../../theme/theme-context";
import type { BrokerAdapter } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { BrokerContractRef } from "../../../types/instrument";
import type { BrokerExecution, BrokerOrder } from "../../../types/trading";
import { Box, Text } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { usePluginBrokerActions } from "../../runtime";
import { ticketOrderMatches } from "./chart-levels";
import { brokerOrderKey, brokerOrderStatus, canChangeBrokerOrder } from "./orders-data";
import { resolveTicketContract, subscribeTradingStatus } from "./pane-model";

export interface TickerOrderSource {
  broker: BrokerAdapter;
  instance: BrokerInstanceConfig;
  contract: BrokerContractRef;
}

export interface TickerOrders {
  open: BrokerOrder[];
  recent: BrokerExecution[];
  /** Accounts the rows come from; with more than one, each row names its account. */
  accounts: number;
  failed: boolean;
}

const RECENT_LIMIT = 5;
const DONE = new Set(["Cancelled", "Filled", "Rejected", "Expired"]);

/**
 * This ticker's working orders and latest fills across connected trading
 * profiles, newest first. One profile failing leaves the others shown.
 */
async function loadTickerOrders(sources: readonly TickerOrderSource[]): Promise<TickerOrders> {
  let failed = false;
  const results = await Promise.all(sources.map(async ({ broker, instance, contract }) => {
    if (broker.getStatus?.(instance).state !== "connected") return { open: [], recent: [] };
    const [open, recent] = await Promise.allSettled([
      Promise.resolve().then(() => broker.listOpenOrders?.(instance) ?? []),
      Promise.resolve().then(() => broker.listExecutions?.(instance) ?? []),
    ]);
    if (open.status === "rejected" || recent.status === "rejected") failed = true;
    const mine = <T extends Pick<BrokerOrder, "accountId" | "brokerInstanceId" | "contract">>(row: T) => ticketOrderMatches(row, contract, instance.id, row.accountId);
    return {
      open: (open.status === "fulfilled" ? open.value : []).filter((order) => mine(order) && !DONE.has(brokerOrderStatus(order.status))),
      recent: (recent.status === "fulfilled" ? recent.value : []).filter(mine),
    };
  }));
  const open = results.flatMap((result) => result.open).sort((a, b) => b.updatedAt - a.updatedAt);
  const recent = results.flatMap((result) => result.recent).sort((a, b) => b.time - a.time).slice(0, RECENT_LIMIT);
  const accounts = new Set([...open, ...recent].map((row) => `${row.brokerInstanceId ?? row.contract.brokerInstanceId ?? ""}:${row.accountId ?? ""}`)).size;
  return { open, recent, accounts, failed };
}

function ago(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

const amount = (value: number) => formatNumber(value, Number.isInteger(value) ? 0 : 4);
const money = (value: number | undefined) => value != null && Number.isFinite(value) ? formatNumber(value, 2) : "--";
const ORDER_TYPE: Record<string, string> = { LMT: "Limit", MKT: "Market", STP: "Stop", STP_LMT: "Stop limit", "STP LMT": "Stop limit" };

function orderSummary(order: BrokerOrder): string {
  const status = brokerOrderStatus(order.status);
  const type = ORDER_TYPE[order.orderType] ?? order.orderType;
  const priced = order.orderType === "MKT" ? type : `${type} ${money(order.limitPrice ?? order.stopPrice)}`;
  const state = status === "Partially filled" ? `${amount(order.filled)} of ${amount(order.quantity)} filled` : status === "Working" ? "" : status;
  return [`${order.action === "BUY" ? "Buy" : "Sell"} ${amount(order.quantity)}`, priced, state].filter(Boolean).join(" · ");
}

function fillSummary(execution: BrokerExecution): string {
  const bought = ["BUY", "BOT", "B"].includes(execution.side.toUpperCase());
  return `${bought ? "Bought" : "Sold"} ${amount(execution.shares)} at ${money(execution.price)}`;
}

/**
 * Overview's orders for its ticker: what is working and what last filled,
 * without the ticket. An open order opens Trade to change it there.
 */
export function TickerOrdersSection({ width, onModify }: { width: number; onModify(order: BrokerOrder): void }) {
  const colors = useThemeColors();
  const identity = usePaneTickerIdentity();
  const config = usePaneAppConfig();
  const visible = usePaneVisible();
  const { getBrokerAdapter } = usePluginBrokerActions();
  const [statusVersion, setStatusVersion] = useState(0);
  const sources = useMemo(() => config.brokerInstances.flatMap((instance): TickerOrderSource[] => {
    if (instance.enabled === false) return [];
    const broker = getBrokerAdapter(instance.brokerType);
    if (!broker?.listOpenOrders || !broker.placeOrder) return [];
    const contract = resolveTicketContract(identity, broker, instance).contract;
    return contract ? [{ broker, instance, contract }] : [];
  }), [config.brokerInstances, getBrokerAdapter, identity]);
  useEffect(() => {
    const unsubscribe = sources.map(({ broker, instance }) => subscribeTradingStatus(broker, instance, () => setStatusVersion((value) => value + 1)));
    return () => { for (const dispose of unsubscribe) dispose(); };
  }, [sources]);
  const loader = useCallback(() => loadTickerOrders(sources), [sources, statusVersion]);
  const resource = useAsyncResource(visible && sources.length ? loader : null);
  const { reload } = resource;
  useEffect(() => {
    if (!visible || !sources.length) return;
    const timer = setInterval(() => { void reload(); }, 30_000);
    return () => clearInterval(timer);
  }, [visible, sources.length, reload]);
  const data = resource.data;
  if (!data || (!data.open.length && !data.recent.length && !data.failed)) return null;
  const now = resource.updatedAt ?? Date.now();
  const account = (row: { accountId?: string }) => data.accounts > 1 && row.accountId ? ` · ${row.accountId}` : "";
  return <Box flexDirection="column" width={width}>
    <SectionHeading title="Orders" />
    {data.open.map((order) => {
      const changeable = canChangeBrokerOrder(order);
      return <ActionRow key={brokerOrderKey(order)} label={`${orderSummary(order)}${account(order)}`} disabled={!changeable} width={width}
        fg={order.action === "BUY" ? colors.positive : colors.negative} onPress={() => { if (changeable) onModify(order); }} />;
    })}
    {data.recent.map((execution) => <Box key={execution.execId} flexDirection="row" gap={1} data-gloom-selectable="true">
      <Text fg={colors.text} selectable>{`${fillSummary(execution)}${account(execution)}`}</Text>
      <Text fg={colors.textDim}>{ago(execution.time, now)}</Text>
    </Box>)}
    {data.failed ? <Text fg={colors.warning}>Some orders could not be read. They refresh every 30 seconds.</Text> : null}
  </Box>;
}
