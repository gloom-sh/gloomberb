import type { QuoteSubscriptionTarget } from "../../../../types/data-provider";
import type { Quote } from "../../../../types/financials";
import { unpackQuoteEvents } from "../../shared/quote-event-batch";

interface BackendQuoteSubscription {
  id: string;
  signature: string;
  retired: boolean;
  /** Whether the backend has answered the subscribe request. */
  settled: boolean;
  /** The set this one replaces; it is retired once this one is registered. */
  predecessor: BackendQuoteSubscription | null;
  disposeEvents: () => void;
}

export interface BackendQuoteSubscriptionDeps {
  subscribe(subscriptionId: string, targets: QuoteSubscriptionTarget[]): Promise<unknown>;
  unsubscribe(subscriptionId: string): void;
  onEvent(subscriptionId: string, listener: (event: unknown) => void): () => void;
  dispatch(target: QuoteSubscriptionTarget, quote: Quote): void;
  onClockOffset?(offsetMs: number): void;
  onError?(error: unknown): void;
}

function targetsSignature(targets: QuoteSubscriptionTarget[]): string {
  return JSON.stringify(targets
    .map((target) => JSON.stringify([
      target.symbol,
      target.exchange ?? "",
      target.route ?? "auto",
      target.surface ?? "",
      target.visible ?? null,
      target.selected ?? null,
      Number.isFinite(target.weight) ? target.weight : null,
      target.context ?? null,
    ]))
    .sort());
}

/**
 * Keeps one window's quote targets subscribed in the backend process. A new
 * target set is registered before the one it replaces is retired, so symbols
 * in both never drop to zero listeners there: a priority change does not close
 * the cloud socket or restart a broker's market data line. An unchanged set
 * sends nothing.
 */
export function createBackendQuoteSubscription(deps: BackendQuoteSubscriptionDeps): {
  sync(targets: QuoteSubscriptionTarget[]): void;
} {
  let nextId = 1;
  let current: BackendQuoteSubscription | null = null;
  let currentSignature = "";

  const retire = (subscription: BackendQuoteSubscription | null) => {
    if (!subscription || subscription.retired) return;
    subscription.retired = true;
    subscription.disposeEvents();
    // An unsubscribe that overtakes its own subscribe would leave it running;
    // an in-flight one is torn down when it settles.
    if (subscription.settled) deps.unsubscribe(subscription.id);
  };

  const retireChain = (subscription: BackendQuoteSubscription | null) => {
    let next = subscription;
    while (next) {
      retire(next);
      const older: BackendQuoteSubscription | null = next.predecessor;
      next.predecessor = null;
      next = older;
    }
  };

  const receive = (event: unknown) => {
    const { events, clockOffsetMs } = unpackQuoteEvents(event);
    if (clockOffsetMs !== undefined) deps.onClockOffset?.(clockOffsetMs);
    for (const item of events) {
      const { target, quote } = (item ?? {}) as { target?: QuoteSubscriptionTarget; quote?: Quote };
      if (target && quote) deps.dispatch(target, quote);
    }
  };

  return {
    sync(targets) {
      const signature = targetsSignature(targets);
      if (signature === currentSignature) return;
      currentSignature = signature;
      const previous = current;
      if (targets.length === 0) {
        current = null;
        retireChain(previous);
        return;
      }

      const id = `quote:${nextId++}`;
      const subscription: BackendQuoteSubscription = {
        id,
        signature,
        retired: false,
        settled: false,
        predecessor: previous,
        disposeEvents: deps.onEvent(id, receive),
      };
      current = subscription;
      deps.subscribe(id, targets).then(() => {
        subscription.settled = true;
        if (subscription.retired) deps.unsubscribe(id);
        const older = subscription.predecessor;
        subscription.predecessor = null;
        retireChain(older);
      }, (error) => {
        subscription.settled = true;
        const older = subscription.predecessor;
        subscription.predecessor = null;
        retire(subscription);
        if (current === subscription) {
          // The older set is still live in the backend; the next change retries.
          current = older && !older.retired ? older : null;
          currentSignature = current?.signature ?? "";
        } else if (current) {
          // A newer set is on its way and retires the older ones once it lands.
          let newer: BackendQuoteSubscription = current;
          while (newer.predecessor && newer.predecessor !== subscription) newer = newer.predecessor;
          if (newer.predecessor === subscription) newer.predecessor = older;
        } else {
          retireChain(older);
        }
        deps.onError?.(error);
      });
    },
  };
}
