import { logFailure } from "../../../utils/log-failure";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { BrokerAdapter } from "../../../types/broker";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { AppNotificationRequest } from "../../../types/plugin";
import type { BrokerOrder } from "../../../types/trading";
import { brokerOrderDone, brokerOrderStatus } from "./orders-data";
import { orderInstrumentLabel } from "./strategy";
import { linkRoleName, trailingText } from "./linked-orders";

/** Reconcile with open orders this often while the broker pushes changes. */
const LIVE_RECONCILE_MS = 60_000;
/** Without pushes: poll this often while an order works, and this often otherwise. */
const WORKING_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;
/** After failed reads: wait this long, doubling each time, up to the cap. */
const FAILED_READ_MS = 5_000;
const FAILED_READ_MAX_MS = 60_000;
/** An order that ended stays in the feed this long, so a ticket and the drawer can show how. */
const DONE_RETENTION_MS = 10 * 60_000;
/** An order first seen already ended is news only if it ended this recently. */
const RECENT_END_MS = 2 * 60_000;
const SEEN_LIMIT = 1_000;
/** A fill re-syncs its profile's positions this long after the last fill in a burst, and no later than the cap after the first. */
const FILL_SYNC_MS = 2_000;
const FILL_SYNC_MAX_WAIT_MS = 10_000;

export interface BrokerOrderFeedState {
  /** Working orders, and those that ended while watched, newest first. */
  orders: readonly BrokerOrder[];
  /** The first read of open orders has answered. */
  loaded: boolean;
  /** The broker pushes changes now; otherwise the feed polls. */
  live: boolean;
  /** The last read failed; `orders` are the last known. */
  failed: boolean;
  updatedAt: number;
  /** Counts fills seen, so a view of executions knows when to read them again. */
  fills: number;
}

const EMPTY: BrokerOrderFeedState = Object.freeze({ orders: Object.freeze([]) as readonly BrokerOrder[], loaded: false, live: false, failed: false, updatedAt: 0, fills: 0 });

/** One order through cancels and replacements: its profile, account and host handle. */
function orderFeedKey(instanceId: string, order: Pick<BrokerOrder, "accountId" | "orderId">): string {
  return `${instanceId}:${order.accountId ?? ""}:${order.orderId}`;
}

interface Seen { filled: number; done: boolean }

interface OrderToast { title: string; type: AppNotificationRequest["type"] }

/**
 * What an order's change says to someone not looking at it: a fill, partial
 * fill, cancellation, rejection or expiry, once. A first sighting is news only
 * when the order ended moments ago; an order already seen ended says nothing.
 */
function orderChangeToast(before: Seen | undefined, order: BrokerOrder, now: number): OrderToast | null {
  const status = brokerOrderStatus(order.status);
  const done = brokerOrderDone(order.status);
  if (before?.done) return null;
  if (!before && (!done || now - order.updatedAt > RECENT_END_MS)) return null;
  const filledMore = Number.isFinite(order.filled) && order.filled > (before?.filled ?? 0);
  if (status === "Filled" || (filledMore && order.filled >= order.quantity)) return { title: "Order filled", type: "success" };
  if (filledMore) return { title: "Partial fill", type: "success" };
  if (status === "Cancelled") return { title: "Order cancelled", type: "info" };
  if (status === "Rejected") return { title: "Order rejected", type: "error" };
  if (status === "Expired") return { title: "Order expired", type: "info" };
  return null;
}

export function orderToastBody(order: BrokerOrder): string {
  const symbol = orderInstrumentLabel(order);
  const qty = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  const filled = order.filled > 0 && Number.isFinite(order.avgFillPrice) ? ` · ${qty(order.filled)} filled at ${order.avgFillPrice!.toLocaleString("en-US", { maximumFractionDigits: 4 })}` : "";
  const limit = order.orderType === "MKT" ? "market" : order.orderType === "TRAIL" ? trailingText(order, qty).toLowerCase()
    : `${order.orderType === "STP" ? "stop" : "limit"} ${(order.limitPrice ?? order.stopPrice)?.toLocaleString("en-US", { maximumFractionDigits: 4 }) ?? ""}`.trim();
  // A bracket's exit says which one filled or ended.
  const role = order.linkRole && order.linkRole !== "entry" ? ` ${linkRoleName[order.linkRole].toLowerCase()}` : "";
  return `${order.action === "BUY" ? "Buy" : "Sell"} ${qty(order.quantity)} ${symbol}${role} ${limit}${filled}`;
}

