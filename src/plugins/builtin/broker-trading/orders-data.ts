import type { BrokerAdapter } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { BrokerExecution, BrokerOrder } from "../../../types/trading";
import { formatNumber } from "../../../utils/format";

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
  if (["SUBMITTED", "PRESUBMITTED", "OPEN", "NEW", "ACCEPTED", "WORKING", "PENDINGREPLACE", "REPLACED"].includes(key)) return "Working";
  // Sent, not yet acknowledged by the venue (Aries PENDING_NEW).
  if (key === "PENDINGNEW") return "Submitted";
  if (["PARTIALLYFILLED", "PARTIALFILL", "PARTIAL"].includes(key)) return "Partially filled";
  if (["PENDINGCANCEL", "CANCELPENDING"].includes(key)) return "Pending cancel";
  if (["CANCELLED", "CANCELED"].includes(key)) return "Cancelled";
  if (key === "FILLED") return "Filled";
  if (["REJECTED", "INACTIVE"].includes(key)) return "Rejected";
  if (key === "EXPIRED") return "Expired";
  if (key === "UNKNOWN") return "UNKNOWN";
  return status || "UNKNOWN";
}

const DONE = new Set(["Cancelled", "Filled", "Rejected", "Expired"]);
/** Whether a broker status, or its label, is final: cancelled, filled, rejected or expired. */
export function brokerOrderDone(status: string): boolean {
  return DONE.has(brokerOrderStatus(status));
}

export function canChangeBrokerOrder(order: BrokerOrder): boolean {
  const status = brokerOrderStatus(order.status);
  return !DONE.has(status) && status !== "Pending cancel" && status !== "UNKNOWN" && order.remaining > 0;
}

export const formatOrderQuantity = (value: number) => Number.isFinite(value) ? formatNumber(value, Number.isInteger(value) ? 0 : 4) : "--";
export const formatOrderPrice = (value: number | undefined) => value != null && Number.isFinite(value) ? formatNumber(value, 2) : "--";
/** Execution sides as brokers write them: BUY, BOT or B. */
export const isBuySide = (side: string) => ["BUY", "BOT", "B"].includes(side.toUpperCase());

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
