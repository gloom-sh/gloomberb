export interface QuoteSubscriptionPriorityTarget {
  surface?: "portfolio" | "watchlist" | "detail" | "monitor" | "inline" | "options" | "screener" | "unknown";
  visible?: boolean;
  selected?: boolean;
  weight?: number;
}

function quoteSubscriptionPriorityScore(target: QuoteSubscriptionPriorityTarget): number {
  let score = Number.isFinite(target.weight) ? Math.max(0, target.weight ?? 0) : 0;
  if (target.selected) score += 10_000;
  if (target.visible) score += 5_000;
  if (target.surface === "detail" || target.surface === "monitor" || target.surface === "options") score += 4_000;
  if (target.surface === "portfolio" || target.surface === "watchlist") score += 1_000;
  if (target.surface === "screener") score += 700;
  if (target.surface === "inline") score += 200;
  return score;
}

export function mergeQuoteSubscriptionTargets<T extends QuoteSubscriptionPriorityTarget>(
  targets: Iterable<T>,
): T | null {
  let selectedTarget: T | null = null;
  let selectedScore = -1;
  let visible = false;
  let selected = false;
  let weight = 0;
  let hasVisible = false;
  let hasSelected = false;
  let hasWeight = false;

  for (const target of targets) {
    const score = quoteSubscriptionPriorityScore(target);
    if (!selectedTarget || score > selectedScore) {
      selectedTarget = target;
      selectedScore = score;
    }
    if (target.visible !== undefined) {
      hasVisible = true;
      visible ||= target.visible;
    }
    if (target.selected !== undefined) {
      hasSelected = true;
      selected ||= target.selected;
    }
    if (Number.isFinite(target.weight)) {
      hasWeight = true;
      weight = Math.max(weight, Math.max(0, target.weight ?? 0));
    }
  }

  if (!selectedTarget) return null;
  const merged = { ...selectedTarget };
  if (hasVisible) merged.visible = visible;
  else delete merged.visible;
  if (hasSelected) merged.selected = selected;
  else delete merged.selected;
  if (hasWeight) merged.weight = weight;
  else delete merged.weight;
  return merged;
}
