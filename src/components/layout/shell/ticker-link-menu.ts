import { tf } from "../../../i18n";
import { updatePaneInstance } from "../../../pane-settings";
import { canFollowTickerSource, listVisibleTickerSourcePanes } from "../../../layout/ticker-navigation";
import { resolveTickerForPane, type AppState } from "../../../state/app/context";
import { resolveInstrumentForPane } from "../../../core/state/app/instrument";
import { paneTitleMnemonic, pinFollowingPane } from "../../../layout/pane-follow";
import {
  TICKER_RESEARCH_PANE_ID,
  type LayoutConfig,
  type PaneInstanceConfig,
} from "../../../types/config";
import type { ContextMenuItem } from "../../../types/context-menu";
import type { PaneDef } from "../../../types/plugin";
import { getBasePaneDisplayTitle } from "../pane/title";

/**
 * Flat link controls for a pane that shows one ticker (Ticker Research, or a pane that sets
 * `PaneDef.tickerFollower`): one "Link to" entry per visible ticker source, plus an unlink entry
 * that pins the pane on the symbol it currently shows. Only list panes and scanners are targets;
 * a pane following anything else (a desk's OMON following OVDV) gets no rows.
 */
export function tickerLinkMenuItems({
  instance,
  layout,
  panes,
  state,
  persistLayout,
}: {
  instance: PaneInstanceConfig;
  layout: LayoutConfig;
  panes: ReadonlyMap<string, PaneDef>;
  state: Pick<AppState, "config" | "paneState" | "tickers">;
  persistLayout: (nextLayout: LayoutConfig) => void;
}): ContextMenuItem[] {
  const research = instance.paneId === TICKER_RESEARCH_PANE_ID;
  // A chart that gained a comparison while linked can still be unlinked, but not linked again.
  const followerType = research || !!panes.get(instance.paneId)?.tickerFollower;
  if (!followerType) return [];
  const linkable = research || canFollowTickerSource(instance, panes);

  const sourceInstanceId = instance.binding?.kind === "follow" ? instance.binding.sourceInstanceId : null;
  const unlink = (symbol: string) => {
    const contract = resolveInstrumentForPane(state, instance.instanceId)?.instrument;
    persistLayout(updatePaneInstance(layout, instance.instanceId, (current) => {
      const mnemonic = research ? null : paneTitleMnemonic(current.title);
      return pinFollowingPane(mnemonic ? { ...current, title: mnemonic } : current, symbol, contract);
    }));
  };
  const linkToSource = (nextSourceId: string) => {
    persistLayout({
      ...layout,
      instances: layout.instances.map((current) => {
        if (current.instanceId === instance.instanceId) {
          // The stored title drops its ticker ("OMON AAPL" to "OMON"); the header adds the live one.
          const mnemonic = research ? null : paneTitleMnemonic(current.title);
          return {
            ...current,
            ...(mnemonic ? { title: mnemonic } : {}),
            binding: { kind: "follow" as const, sourceInstanceId: nextSourceId },
          };
        }
        // Ticker Research keeps one follower per source, so Enter on a source row has one target.
        // Any number of other panes may follow the same source.
        if (
          !research
          || current.paneId !== TICKER_RESEARCH_PANE_ID
          || current.binding?.kind !== "follow"
          || current.binding.sourceInstanceId !== nextSourceId
        ) return current;
        return pinFollowingPane(current, resolveTickerForPane(state as AppState, current.instanceId));
      }),
    });
  };

  return listVisibleTickerSourcePanes(layout, panes).flatMap((source): ContextMenuItem[] => {
    const paneDef = panes.get(source.paneId);
    if (!paneDef || source.instanceId === instance.instanceId) return [];
    const title = getBasePaneDisplayTitle(state, source, paneDef);

    if (source.instanceId !== sourceInstanceId) {
      return linkable
        ? [{
          id: `link:${source.instanceId}`,
          label: tf("Link to {source}", { source: title }),
          onSelect: () => linkToSource(source.instanceId),
        }]
        : [];
    }

    // Unlinking keeps the pane alive, so it only works once a symbol has resolved: pinning a
    // ticker pane to nothing would let the next layout pass remove it.
    const symbol = resolveTickerForPane(state as AppState, instance.instanceId);
    return symbol
      ? [{
        id: `unlink:${source.instanceId}`,
        label: tf("Unlink from {source}", { source: title }),
        onSelect: () => unlink(symbol),
      }]
      : [];
  });
}
