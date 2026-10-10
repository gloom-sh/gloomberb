import { useCallback, type Dispatch } from "react";
import { formatAdvertisedChord, type ResolvedKeybindings } from "../../../../app/keybindings";
import { tf } from "../../../../i18n";
import {
  createSavedLayoutId,
  paneMoveBackTarget,
  paneNewLayoutBlock,
  type PaneMoveBackTarget,
  type PaneNewLayoutBlock,
} from "../../../../layout/pane-layout-move";
import type { PluginRegistry } from "../../../../plugins/registry";
import { resolveTickerForPane, type AppAction, type AppState } from "../../../../state/app/context";
import { findPaneInstance } from "../../../../types/config";
import type { ShortcutDisplayMode } from "../../../../utils/shortcut-labels";
import { getBasePaneDisplayTitle } from "../../pane/title";
import type { PaneMenuLayoutMove } from "../menu";

const BLOCK_MESSAGES: Partial<Record<PaneNewLayoutBlock, string>> = {
  "only-pane": "Already the only pane in this layout",
  "no-ticker": "Select a ticker in the list this pane follows first",
};

// The first move of a session says how to undo it; after that the layout tab is enough.
let moveBackHintShown = false;

interface UseShellPaneLayoutMovesOptions {
  closePaneMenu: () => void;
  dispatch: Dispatch<AppAction>;
  keybindings: ResolvedKeybindings;
  /** Leaves anything that shows this pane over the layout, such as fullscreen, before it moves. */
  leavePane: (paneId: string) => void;
  pluginRegistry: PluginRegistry;
  shortcutDisplayMode: ShortcutDisplayMode;
  stateRef: { current: AppState };
}

/**
 * Move to New Layout and Move Back for the shell's pane menu, its shortcut
 * and the command bar. The layout work is in `layout/pane-layout-move`.
 */
export function useShellPaneLayoutMoves({
  closePaneMenu,
  dispatch,
  keybindings,
  leavePane,
  pluginRegistry,
  shortcutDisplayMode,
  stateRef,
}: UseShellPaneLayoutMovesOptions) {
  const blockFor = useCallback((paneId: string): PaneNewLayoutBlock | null => {
    const state = stateRef.current;
    return paneNewLayoutBlock(state.config.layout, paneId, (instanceId) => resolveTickerForPane(state, instanceId));
  }, [stateRef]);

  const moveBackTargetFor = useCallback(
    (paneId: string): PaneMoveBackTarget | null => paneMoveBackTarget(stateRef.current.config, paneId),
    [stateRef],
  );

  const movePaneToNewLayout = useCallback((paneId: string): boolean => {
    const block = blockFor(paneId);
    if (block === "missing" || block === "detached") return false;
    const blockMessage = block ? BLOCK_MESSAGES[block] : undefined;
    if (blockMessage) {
      pluginRegistry.notify({ body: blockMessage, type: "info" });
      return true;
    }
    const state = stateRef.current;
    const instance = findPaneInstance(state.config.layout, paneId);
    if (!instance) return false;
    const def = pluginRegistry.panes.get(instance.paneId);
    const name = (def ? getBasePaneDisplayTitle(state, instance, def, pluginRegistry.panes) : instance.title)?.trim()
      || instance.paneId;
    closePaneMenu();
    leavePane(paneId);
    dispatch({ type: "MOVE_PANE_TO_NEW_LAYOUT", paneId, name, sourceLayoutId: createSavedLayoutId() });
    if (!moveBackHintShown) {
      moveBackHintShown = true;
      const shortcut = formatAdvertisedChord(keybindings, "pane-new-layout", shortcutDisplayMode);
      pluginRegistry.notify({
        body: shortcut
          ? tf("Moved to a layout of its own. {shortcut} moves it back.", { shortcut })
          : "Moved to a layout of its own. Move Back in its menu returns it.",
        type: "info",
      });
    }
    return true;
  }, [blockFor, closePaneMenu, dispatch, keybindings, leavePane, pluginRegistry, shortcutDisplayMode, stateRef]);

  const movePaneBack = useCallback((paneId: string): boolean => {
    if (!moveBackTargetFor(paneId)) return false;
    closePaneMenu();
    leavePane(paneId);
    dispatch({ type: "MOVE_PANE_BACK", paneId });
    return true;
  }, [closePaneMenu, dispatch, leavePane, moveBackTargetFor]);

  /** The shortcut: a pane alone in the layout it was moved to goes back, any other gets a layout of its own. */
  const togglePaneNewLayout = useCallback((paneId: string | null): boolean => {
    if (!paneId) return false;
    if (blockFor(paneId) === "only-pane" && movePaneBack(paneId)) return true;
    return movePaneToNewLayout(paneId);
  }, [blockFor, movePaneBack, movePaneToNewLayout]);

  /** What the pane menu offers: Move to New Layout unless the pane is alone, Move Back when it came from elsewhere. */
  const paneLayoutMoveMenu = useCallback((paneId: string): PaneMenuLayoutMove => {
    const block = blockFor(paneId);
    const back = moveBackTargetFor(paneId);
    return {
      ...(block === null || block === "no-ticker" ? { moveToNewLayout: () => { movePaneToNewLayout(paneId); } } : {}),
      ...(back ? { moveBack: { layoutName: back.name, onSelect: () => { movePaneBack(paneId); } } } : {}),
    };
  }, [blockFor, moveBackTargetFor, movePaneBack, movePaneToNewLayout]);

  return { movePaneBack, movePaneToNewLayout, paneLayoutMoveMenu, togglePaneNewLayout };
}