/**
 * One profile's orders: read from open orders when it connects, then kept
 * current by the broker's order stream when it has one, with a slow
 * reconcile, or by polling open orders when it has none or the stream is
 * quiet. An order that leaves the open list is asked for by `getOrderStatus`,
 * since absence alone proves neither a fill nor a cancel; one the broker
 * cannot confirm stays, as UNKNOWN. A profile with trading off is read when
 * it connects and on refresh, never polled.
 */
class ProfileOrderFeed {
  private orders = new Map<string, BrokerOrder>();
  private state: BrokerOrderFeedState = EMPTY;
  private holders = 0;
  private connected = false;
  private live = false;
  private reading = false;
  private rereadAfter = false;
  private baselined = false;
  private generation = 0;
  private failures = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private stopStatus?: () => void;
  private stopStream?: () => void;

  constructor(
    readonly broker: BrokerAdapter,
    private instance: BrokerInstanceConfig,
    private readonly feed: BrokerOrderFeed,
  ) {}

  get snapshot(): BrokerOrderFeedState { return this.state; }

  retain(instance: BrokerInstanceConfig): void {
    this.instance = instance;
    if (this.holders++ > 0) {
      // Trading turned on (a new profile config) starts the polling it stopped.
      if (this.timer === undefined && !this.reading) this.schedule();
      return;
    }
    this.stopStatus = this.broker.subscribeStatus?.(this.instance, () => this.observe()) ?? undefined;
    this.observe();
  }

  release(): boolean {
    if (--this.holders > 0) return false;
    this.generation++;
    this.stopStatus?.(); this.stopStatus = undefined;
    this.disconnect();
    return true;
  }

  refresh(): void { if (this.connected) void this.read(); }

  /** Stops reading and listening, whoever still holds it. */
  stop(): void {
    this.holders = 0;
    this.generation++;
    this.stopStatus?.(); this.stopStatus = undefined;
    this.disconnect();
  }

  /**
   * An order this app placed or changed, as its broker answered; recorded so
   * the feed does not toast it again. A report the feed already has is the
   * broker's own and stays.
   */
  note(order: BrokerOrder): void {
    if (this.orders.has(orderFeedKey(this.instance.id, order))) this.feed.observeChange(this.instance.id, order, true);
    else this.apply(order, "local");
  }

  private observe(): void {
    let state: string | undefined;
    try { state = this.broker.getStatus?.(this.instance).state; } catch (error) {
      logFailure("broker-trading.order-feed", "Read broker connection status failed")(error);
      state = undefined;
    }
    const connected = state === "connected";
    if (connected === this.connected) return;
    this.connected = connected;
    if (!connected) { this.disconnect(); this.publish(); return; }
    this.baselined = false;
    this.failures = 0;
    if (this.broker.subscribeOrders) {
      try {
        this.stopStream = this.broker.subscribeOrders(this.instance, {
          order: (order) => this.apply(order, "push"),
          live: (live) => {
            if (live === this.live) return;
            this.live = live;
            // Coming back, the stream may have missed changes: read the open list once.
            if (live) void this.read(); else this.schedule();
            this.publish();
          },
        });
      } catch (error) {
        logFailure("broker-trading.order-feed", "Subscribe to broker orders failed")(error);
        this.stopStream = undefined;
      }
    }
    void this.read();
  }

