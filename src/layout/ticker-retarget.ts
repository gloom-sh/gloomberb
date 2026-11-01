import {
  findPaneInstance,
  TICKER_RESEARCH_PANE_ID,
  type LayoutConfig,
  type PaneBinding,
  type PaneInstanceConfig,
} from "../types/config";
import type { BrokerContractRef, TickerListingRef } from "../types/instrument";
import type { PaneDef } from "../types/plugin";
import { tickerInstrumentLabel } from "../tickers/instrument-label";
import { pinnedTitle } from "./pane-follow";
import { isPaneInLayout } from "./pane-manager";
import { isTickerLinkPeer } from "./ticker-navigation";

/*
 * Ticker search (the backtick, or a click on the ticker in a pane's header) changes what the
 * focused pane shows rather than opening another pane, whenever that pane shows one ticker:
 * Ticker Research, or a pane flagged `tickerFollower` (OMON, G of one security, FA).
 *
 * - A pane on a fixed ticker changes to the new one, and every pane linked to it moves along.
 * - A linked pane changes its source instead, up the chain of single-ticker panes it follows, so
 *   the linked group moves together: OPX on the Options desk changes OMON, and OPX, OVDV and HIVG
 *   follow it.
 * - A group whose top pane follows a watchlist, portfolio or scanner is pinned on the new ticker
 *   and leaves the list. A search never edits the user's list or moves its cursor, and the list
 *   may not hold the ticker at all; the pane menu's "Link to" puts the group back on the list.
 *
 * A pane that shows no ticker (a list, a market board, a comparison chart, INS without one) has
 * no target here, and its search opens a ticker pane as it always has. Shift+Enter opens a new
 * pane from any pane.
 */

/** The pane whose ticker search changes when `paneId` has the focus, or null to open a pane instead. */
export function resolveTickerRetargetPane(
  layout: LayoutConfig,
  paneId: string | null | undefined,
  panes: ReadonlyMap<string, PaneDef>,
): PaneInstanceConfig | null {
  const focused = paneId ? findPaneInstance(layout, paneId) : undefined;
  if (!focused || !isPaneInLayout(layout, focused.instanceId) || !isTickerLinkPeer(focused, panes)) return null;
  let root = focused;
  const seen = new Set([root.instanceId]);
  while (root.binding?.kind === "follow") {
    const source = findPaneInstance(layout, root.binding.sourceInstanceId);
    if (!source || seen.has(source.instanceId) || !isTickerLinkPeer(source, panes)) break;
    seen.add(source.instanceId);
    root = source;
  }
  // Unbound, a pane other than Ticker Research shows no ticker (INS alone is the market's buying).
  const unbound = !root.binding || root.binding.kind === "none";
  if (unbound && root.paneId !== TICKER_RESEARCH_PANE_ID) return null;
  return root;
}

export interface TickerRetargetSelection {
  instrument?: BrokerContractRef | null;
  listing?: TickerListingRef;
}

/**
 * The layout with `target` (from `resolveTickerRetargetPane`) pinned on `symbol`. Its title
 * names the new ticker where it named the old one, and a pane that keeps its ticker elsewhere
 * (a chart's series) moves it through `PaneDef.retargetTicker`.
 */
export function retargetTickerPane(
  layout: LayoutConfig,
  target: PaneInstanceConfig,
  symbol: string,
  options: TickerRetargetSelection & { previous: string | null; paneDef?: PaneDef },
): LayoutConfig {
  const { instrument, listing, previous, paneDef } = options;
  const binding: PaneBinding = {
    kind: "fixed",
    symbol,
    ...(instrument !== undefined ? { instrument } : {}),
    ...(listing ? { listing } : {}),
  };
  const research = target.paneId === TICKER_RESEARCH_PANE_ID;
  const title = research ? tickerInstrumentLabel(symbol, instrument) : pinnedTitle(target, symbol);
  const pinned: PaneInstanceConfig = { ...target, binding, ...(title ? { title } : {}) };
  const next = paneDef?.retargetTicker?.(pinned, symbol, previous) ?? pinned;
  return {
    ...layout,
    instances: layout.instances.map((instance) => (instance.instanceId === target.instanceId ? next : instance)),
  };
}
