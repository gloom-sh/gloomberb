// Only types and the layout model: the public share page bundles this module, and the pane
// manager and ticker navigation would bring the app (and its signed-in clients) in with it.
import {
  findPaneInstance,
  getPlacedPaneInstanceIds,
  TICKER_RESEARCH_PANE_ID,
  type LayoutConfig,
  type PaneInstanceConfig,
  type PaneUnlinkedFrom,
} from "../types/config";
import type { BrokerContractRef } from "../types/instrument";

const PANE_TITLE_MNEMONIC = /^([A-Z][A-Z0-9]{0,7})(?=\s|$)/;
/** One ticker key as a template writes it after the command: "AAPL", "BRK.B", "BTC-USD:CCC", "^SPX". */
export const TITLE_TICKER = /^[A-Z0-9^][A-Z0-9.^_/=-]*(?::[A-Z0-9._-]+)?$/;

/** The command a ticker template titled its pane with: "OMON" in "OMON AAPL". */
export function paneTitleMnemonic(title: string | undefined): string | null {
  return title?.trim().match(PANE_TITLE_MNEMONIC)?.[1] ?? null;
}

/**
 * The title a pin gives a follower: a pane linked from its menu keeps only its command ("OMON"),
 * and one linked some other way still names the ticker it opened on ("OMON AAPL"); both name the
 * pinned ticker ("OMON MSFT"). Any other title is the user's or the pane's own and stays. Ticker
 * search changing a pane's ticker (`retargetTickerPane`) names the new one the same way.
 */
export function pinnedTitle(instance: PaneInstanceConfig, pinned: string): string | null {
  if (instance.paneId === TICKER_RESEARCH_PANE_ID) return null;
  const title = instance.title?.trim();
  const mnemonic = paneTitleMnemonic(title);
  if (!title || !mnemonic) return null;
  const rest = title.slice(mnemonic.length).trim();
  return !rest || TITLE_TICKER.test(rest) ? `${mnemonic} ${pinned}` : null;
}

/** True when `fromInstanceId`'s follow chain reaches `targetInstanceId`. */
export function followBindingReaches(
  layout: LayoutConfig,
  fromInstanceId: string,
  targetInstanceId: string,
  seen = new Set<string>(),
): boolean {
  if (seen.has(fromInstanceId)) return false;
  seen.add(fromInstanceId);
  const instance = findPaneInstance(layout, fromInstanceId);
  if (instance?.binding?.kind !== "follow") return false;
  const next = instance.binding.sourceInstanceId;
  return next === targetInstanceId || followBindingReaches(layout, next, targetInstanceId, seen);
}

/** Who cut a follower's link, and the kind of pane it followed (`PaneUnlinkedFrom`). */
interface PaneUnlink {
  /** The app, not the user: the source closed or left the layout, or another research pane took it. */
  auto?: boolean;
  sourcePaneId?: string | null;
}

/** What a pin that cuts `instance`'s link records of it; none when it follows nothing. */
function unlinkedFrom(instance: PaneInstanceConfig, unlink: PaneUnlink): PaneUnlinkedFrom | undefined {
  if (instance.binding?.kind !== "follow") return undefined;
  return {
    instanceId: instance.binding.sourceInstanceId,
    ...(unlink.sourcePaneId ? { paneId: unlink.sourcePaneId } : {}),
    ...(unlink.auto ? { auto: true as const } : {}),
  };
}

/**
 * What a ticker the user picks for `instance` (ticker search, a ticker link in it) records: the
 * link that takes it off, or the one an earlier pin cut, now the user's own pin. A pane the app
 * pinned stops following its source back once the user has chosen what it shows.
 */
export function userUnlinkedFrom(instance: PaneInstanceConfig, layout: LayoutConfig): PaneUnlinkedFrom | undefined {
  if (instance.binding?.kind === "follow") {
    return unlinkedFrom(instance, { sourcePaneId: findPaneInstance(layout, instance.binding.sourceInstanceId)?.paneId });
  }
  const earlier = instance.unlinkedFrom;
  return earlier && { instanceId: earlier.instanceId, ...(earlier.paneId ? { paneId: earlier.paneId } : {}) };
}

/** A follower its link left, which its title marks until it follows a pane again. */
export function isUnlinkedFollower(instance: PaneInstanceConfig): boolean {
  return !!instance.unlinkedFrom && instance.binding?.kind !== "follow";
}