  private disconnect(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.stopStream?.(); this.stopStream = undefined;
    this.connected = false;
    this.live = false;
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.connected || this.holders === 0 || !this.tradingOn()) return;
    // An unconfirmed order is asked about again at the idle pace, not every few seconds.
    const working = [...this.orders.values()].some((order) => !brokerOrderDone(order.status) && brokerOrderStatus(order.status) !== "UNKNOWN");
    const cadence = this.live ? LIVE_RECONCILE_MS : working ? WORKING_POLL_MS : IDLE_POLL_MS;
    const backoff = this.failures ? Math.min(FAILED_READ_MAX_MS, FAILED_READ_MS * 2 ** (this.failures - 1)) : 0;
    this.timer = setTimeout(() => { this.timer = undefined; void this.read(); }, Math.max(cadence, backoff));
  }

  private tradingOn(): boolean {
    try { return this.broker.getTradingCapabilities?.(this.instance)?.enabled === true; } catch (error) {
      logFailure("broker-trading.order-feed", "Read broker trading capabilities failed")(error);
      return false;
    }
  }

  private async read(): Promise<void> {
    if (!this.broker.listOpenOrders || !this.connected) return;
    if (this.reading) { this.rereadAfter = true; return; }
    this.reading = true;
    const generation = this.generation;
    try {
      const open = await this.broker.listOpenOrders(this.instance);
      if (generation !== this.generation || !this.connected) return;
      const baseline = !this.baselined;
      const listed = new Set<string>();
      for (const order of open) {
        listed.add(orderFeedKey(this.instance.id, order));
        this.apply(order, baseline ? "baseline" : "poll", false);
      }
      // A working order missing from the list ended somehow; only the broker can say how.
      const missing = [...this.orders].filter(([key, order]) => !listed.has(key) && !brokerOrderDone(order.status));
      for (const [key, order] of missing) {
        // A broker with no status read says nothing beyond its open list.
        if (!this.broker.getOrderStatus) { this.orders.delete(key); continue; }
        const status = await this.broker.getOrderStatus(this.instance, order.orderId).catch(logFailure("broker-trading.order-feed", "Read missing broker order status failed"));
        if (generation !== this.generation) return;
        if (status) this.apply(status, baseline ? "baseline" : "poll", false);
        // Null is the broker unable to confirm it, not an end: keep it, unconfirmed, at its last report's time,
        // so the next read that lists it or a status that answers replaces it.
        else if (status === null && brokerOrderStatus(order.status) !== "UNKNOWN") this.apply({ ...order, status: "UNKNOWN" }, baseline ? "baseline" : "poll", false);
      }
      this.failures = 0;
      this.baselined = true;
      this.prune();
      this.publish({ failed: false, loaded: true });
    } catch {
      if (generation === this.generation) { this.failures++; this.publish({ failed: true, loaded: true }); }
    } finally {
      this.reading = false;
      if (generation === this.generation) {
        if (this.rereadAfter) { this.rereadAfter = false; void this.read(); } else this.schedule();
      }
    }
  }

  private apply(order: BrokerOrder, source: "baseline" | "poll" | "push" | "local", publish = true): void {
    const key = orderFeedKey(this.instance.id, order);
    const previous = this.orders.get(key);
    // A read that started before a push can answer with the older state.
    if (previous && source === "poll" && order.updatedAt < previous.updatedAt) return;
    if (previous && brokerOrderDone(previous.status) && !brokerOrderDone(order.status)) return;
    this.orders.set(key, order);
    // What was seen before decides a toast, so a first read after launch, where every order is new, says nothing.
    this.feed.observeChange(this.instance.id, order, source === "local");
    if (publish) { this.prune(); this.publish(); }
    // An order that started working needs the faster cadence without a stream.
    if (!this.live && !brokerOrderDone(order.status) && (!previous || brokerOrderDone(previous.status))) this.schedule();
    // One of a bracket or OCO pair ending moves the others (cancelled, or working once an entry fills): the broker's
    // list says how, now rather than at the next read.
    if (order.linkGroup && source !== "baseline" && source !== "poll" && brokerOrderDone(order.status) && !(previous && brokerOrderDone(previous.status))) this.refresh();
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, order] of this.orders) {
      if (brokerOrderDone(order.status) && now - order.updatedAt > DONE_RETENTION_MS) this.orders.delete(key);
    }
  }

  private publish(changes: Partial<BrokerOrderFeedState> = {}): void {
    const orders = [...this.orders.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    this.state = Object.freeze({ ...this.state, ...changes, orders, live: this.live, updatedAt: Date.now(), fills: this.feed.fillCount(this.instance.id) });
    this.feed.changed();
  }
}

