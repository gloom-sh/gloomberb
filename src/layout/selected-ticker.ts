import { resolveTickerForPane } from "../core/state/app/layout";
import type { AppState } from "../core/state/app/types";
import { isPaneInLayout } from "./pane-manager";
import { findPaneInstance, type PaneInstanceConfig } from "../types/config";

/** Same single-cell mark a linked pane title uses. */
export const LINKED_TICKER_MARK = "\u29c9";

export interface SelectedLayoutTicker {
  rootInstanceId: string;
  symbol: string;
  /** Visible panes that show this symbol, including the root. */
  memberCount: number;
}

/**
 * The instrument the command prompt is offering. The focused pane's ticker
 * when it has one, otherwise the linked desk, so a command that needs a
 * ticker can use the symbol already on screen.
 */
export function commandPromptTicker(state: AppState): { symbol: string; rootInstanceId: string } | null {
  const selection = selectedLayoutTicker(state);
  if (!selection) return null;
  return { symbol: selection.symbol, rootInstanceId: selection.rootInstanceId };
}

/**
 * The ticker a layout is on. The focused pane's group wins. Otherwise the
 * largest group of two or more visible panes. A lone pane counts only while
 * it is focused, so a news pane does not hide a linked desk, and an unlinked
 * desk does not invent a group.
 */
export function selectedLayoutTicker(state: AppState): SelectedLayoutTicker | null {
  const groups = new Map<string, { symbol: string; count: number; order: number }>();
  state.config.layout.instances.forEach((instance, order) => {
    const rootId = tickerRootId(state, instance.instanceId);
    if (!rootId) return;
    const symbol = resolveTickerForPane(state, rootId);
    if (!symbol) return;
    const group = groups.get(rootId);
    if (group) group.count += 1;
    else groups.set(rootId, { symbol, count: 1, order });
  });

  const focusedRoot = state.focusedPaneId ? tickerRootId(state, state.focusedPaneId) : null;
  const focused = focusedRoot ? groups.get(focusedRoot) : undefined;
  if (focusedRoot && focused) {
    return { rootInstanceId: focusedRoot, symbol: focused.symbol, memberCount: focused.count };
  }

  let best: SelectedLayoutTicker & { order: number } | null = null;
  for (const [rootInstanceId, group] of groups) {
    if (group.count < 2) continue;
    if (
      !best
      || group.count > best.memberCount
      || (group.count === best.memberCount && group.order < best.order)
    ) {
      best = { rootInstanceId, symbol: group.symbol, memberCount: group.count, order: group.order };
    }
  }
  return best
    ? { rootInstanceId: best.rootInstanceId, symbol: best.symbol, memberCount: best.memberCount }
    : null;
}

/** The pane whose symbol the others follow. A cycle or a hidden pane has none. */
function tickerRootId(state: AppState, paneId: string, seen = new Set<string>()): string | null {
  if (seen.has(paneId)) return null;
  seen.add(paneId);
  const layout = state.config.layout;
  if (!isPaneInLayout(layout, paneId)) return null;
  const instance: PaneInstanceConfig | undefined = findPaneInstance(layout, paneId);
  if (!instance) return null;
  if (instance.binding?.kind === "follow") return tickerRootId(state, instance.binding.sourceInstanceId, seen);
  return resolveTickerForPane(state, paneId) ? paneId : null;
}
