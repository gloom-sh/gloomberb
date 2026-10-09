import type { BrokerAdapter } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { BrokerExecution, BrokerOrder } from "../../../types/trading";

export interface BrokerOrdersSnapshot {
  brokerInstanceId: string;
  accountId: string;
  orders: BrokerOrder[];
  executions: BrokerExecution[];
  executionKind: "fills" | "order-summaries" | "unspecified";
  updatedAt: number;
  errors: string[];
  notes: string[];
}

export function brokerOrderKey(order: BrokerOrder): string {
  return `${order.accountId ?? ""}:${order.brokerOrderId ?? order.orderId}`;
}

export function brokerOrderStatus(status: string): string {
  const key = status.toUpperCase().replace(/[\s_-]/g, "");
  if (["SUBMITTED", "PRESUBMITTED", "OPEN", "NEW", "ACCEPTED", "WORKING"].includes(key)) return "Working";
  if (["PARTIALLYFILLED", "PARTIALFILL", "PARTIAL"].includes(key)) return "Partially filled";
  if (["PENDINGCANCEL", "CANCELPENDING"].includes(key)) return "Pending cancel";
  if (["CANCELLED", "CANCELED"].includes(key)) return "Cancelled";
  if (key === "FILLED") return "Filled";
  if (["REJECTED", "INACTIVE"].includes(key)) return "Rejected";
  if (key === "EXPIRED") return "Expired";
  if (key === "UNKNOWN") return "UNKNOWN";
  return status || "UNKNOWN";
}

export function canChangeBrokerOrder(order: BrokerOrder): boolean {
  return !["Pending cancel", "Cancelled", "Filled", "Rejected", "Expired", "UNKNOWN"].includes(brokerOrderStatus(order.status))
    && order.remaining > 0;
}

/** Both the pane and report use the same account projection, including partial failures. */
export async function loadBrokerOrdersSnapshot(
  broker: BrokerAdapter,
  instance: BrokerInstanceConfig,
  accountId: string,
  signal?: AbortSignal,
): Promise<BrokerOrdersSnapshot> {
  if (!accountId) throw new Error("Choose an account first.");
  signal?.throwIfAborted();
  const results = await Promise.allSettled([
    Promise.resolve().then(() => broker.listOpenOrders ? broker.listOpenOrders(instance) : null),
    Promise.resolve().then(() => broker.listExecutions ? broker.listExecutions(instance) : null),
  ]);
  signal?.throwIfAborted();
  const errors: string[] = [];
  const notes: string[] = [];
  const [open, activity] = results;
  if (open.status === "rejected") errors.push("Open orders are unavailable. Refresh to try again.");
  else if (open.value === null) notes.push("This broker does not report open orders.");
  if (activity.status === "rejected") errors.push("Recent activity is unavailable. Refresh to try again.");
  else if (activity.value === null) notes.push("This broker does not report recent activity.");
  const orders = open.status === "fulfilled" ? open.value ?? [] : [];
  const executions = activity.status === "fulfilled" ? activity.value ?? [] : [];
  const belongs = (row: BrokerOrder | BrokerExecution) => row.accountId === accountId
    && (!row.brokerInstanceId || row.brokerInstanceId === instance.id)
    && (!row.contract.brokerInstanceId || row.contract.brokerInstanceId === instance.id);
  if ([...orders, ...executions].some((row) => !row.accountId)) notes.push("Rows without an account identity are omitted.");
  return {
    brokerInstanceId: instance.id,
    accountId,
    orders: orders.filter(belongs).sort((a, b) => b.updatedAt - a.updatedAt),
    executions: executions.filter(belongs).sort((a, b) => b.time - a.time),
    executionKind: broker.getTradingCapabilities?.(instance).executionKind ?? "unspecified",
    updatedAt: Date.now(), errors, notes,
  };
}