/**
 * Every trading profile's orders, shared by the order drawer, the Orders pane,
 * Overview and the ticket, and the source of the app's order toasts. Views
 * hold a profile while mounted; the plugin holds every connected trading
 * profile for as long as the app runs, so a fill toasts with no ticket open.
 */
export class BrokerOrderFeed {
  private readonly profiles = new Map<string, ProfileOrderFeed>();
  private readonly listeners = new Set<() => void>();
  private readonly seen = new Map<string, Seen>();
  private readonly fills = new Map<string, number>();
  private readonly fillSyncs = new Map<string, { timer?: ReturnType<typeof setTimeout>; firstAt: number; running: boolean; again: boolean }>();
  private notifier?: (notification: AppNotificationRequest) => void;
  private syncPositions?: (instanceId: string) => Promise<unknown>;

  /** Toasts go through the app's notifications once the plugin is set up. */
  setNotifier(notify: ((notification: AppNotificationRequest) => void) | undefined): void { this.notifier = notify; }

  /**
   * How a fill reaches the portfolio: the app's sync of the profile's
   * positions, which the plugin sets up. A fill or partial fill schedules it
   * once for a burst of fills; one during a sync runs it again after.
   */
  setPositionSync(sync: ((instanceId: string) => Promise<unknown>) | undefined): void {
    this.syncPositions = sync;
    if (!sync) this.cancelFillSyncs();
  }

  hold(broker: BrokerAdapter, instance: BrokerInstanceConfig): () => void {
    let profile = this.profiles.get(instance.id);
    if (!profile || profile.broker !== broker) {
      profile = new ProfileOrderFeed(broker, instance, this);
      this.profiles.set(instance.id, profile);
    }
    const held = profile;
    held.retain(instance);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (held.release() && this.profiles.get(instance.id) === held) this.profiles.delete(instance.id);
    };
  }

  /** Lets go of every profile and forgets every order seen, as when the plugin is disposed. */
  clear(): void {
    for (const profile of this.profiles.values()) profile.stop();
    this.profiles.clear();
    this.seen.clear();
    this.fills.clear();
    this.cancelFillSyncs();
    this.changed();
  }

  snapshot(instanceId: string): BrokerOrderFeedState { return this.profiles.get(instanceId)?.snapshot ?? EMPTY; }

  refresh(instanceId: string): void { this.profiles.get(instanceId)?.refresh(); }

  /** A placement or change the ticket already announced: the feed records it without a toast. */
  note(instanceId: string, order: BrokerOrder): void {
    const profile = this.profiles.get(instanceId);
    if (profile) profile.note(order);
    else this.observeChange(instanceId, order, true);
  }

  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  /** @internal */
  changed(): void { for (const listener of [...this.listeners]) listener(); }

  /** @internal */
  fillCount(instanceId: string): number { return this.fills.get(instanceId) ?? 0; }

  /** @internal Records an order's state, and toasts its change unless `quiet`. */
  observeChange(instanceId: string, order: BrokerOrder, quiet: boolean): void {
    const key = orderFeedKey(instanceId, order);
    const before = this.seen.get(key);
    const filled = Number.isFinite(order.filled) ? Math.max(order.filled, before?.filled ?? 0) : before?.filled ?? 0;
    this.seen.delete(key);
    this.seen.set(key, { filled, done: (before?.done ?? false) || brokerOrderDone(order.status) });
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.keys().next().value!);
    if (filled > (before?.filled ?? 0)) {
      this.fills.set(instanceId, (this.fills.get(instanceId) ?? 0) + 1);
      // A fill moves the account's positions. An order first seen already filled long ago (the first read at
      // launch, which the startup import covers) does not.
      if (before || Date.now() - order.updatedAt <= RECENT_END_MS) this.scheduleFillSync(instanceId);
    }
    if (quiet || !this.notifier) return;
    const toast = orderChangeToast(before, order, Date.now());
    if (toast) this.notifier({ ...toast, desktop: "when-inactive", body: orderToastBody(order) });
  }

  private scheduleFillSync(instanceId: string): void {
    if (!this.syncPositions) return;
    const now = Date.now();
    const entry = this.fillSyncs.get(instanceId) ?? { firstAt: now, running: false, again: false };
    if (entry.timer === undefined) entry.firstAt = now;
    else clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.runFillSync(instanceId), Math.max(0, Math.min(FILL_SYNC_MS, entry.firstAt + FILL_SYNC_MAX_WAIT_MS - now)));
    this.fillSyncs.set(instanceId, entry);
  }

  private runFillSync(instanceId: string): void {
    const entry = this.fillSyncs.get(instanceId);
    const sync = this.syncPositions;
    if (!entry || !sync) return;
    entry.timer = undefined;
    if (entry.running) { entry.again = true; return; }
    entry.running = true;
    // A failed sync leaves the portfolio as it was; the next fill, a manual sync or the next launch reads it again.
    void Promise.resolve().then(() => sync(instanceId)).catch(logFailure("broker-trading.order-feed", "Sync positions after broker fill failed")).finally(() => {
      entry.running = false;
      if (this.fillSyncs.get(instanceId) !== entry) return;
      if (entry.again) { entry.again = false; this.runFillSync(instanceId); } else if (entry.timer === undefined) this.fillSyncs.delete(instanceId);
    });
  }

  private cancelFillSyncs(): void {
    for (const entry of this.fillSyncs.values()) if (entry.timer !== undefined) clearTimeout(entry.timer);
    this.fillSyncs.clear();
  }
}

