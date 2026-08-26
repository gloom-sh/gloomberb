import {
  findPaneInstance,
  normalizePaneId,
  TICKER_RESEARCH_PANE_ID,
  type LayoutConfig,
  type PaneInstanceConfig,
} from "../types/config";
import type { PaneDef } from "../types/plugin";
import { isPaneInLayout } from "./pane-manager";

/** Panes that publish a cursor symbol other panes can follow (`PaneDef.tickerSource`). */
export function listVisibleTickerSourcePanes(
  layout: LayoutConfig,
  panes: ReadonlyMap<string, PaneDef>,
): PaneInstanceConfig[] {
  return layout.instances.filter((instance) => (
    panes.get(instance.paneId)?.tickerSource === true
    && isPaneInLayout(layout, instance.instanceId)
  ));
}

/** The visible Ticker Research pane that follows `sourceInstanceId`, if any. */
export function findTickerResearchFollower(
  layout: LayoutConfig,
  sourceInstanceId: string | null | undefined,
): PaneInstanceConfig | null {
  if (!sourceInstanceId) return null;
  return layout.instances.find((instance) =>
    instance.paneId === TICKER_RESEARCH_PANE_ID
    && instance.binding?.kind === "follow"
    && instance.binding.sourceInstanceId === sourceInstanceId
    && isPaneInLayout(layout, instance.instanceId)
  ) ?? null;
}

/**
 * Enter opens the follower already bound to the source pane; Shift+Enter (`newPane`) and sources
 * without a follower fall back to opening a ticker pane.
 */
export function resolveTickerActivation(
  layout: LayoutConfig,
  sourcePaneId: string | null | undefined,
  options?: { newPane?: boolean },
): { kind: "focus"; paneId: string } | { kind: "open" } {
  if (options?.newPane) return { kind: "open" };
  const follower = findTickerResearchFollower(layout, sourcePaneId);
  return follower ? { kind: "focus", paneId: follower.instanceId } : { kind: "open" };
}

export function resolveTickerNavigationReplacementPane(
  layout: LayoutConfig,
  sourcePaneId: string | null,
): PaneInstanceConfig | null {
  const sourceInstance = sourcePaneId ? findPaneInstance(layout, sourcePaneId) : null;
  return sourceInstance?.paneId === TICKER_RESEARCH_PANE_ID && isPaneInLayout(layout, sourceInstance.instanceId)
    ? sourceInstance
    : null;
}

export function findFixedTickerPaneForSymbol(
  layout: LayoutConfig,
  paneId: string,
  symbol: string,
): PaneInstanceConfig | null {
  return layout.instances.find((instance) =>
    instance.paneId === normalizePaneId(paneId)
    && instance.binding?.kind === "fixed"
    && instance.binding.symbol === symbol
    && isPaneInLayout(layout, instance.instanceId)
  ) ?? null;
}

export function shouldFocusTickerNavigationTarget({
  sourcePaneId,
  currentFocusedPaneId,
  targetPaneId,
}: {
  sourcePaneId: string | null;
  currentFocusedPaneId: string | null;
  targetPaneId: string | null;
}): boolean {
  if (!sourcePaneId) return true;
  return currentFocusedPaneId === sourcePaneId || currentFocusedPaneId === targetPaneId;
}
