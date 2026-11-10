import type { LayoutConfig } from "../../types/config";
import { getDockedPaneIds } from "./dock-tree";
import { removePane } from "./layout-state";

/**
 * Windows the app opens over a layout to work on layouts, not part of one:
 * the Layouts browser (LAY). A layout is never saved with one, so it reopens
 * without it, and its windows are counted without one.
 */
const TRANSIENT_PANE_IDS: ReadonlySet<string> = new Set(["layout-marketplace"]);

/** Whether a pane is a window no layout keeps (TRANSIENT_PANE_IDS): opened over a layout, never saved with one. */
export function isTransientPane(paneId: string): boolean {
  return TRANSIENT_PANE_IDS.has(paneId);
}

const withoutTransient = new WeakMap<LayoutConfig, LayoutConfig>();

/**
 * The layout without its transient windows (TRANSIENT_PANE_IDS): the same
 * object when it has none, and the same result each time for one layout, so
 * a layout saved on every change stays one value while it does not change.
 */
export function withoutTransientPanes(layout: LayoutConfig): LayoutConfig {
  if (!layout.instances.some((instance) => isTransientPane(instance.paneId))) return layout;
  const cached = withoutTransient.get(layout);
  if (cached) return cached;
  const result = layout.instances
    .filter((instance) => isTransientPane(instance.paneId))
    .reduce((current, instance) => removePane(current, instance.instanceId), layout);
  withoutTransient.set(layout, result);
  return result;
}

/** Where a layout's windows are: docked, floating over it, or in windows of their own. */
interface LayoutWindowCounts {
  docked: number;
  floating: number;
  detached: number;
}

/**
 * How many windows a layout has in each place, its transient ones left out:
 * one count for the Layouts browser ("4 docked · 2 floating") and `gloom
 * layout`, so the two never disagree.
 */
export function layoutWindowCounts(layout: LayoutConfig): LayoutWindowCounts {
  const saved = withoutTransientPanes(layout);
  const instanceIds = new Set(saved.instances.map((instance) => instance.instanceId));
  const placed = (ids: readonly string[]) => ids.filter((id) => instanceIds.has(id)).length;
  return {
    docked: placed(getDockedPaneIds(saved)),
    floating: placed(saved.floating.map((entry) => entry.instanceId)),
    detached: placed((saved.detached ?? []).map((entry) => entry.instanceId)),
  };
}
