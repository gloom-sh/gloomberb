import { mergeQuoteSubscriptionTargets } from "../../../../market-data/quote-subscription-target";
import type { QuoteSubscriptionTarget } from "../../../../types/data-provider";
import type { Quote } from "../../../../types/financials";

export type RemoteQuoteListener = (target: QuoteSubscriptionTarget, quote: Quote) => void;

interface RemoteQuoteSubscriptionEntry {
  target: QuoteSubscriptionTarget;
  listener: RemoteQuoteListener;
}

function quoteTargetKey(target: QuoteSubscriptionTarget): string {
  return `${target.symbol}:${target.exchange ?? ""}:${target.context?.brokerId ?? ""}:${target.context?.brokerInstanceId ?? ""}:${target.context?.instrument?.conId ?? target.context?.instrument?.localSymbol ?? target.context?.instrument?.symbol ?? ""}`;
}

export class RemoteQuoteSubscriptionRegistry {
  private nextSubscriptionId = 1;
  private readonly entriesByTarget = new Map<string, Map<number, RemoteQuoteSubscriptionEntry>>();

  constructor(private readonly onChange: () => void = () => {}) {}

  subscribe(targets: QuoteSubscriptionTarget[], listener: RemoteQuoteListener): () => void {
    const groupedTargets = new Map<string, QuoteSubscriptionTarget[]>();
    for (const target of targets) {
      const key = quoteTargetKey(target);
      const group = groupedTargets.get(key) ?? [];
      group.push(target);
      groupedTargets.set(key, group);
    }
    if (groupedTargets.size === 0) return () => {};

    const subscriptionId = this.nextSubscriptionId++;
    for (const [key, candidates] of groupedTargets) {
      const target = mergeQuoteSubscriptionTargets(candidates);
      if (!target) continue;
      const entries = this.entriesByTarget.get(key) ?? new Map();
      entries.set(subscriptionId, { target, listener });
      this.entriesByTarget.set(key, entries);
    }
    this.onChange();

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      for (const key of groupedTargets.keys()) {
        const entries = this.entriesByTarget.get(key);
        if (!entries) continue;
        entries.delete(subscriptionId);
        if (entries.size === 0) this.entriesByTarget.delete(key);
      }
      this.onChange();
    };
  }

  backendTargets(): QuoteSubscriptionTarget[] {
    const targets: QuoteSubscriptionTarget[] = [];
    for (const entries of this.entriesByTarget.values()) {
      const target = mergeQuoteSubscriptionTargets(
        [...entries.values()].map((entry) => entry.target),
      );
      if (target) targets.push(target);
    }
    return targets;
  }

  dispatch(target: QuoteSubscriptionTarget, quote: Quote): void {
    for (const entry of this.entriesByTarget.get(quoteTargetKey(target))?.values() ?? []) {
      entry.listener(entry.target, quote);
    }
  }
}