export const brokerOrderFeed = new BrokerOrderFeed();

/** A profile's orders from the shared feed, held while the view is mounted and connected. */
export function useBrokerOrderFeed(broker: BrokerAdapter | null | undefined, instance: BrokerInstanceConfig | null | undefined, active = true): BrokerOrderFeedState {
  const instanceId = instance?.id;
  useEffect(() => {
    if (!active || !broker || !instance || !broker.listOpenOrders) return;
    return brokerOrderFeed.hold(broker, instance);
  }, [active, broker, instance]);
  return useSyncExternalStore(brokerOrderFeed.subscribe, () => instanceId ? brokerOrderFeed.snapshot(instanceId) : EMPTY, () => EMPTY);
}

/**
 * Keeps an order result in step with the feed. A report the feed held when
 * the result was set (placed, changed, cancelled or read) is older news than
 * the result unless it says the order ended; reports after it apply as they
 * come. `apply` answers the result it leaves.
 */
export function useFeedOrderResult(feed: BrokerOrderFeedState, instanceId: string, result: BrokerOrder | undefined, apply: (order: BrokerOrder) => BrokerOrder | undefined): void {
  const track = useRef<{ result?: BrokerOrder; known?: BrokerOrder }>({});
  useEffect(() => {
    if (!result || result.orderId === 0) { track.current = {}; return; }
    const key = orderFeedKey(instanceId, result);
    const latest = feed.orders.find((order) => orderFeedKey(instanceId, order) === key);
    if (result !== track.current.result) track.current = { result, known: latest && !brokerOrderDone(latest.status) ? latest : undefined };
    if (!latest || latest === track.current.known) return;
    track.current = { result: apply(latest), known: latest };
  }, [feed.orders, result, instanceId, apply]);
}

/** Several profiles' orders, in the order given; for views that span every trading profile. */
export function useBrokerOrderFeeds(sources: readonly { broker: BrokerAdapter; instance: BrokerInstanceConfig }[], active = true): readonly BrokerOrderFeedState[] {
  useEffect(() => {
    if (!active) return;
    const releases = sources.filter(({ broker }) => broker.listOpenOrders).map(({ broker, instance }) => brokerOrderFeed.hold(broker, instance));
    return () => { for (const release of releases) release(); };
  }, [active, sources]);
  const cache = useRef<readonly BrokerOrderFeedState[]>([]);
  const read = () => {
    const next = sources.map(({ instance }) => brokerOrderFeed.snapshot(instance.id));
    const previous = cache.current;
    if (next.length !== previous.length || next.some((state, index) => state !== previous[index])) cache.current = next;
    return cache.current;
  };
  return useSyncExternalStore(brokerOrderFeed.subscribe, read, read);
}
