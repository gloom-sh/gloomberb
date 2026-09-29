import type { QuoteSubscriptionTarget } from "../../../../types/data-provider";
import type { Quote } from "../../../../types/financials";
import { unpackQuoteEvents } from "../../shared/quote-event-batch";
import type { CapabilitySubscriptionOptions } from "../capability-subscription";

interface BackendQuoteSubscription {
  signature: string;
  retired: boolean;
  /** The set this one replaces; it is retired once this one is registered. */
  predecessor: BackendQuoteSubscription | null;
  dispose: () => void;
}

export interface BackendQuoteSubscriptionDeps {
  /** Starts one target set in the backend and returns its dispose, as `subscribeCapability` does. */
  subscribe(
    subscriptionId: string,
    targets: QuoteSubscriptionTarget[],
    handlers: Pick<CapabilitySubscriptionOptions, "onEvent" | "onSubscribed" | "onError">,
  ): () => void;
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
    subscription.dispose();
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

      const subscription: BackendQuoteSubscription = {
        signature,
        retired: false,
        predecessor: previous,
        dispose: () => {},
      };
      current = subscription;
      subscription.dispose = deps.subscribe(`quote:${nextId++}`, targets, {
        onEvent: receive,
        onSubscribed: () => {
          const older = subscription.predecessor;
          subscription.predecessor = null;
          retireChain(older);
        },
        onError: (error) => {
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
        },
      });
    },
  };
}
