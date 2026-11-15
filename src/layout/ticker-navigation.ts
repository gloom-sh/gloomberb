import {
  findPaneInstance,
  normalizePaneId,
  TICKER_RESEARCH_PANE_ID,
  type LayoutConfig,
  type PaneInstanceConfig,
} from "../types/config";
import type { PaneDef } from "../types/plugin";
import { isPaneInLayout } from "./pane-manager";
import type { BrokerContractRef } from "../types/instrument";
import { scopedBrokerContractIdentityKey } from "../utils/instrument-identity";

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

/**
 * Whether the pane menu may link this pane to another pane's ticker (`PaneDef.tickerFollower`).
 * A source never follows: its own cursor symbol would win over the binding.
 */
export function canFollowTickerSource(
  instance: PaneInstanceConfig,
  panes: ReadonlyMap<string, PaneDef>,
): boolean {
  const def = panes.get(instance.paneId);
  if (!def || def.tickerSource) return false;
  return typeof def.tickerFollower === "function" ? def.tickerFollower(instance) : def.tickerFollower === true;
}

/**
 * A single-ticker pane other panes can follow. Lists and scanners stay sources; Ticker Research
 * follows the same rule as any pane flagged `tickerFollower`.
 */
export function isTickerLinkPeer(
  instance: PaneInstanceConfig,
  panes: ReadonlyMap<string, PaneDef>,
): boolean {
  return instance.paneId === TICKER_RESEARCH_PANE_ID || canFollowTickerSource(instance, panes);
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
 * Enter focuses the follower already bound to the source pane. A source without one opens the
 * ticker in a research pane, reusing a pinned one rather than stacking another: the one the app
 * unlinked (`PaneUnlinkedFrom.auto`), else the only one the layout has. Shift+Enter (`newPane`)
 * opens a new pane.
 */
export function resolveTickerActivation(
  layout: LayoutConfig,
  sourcePaneId: string | null | undefined,
  options?: { newPane?: boolean },
): { kind: "focus"; paneId: string } | { kind: "open"; reusePaneId?: string } {
  if (options?.newPane) return { kind: "open" };
  const follower = findTickerResearchFollower(layout, sourcePaneId);
  if (follower) return { kind: "focus", paneId: follower.instanceId };
  const pinned = layout.instances.filter((instance) => (
    instance.paneId === TICKER_RESEARCH_PANE_ID
    && instance.binding?.kind === "fixed"
    && isPaneInLayout(layout, instance.instanceId)
  ));
  const reuse = pinned.find((instance) => instance.unlinkedFrom?.auto) ?? (pinned.length === 1 ? pinned[0] : undefined);
  return reuse ? { kind: "open", reusePaneId: reuse.instanceId } : { kind: "open" };
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
  instrument?: BrokerContractRef | null,
): PaneInstanceConfig | null {
  return layout.instances.find((instance) =>
    instance.paneId === normalizePaneId(paneId)
    && instance.binding?.kind === "fixed"
    && instance.binding.symbol === symbol
    && (instance.binding.instrument === undefined ? "unspecified" : instance.binding.instrument === null ? "public" : scopedBrokerContractIdentityKey(instance.binding.instrument))
      === (instrument === undefined ? "unspecified" : instrument === null ? "public" : scopedBrokerContractIdentityKey(instrument))
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
