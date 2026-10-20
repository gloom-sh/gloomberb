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

/**
 * The ticket's latest word on an order merged into the broker's list, first. A replacement takes a new broker ID
 * but keeps the order's handle: it stands for the listed original while that is being replaced, or is older.
 */
export function withLatestOrder(orders: readonly BrokerOrder[], latest: BrokerOrder): BrokerOrder[] {
  const key = brokerOrderKey(latest);
  const listed = orders.find((order) => brokerOrderKey(order) === key)
    ?? orders.find((order) => order.accountId === latest.accountId && order.orderId === latest.orderId);
  if (!listed) return [latest, ...orders];
  const replacing = brokerOrderKey(listed) !== key && /^PENDING[\s_-]?REPLACE$/i.test(listed.status);
  return replacing || listed.updatedAt <= latest.updatedAt ? [latest, ...orders.filter((order) => order !== listed)] : [...orders];
}

export function brokerOrderStatus(status: string): string {
  const key = status.toUpperCase().replace(/[\s_-]/g, "");
  if (["SUBMITTED", "PRESUBMITTED", "OPEN", "NEW", "ACCEPTED", "WORKING", "REPLACED"].includes(key)) return "Working";
  // Working at its old terms until the broker takes the change.
  if (key === "PENDINGREPLACE") return "Replacing";
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

/**
 * Both the pane and report use the same account projection, including partial
 * failures. The pane passes the order feed's open orders, so only activity is
 * read here; the report reads both.
 */
export async function loadBrokerOrdersSnapshot(
  broker: BrokerAdapter,
  instance: BrokerInstanceConfig,
  accountId: string,
  signal?: AbortSignal,
  openOrders?: { orders: readonly BrokerOrder[]; failed: boolean },
): Promise<BrokerOrdersSnapshot> {
  if (!accountId) throw new Error("Choose an account first.");
  signal?.throwIfAborted();
  const results = await Promise.allSettled([
    openOrders ? (openOrders.failed ? Promise.reject(new Error("unavailable")) : Promise.resolve([...openOrders.orders]))
      : Promise.resolve().then(() => broker.listOpenOrders ? broker.listOpenOrders(instance) : null),
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

/**
 * The wheel, arrow and +/- step for a price when the broker declares no tick:
 * a cent, or a hundredth of a cent under a dollar, never finer than the
 * decimals the broker accepts. Five accepted decimals are not a $0.00001 tick,
 * and stepping by one moved a $343 limit by nothing anyone could see.
 */
export function ticketEditingPriceStep(price: number | undefined, decimals?: number): number {
  const step = price !== undefined && Number.isFinite(price) && price > 0 && price < 1 ? 0.0001 : 0.01;
  const finest = decimals !== undefined && Number.isInteger(decimals) && decimals >= 0 && decimals <= 18 ? 10 ** -decimals : 0;
  return Math.max(step, finest);
}
