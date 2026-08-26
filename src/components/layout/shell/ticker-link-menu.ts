import { updatePaneInstance } from "../../../pane-settings";
import { listVisibleTickerSourcePanes } from "../../../plugins/ticker-navigation";
import { resolveTickerForPane, type AppState } from "../../../state/app/context";
import {
  TICKER_RESEARCH_PANE_ID,
  type LayoutConfig,
  type PaneInstanceConfig,
} from "../../../types/config";
import type { ContextMenuItem } from "../../../types/context-menu";
import type { PaneDef } from "../../../types/plugin";
import { getPaneDisplayTitle } from "../pane/title";

/**
 * Flat link controls for a Ticker Research pane: one entry per visible ticker source, plus an
 * unlink entry that pins the pane on the symbol it currently shows.
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
  state: Pick<AppState, "config" | "paneState">;
  persistLayout: (nextLayout: LayoutConfig) => void;
}): ContextMenuItem[] {
  if (instance.paneId !== TICKER_RESEARCH_PANE_ID) return [];

  const sourceInstanceId = instance.binding?.kind === "follow" ? instance.binding.sourceInstanceId : null;
  const rebind = (binding: PaneInstanceConfig["binding"]) => {
    persistLayout(updatePaneInstance(layout, instance.instanceId, (current) => ({ ...current, binding })));
  };
  const linkToSource = (nextSourceId: string) => {
    persistLayout({
      ...layout,
      instances: layout.instances.map((current) => {
        if (current.instanceId === instance.instanceId) {
          return { ...current, binding: { kind: "follow" as const, sourceInstanceId: nextSourceId } };
        }
        if (
          current.paneId !== TICKER_RESEARCH_PANE_ID
          || current.binding?.kind !== "follow"
          || current.binding.sourceInstanceId !== nextSourceId
        ) return current;

        const symbol = resolveTickerForPane(state as AppState, current.instanceId);
        return { ...current, binding: symbol ? { kind: "fixed" as const, symbol } : { kind: "none" as const } };
      }),
    });
  };

  return listVisibleTickerSourcePanes(layout, panes).flatMap((source): ContextMenuItem[] => {
    const paneDef = panes.get(source.paneId);
    if (!paneDef) return [];
    const title = getPaneDisplayTitle(state, source, paneDef, panes);

    if (source.instanceId !== sourceInstanceId) {
      return [{
        id: `link:${source.instanceId}`,
        label: `Link to ${title}`,
        onSelect: () => linkToSource(source.instanceId),
      }];
    }

    // Unlinking keeps the pane alive, so it only works once a symbol has resolved.
    const symbol = resolveTickerForPane(state as AppState, instance.instanceId);
    return symbol
      ? [{
        id: `unlink:${source.instanceId}`,
        label: `Unlink from ${title}`,
        onSelect: () => rebind({ kind: "fixed", symbol }),
      }]
      : [];
  });
}
