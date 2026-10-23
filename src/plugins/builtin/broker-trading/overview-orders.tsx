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
import { usePluginBrokerActions } from "../../runtime";
import { ticketOrderMatches } from "./chart-levels";
import { strategyShape } from "./strategy";
import { brokerOrderDone, brokerOrderKey, brokerOrderStatus, canChangeBrokerOrder, formatOrderPrice as money, formatOrderQuantity as amount, isBuySide } from "./orders-data";
import { useBrokerOrderFeeds } from "./order-feed";
import { ticketTypeName } from "./ticket-parts";
import { linkRoleName, trailingText } from "./linked-orders";
import { resolveTicketContract, subscribeTradingStatus } from "./pane-model";

export interface TickerOrderSource {
  broker: BrokerAdapter;
  instance: BrokerInstanceConfig;
  contract: BrokerContractRef;
}

export interface TickerActivity {
  recent: BrokerExecution[];
  failed: boolean;
}

const RECENT_LIMIT = 5;

/**
 * This ticker's latest fills across connected trading profiles, newest
 * first. One profile failing leaves the others shown. Working orders come
 * from the app's order feed.
 */
async function loadTickerActivity(sources: readonly TickerOrderSource[]): Promise<TickerActivity> {
  let failed = false;
  const results = await Promise.all(sources.map(async ({ broker, instance, contract }) => {
    if (broker.getStatus?.(instance).state !== "connected") return [];
    try {
      const recent = await Promise.resolve().then(() => broker.listExecutions?.(instance) ?? []);
      return recent.filter((row) => ticketOrderMatches(row, contract, instance.id, row.accountId));
    } catch { failed = true; return []; }
  }));
  return { recent: results.flat().sort((a, b) => b.time - a.time).slice(0, RECENT_LIMIT), failed };
}

function ago(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

function orderSummary(order: BrokerOrder): string {
  const status = brokerOrderStatus(order.status);
  const type = order.linkRole && order.linkRole !== "entry" ? linkRoleName[order.linkRole] : ticketTypeName[order.orderType] ?? order.orderType;
  const priced = order.orderType === "MKT" ? type : order.orderType === "TRAIL" ? trailingText(order, money) : `${type} ${money(order.limitPrice ?? order.stopPrice)}`;
  const state = status === "Partially filled" ? `${amount(order.filled)} of ${amount(order.quantity)} filled` : status === "Working" ? "" : status;
  return [`${order.action === "BUY" ? "Buy" : "Sell"} ${amount(order.quantity)}${order.legs?.length ? ` ${strategyShape(order.legs)}` : ""}`, priced, state].filter(Boolean).join(" · ");
}

function fillSummary(execution: BrokerExecution): string {
  return `${isBuySide(execution.side) ? "Bought" : "Sold"} ${amount(execution.shares)} at ${money(execution.price)}`;
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
  // Working orders from the app's order feed; fills are read again whenever the feed sees a new one.
  const feeds = useBrokerOrderFeeds(sources, visible);
  const open = useMemo(() => sources.flatMap(({ instance, contract }, index) => (feeds[index]?.orders ?? [])
    .filter((order) => !brokerOrderDone(order.status) && ticketOrderMatches(order, contract, instance.id, order.accountId)))
    .sort((a, b) => b.updatedAt - a.updatedAt), [sources, feeds]);
  const fills = feeds.reduce((sum, feed) => sum + feed.fills, 0);
  const loader = useCallback(() => loadTickerActivity(sources), [sources, statusVersion, fills]);
  const resource = useAsyncResource(visible && sources.length ? loader : null);
  const activity = resource.data;
  const failed = !!activity?.failed || feeds.some((feed) => feed.failed);
  const recent = activity?.recent ?? [];
  if (!open.length && !recent.length && !failed) return null;
  const now = resource.updatedAt ?? Date.now();
  const accounts = new Set([...open, ...recent].map((row) => `${row.brokerInstanceId ?? row.contract.brokerInstanceId ?? ""}:${row.accountId ?? ""}`)).size;
  const account = (row: { accountId?: string }) => accounts > 1 && row.accountId ? ` · ${row.accountId}` : "";
  return <Box flexDirection="column" width={width}>
    <SectionHeading title="Orders" />
    {open.map((order) => {
      const changeable = canChangeBrokerOrder(order);
      return <ActionRow key={brokerOrderKey(order)} label={`${orderSummary(order)}${account(order)}`} disabled={!changeable} width={width}
        fg={order.action === "BUY" ? colors.positive : colors.negative} onPress={() => { if (changeable) onModify(order); }} />;
    })}
    {recent.map((execution) => <Box key={execution.execId} flexDirection="row" gap={1} data-gloom-selectable="true">
      <Text fg={colors.text} selectable>{`${fillSummary(execution)}${account(execution)}`}</Text>
      <Text fg={colors.textDim}>{ago(execution.time, now)}</Text>
    </Box>)}
    {failed ? <Text fg={colors.warning}>Some orders could not be read. They are read again shortly.</Text> : null}
  </Box>;
}