/** `instance` following `sourceInstanceId`, with no record of an older link. */
export function linkFollower(instance: PaneInstanceConfig, sourceInstanceId: string): PaneInstanceConfig {
  const { unlinkedFrom: _unlinkedFrom, ...rest } = instance;
  return { ...rest, binding: { kind: "follow", sourceInstanceId } };
}

/**
 * Pins a follower on the symbol it shows (unlink, a closed source, a single-pane share), or
 * unbinds it when nothing resolved, retitled to name that symbol. Ticker Research computes its
 * own title and is never retitled. `unlink` records the link it cuts (`PaneUnlinkedFrom`); a
 * shared pane leaves without one.
 */
export function pinFollowingPane(
  instance: PaneInstanceConfig,
  symbol: string | null | undefined,
  instrument?: BrokerContractRef | null,
  unlink?: PaneUnlink,
): PaneInstanceConfig {
  const left = unlink ? unlinkedFrom(instance, unlink) : undefined;
  const cut = left ? { ...instance, unlinkedFrom: left } : instance;
  const pinned = symbol?.trim();
  if (!pinned) return { ...cut, binding: { kind: "none" } };
  const title = pinnedTitle(instance, pinned);
  return {
    ...cut,
    // Only a broker contract is worth keeping: a derived public `null` would stop the pinned pane
    // matching `T AAPL` reuse, which tells null and unspecified contracts apart.
    binding: { kind: "fixed", symbol: pinned, ...(instrument ? { instrument } : {}) },
    ...(title ? { title } : {}),
  };
}

/**
 * `normalizePaneLayout`'s `pinOrphan` for the app: a follower whose source is gone is pinned
 * by the app, naming the kind of pane it followed from `previous`, the layout before the change.
 */
export function pinOrphanedFollower(
  previous: LayoutConfig,
): (instance: PaneInstanceConfig, symbol: string | null) => PaneInstanceConfig {
  return (instance, symbol) => {
    const sourceId = instance.binding?.kind === "follow" ? instance.binding.sourceInstanceId : null;
    const sourcePaneId = sourceId ? findPaneInstance(previous, sourceId)?.paneId : undefined;
    return pinFollowingPane(instance, symbol, undefined, { auto: true, sourcePaneId });
  };
}

/**
 * A research pane the app pinned (`PaneUnlinkedFrom.auto`) follows again once a source is free
 * for it in `layout`: the pane it followed, back with no research pane following it (the one
 * that took it closed, or moved on), or, while that pane is gone, one of its kind that `layout`
 * adds to `previous` with none (a portfolio closed and opened again). A list that was already
 * there when the link was cut does not take the pane away from its ticker. A pane the user
 * unlinked, or gave a ticker of its own, stays pinned.
 */
export function relinkPinnedResearchPanes(layout: LayoutConfig, previous: LayoutConfig): LayoutConfig {
  if (!layout.instances.some((pane) => pane.unlinkedFrom?.auto)) return layout;
  // Relinking moves no pane, so what is placed stays as `layout` has it.
  const placed = new Set(getPlacedPaneInstanceIds(layout));
  let next = layout;
  for (const pane of layout.instances) {
    const from = pane.unlinkedFrom;
    if (
      pane.paneId !== TICKER_RESEARCH_PANE_ID
      || !from?.auto
      || pane.binding?.kind === "follow"
      || !placed.has(pane.instanceId)
    ) continue;
    const hasResearch = (sourceId: string) => next.instances.some((instance) => (
      instance.paneId === TICKER_RESEARCH_PANE_ID
      && instance.binding?.kind === "follow"
      && instance.binding.sourceInstanceId === sourceId
      && placed.has(instance.instanceId)
    ));
    const free = (candidate: PaneInstanceConfig) => (
      candidate.instanceId !== pane.instanceId
      && placed.has(candidate.instanceId)
      && !hasResearch(candidate.instanceId)
      && !followBindingReaches(next, candidate.instanceId, pane.instanceId)
    );
    const original = findPaneInstance(next, from.instanceId);
    const source = original
      ? (free(original) ? original : undefined)
      : from.paneId
        ? next.instances.find((candidate) => (
          candidate.paneId === from.paneId
          && !findPaneInstance(previous, candidate.instanceId)
          && free(candidate)
        ))
        : undefined;
    if (!source) continue;
    next = {
      ...next,
      instances: next.instances.map((instance) => (
        instance.instanceId === pane.instanceId ? linkFollower(instance, source.instanceId) : instance
      )),
    };
  }
  return next;
}
