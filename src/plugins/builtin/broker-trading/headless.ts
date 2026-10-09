import type { BrokerAdapter } from "../../../types/broker";
import type { HeadlessPaneContext, HeadlessPaneDefinition, HeadlessPaneColumn } from "../../../types/headless";
import { brokerOrderStatus, loadBrokerOrdersSnapshot } from "./orders-data";

type BrokerResolver = (brokerType: string, context: HeadlessPaneContext) => BrokerAdapter | null;

const orderColumns: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Symbol" }, { key: "side", header: "Side" }, { key: "status", header: "Status" },
  { key: "quantity", header: "Quantity", align: "right" }, { key: "filled", header: "Filled", align: "right" },
  { key: "orderType", header: "Type" }, { key: "limitPrice", header: "Limit", align: "right" },
  { key: "stopPrice", header: "Stop", align: "right" }, { key: "updatedAt", header: "Updated" },
];
const activityColumns: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Symbol" }, { key: "side", header: "Side" },
  { key: "quantity", header: "Quantity", align: "right" }, { key: "price", header: "Price", align: "right" },
  { key: "commission", header: "Fees", align: "right" }, { key: "time", header: "Time" },
];
const isoTime = (value: number) => Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;

function ordinal(value: unknown, count: number, label: string): number {
  if (value === undefined && count === 1) return 0;
  if (value === undefined) throw new Error(`Choose ${label === "account" ? "an" : "a"} ${label} with --${label} (1 to ${count}).`);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > count) throw new Error(`The ${label} must be between 1 and ${count}.`);
  return value - 1;
}

function createBrokerOrdersHeadless(
  resolveBroker: BrokerResolver = (type, context) => context.resolveBroker?.(type) ?? null,
): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle", argument: { kind: "none" },
    description: "Read open orders and recent activity for one connected broker account.",
    discovery: { id: "broker-orders", aliases: ["orders", "executions"], screenshotReadiness: "live-dom" },
    options: [
      { key: "profile", type: "integer", minimum: 1, description: "Broker profile number, required when more than one is available." },
      { key: "account", type: "integer", minimum: 1, description: "Account number, required when the profile has more than one account." },
      { key: "view", type: "enum", values: [{ value: "all" }, { value: "open" }, { value: "activity" }], defaultValue: "all", description: "Orders, activity, or both." },
    ],
    async load(args, context) {
      context.signal.throwIfAborted();
      const profiles = context.config.brokerInstances.filter((profile) => profile.enabled !== false)
        .map((instance) => ({ instance, broker: resolveBroker(instance.brokerType, context) }))
        .filter((row): row is { instance: typeof row.instance; broker: BrokerAdapter } => !!row.broker && !!(row.broker.listOpenOrders || row.broker.listExecutions));
      if (!profiles.length) throw new Error("Connect a broker profile that reports orders in Brokers first.");
      const { instance, broker } = profiles[ordinal(args.options.profile, profiles.length, "profile")]!;
      if (!broker.listAccounts) throw new Error("This broker does not report account identities.");
      const accounts = await broker.listAccounts(instance);
      context.signal.throwIfAborted();
      if (!accounts.length) throw new Error("This broker profile has no available accounts.");
      const account = accounts[ordinal(args.options.account, accounts.length, "account")]!;
      const data = await loadBrokerOrdersSnapshot(broker, instance, account.accountId, context.signal);
      const view = args.options.view ?? "all";
      const mode = account.tradingMode === "simulation" ? "SIMULATION" : account.tradingMode === "live" ? "LIVE" : "UNKNOWN";
      return {
        sections: [
          { title: "Account", entries: [{ label: "Broker", value: broker.name }, { label: "Account", value: account.name }, { label: "Mode", value: mode }] },
          ...(view !== "activity" ? [{ title: "Open orders", columns: orderColumns, rows: data.orders.map((order) => ({
            symbol: order.contract.localSymbol || order.contract.symbol, side: order.action, status: brokerOrderStatus(order.status),
            quantity: order.quantity, filled: order.filled, orderType: order.orderType,
            limitPrice: order.limitPrice ?? null, stopPrice: order.stopPrice ?? null,
            updatedAt: isoTime(order.updatedAt),
          })) }] : []),
          ...(view !== "open" ? [{ title: data.executionKind === "order-summaries" ? "Cumulative order summaries" : "Recent activity", columns: activityColumns,
            rows: data.executions.map((execution) => ({ symbol: execution.contract.localSymbol || execution.contract.symbol,
              side: execution.side, quantity: execution.shares, price: execution.price,
              commission: execution.commission ?? null, commissionCurrency: execution.commissionCurrency ?? null,
              time: isoTime(execution.time) })) }] : []),
        ],
        complete: data.errors.length === 0, errors: data.errors, notes: data.notes,
        freshness: { source: broker.name, status: "not-a-feed", basis: "broker account snapshot", asOf: data.updatedAt, oldest: null },
      };
    },
  };
}

export const brokerOrdersHeadless = createBrokerOrdersHeadless();
