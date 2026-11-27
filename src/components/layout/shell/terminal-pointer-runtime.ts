import { useCallback, type Dispatch, type SetStateAction } from "react";
import {
  floatingStacks,
  type DockDividerLayout,
  type DockLeafLayout,
  type FloatingRect,
  type LayoutBounds,
  type ResolvedPane,
} from "../../../layout/pane-manager";
import {
  constrainFloatingRectToBounds,
  pointInRect,
  resolveHeaderHitAreas,
} from "./drag";
import type { ActionMenuState } from "./action-menu-overlay";
import type {
  ShellDragRuntimeState,
  ShellMouseEvent,
  VisibleFloatingPane,
} from "./drag/runtime";
import type { WindowEditState } from "../window-edit/mode";
import {
  paneHeaderTitleStart,
  terminalStackTabSpans,
  terminalHeaderTitleWidth,
  terminalHeaderTrailingWidth,
  type PaneHeaderQuickSetting,
} from "../pane/header";
import { displayWidth } from "../../../utils/format";

interface UseShellTerminalPointerRuntimeOptions {
  appHeaderHeight: number;
  closePaneMenu: () => void;
  contentHeight: number;
  dockDividerLayouts: DockDividerLayout[];
  dockLeafLayouts: DockLeafLayout[];
  dragRuntime: ShellDragRuntimeState;
  focusPane: (paneId: string) => void;
  focusedPaneId: string | null;
  handleActiveDrag: (event: ShellMouseEvent) => void;
  handleFloatingClose: (paneId: string) => void;
  restoreFullscreen: () => void;
  menuState: ActionMenuState | null;
  openPaneMenu: (
    paneId: string,
    rect: LayoutBounds,
    event?: { preventDefault?: () => void; stopPropagation?: () => void },
  ) => void;
  /** The header's `?`: the pane's entry in DOCS. */
  openPaneDocs: (paneId: string) => void;
  getPaneTitle: (pane: ResolvedPane) => string;
  /** A pane's quick settings, which take room from a stack's tabs in its header. */
  getPaneQuickSettings: (paneId: string) => ReadonlyArray<Pick<PaneHeaderQuickSetting, "icon">>;
  paneMap: Map<string, ResolvedPane>;
  selectWindowModePane: (paneId: string) => void;
  setHoveredMenuItemId: Dispatch<SetStateAction<string | null>>;
  setMenuState: Dispatch<SetStateAction<ActionMenuState | null>>;
  transientFocusActive: boolean;
  visibleFloatingPanes: VisibleFloatingPane[];
  /** The layout's floating windows in its order: a floating stack's tabs. */
  floatingOrder: readonly { instanceId: string }[];
  width: number;
  windowMode: WindowEditState | null;
}

function getVisibleFloatingRect(
  visibleRect: FloatingRect,
  paneId: string,
  dragFloatingRect: { paneId: string; rect: FloatingRect } | null,
  width: number,
  contentHeight: number,
): FloatingRect {
  return dragFloatingRect?.paneId === paneId
    ? constrainFloatingRectToBounds(dragFloatingRect.rect, width, contentHeight)
    : visibleRect;
}

/**
 * The tab of a stack whose title is `x` cells into its header's title, laid
 * out as the header lays it out (`terminalStackTabSpans`) in a header `width` wide
 * that shows `shown`.
 */
function stackTabAt(
  stack: readonly string[],
  shown: string,
  x: number,
  header: { width: number; framed: boolean; corner: boolean },
  paneMap: Map<string, ResolvedPane>,
  getPaneTitle: (pane: ResolvedPane) => string,
  getPaneQuickSettings: (paneId: string) => ReadonlyArray<Pick<PaneHeaderQuickSetting, "icon">>,
): string | null {
  const titles = stack.map((id) => {
    const pane = paneMap.get(id);
    return pane ? getPaneTitle(pane) : id;
  });
  const trailing = terminalHeaderTrailingWidth(getPaneQuickSettings(shown), paneMap.get(shown)?.instance.locked === true, true);
  const titleWidth = terminalHeaderTitleWidth(header.width, { framed: header.framed, corner: header.corner, trailing });
  const span = terminalStackTabSpans(titles, stack.indexOf(shown), titleWidth)
    .find((candidate) => x >= candidate.start && x < candidate.start + displayWidth(candidate.text));
  return span ? stack[span.index]! : null;
}

function sortedFloatingPanes(visibleFloatingPanes: VisibleFloatingPane[]): VisibleFloatingPane[] {
  return [...visibleFloatingPanes].sort((a, b) => (b.pane.floating?.zIndex ?? 50) - (a.pane.floating?.zIndex ?? 50));
}

function consumeEvent(event: ShellMouseEvent): void {
  event.stopPropagation();
  event.preventDefault();
}

export function useShellTerminalPointerRuntime({
  appHeaderHeight,
  closePaneMenu,
  contentHeight,
  dockDividerLayouts,
  dockLeafLayouts,
  dragRuntime,
  focusPane,
  focusedPaneId,
  handleActiveDrag,
  handleFloatingClose,
  restoreFullscreen,
  menuState,
  openPaneMenu,
  openPaneDocs,
  getPaneTitle,
  getPaneQuickSettings,
  paneMap,
  selectWindowModePane,
  setHoveredMenuItemId,
  setMenuState,
  transientFocusActive,
  visibleFloatingPanes,
  floatingOrder,
  width,
  windowMode,
}: UseShellTerminalPointerRuntimeOptions) {
  const {
    live,
    startDrag,
    updateDividerPreview,
    updateDragFloatingRect,
  } = dragRuntime;

  return useCallback((event: ShellMouseEvent) => {
    const shellY = event.y - appHeaderHeight;
    const preciseX = event.preciseX ?? event.x;
    const preciseShellY = (event.preciseY ?? event.y) - appHeaderHeight;
    if (shellY < 0) return;

    const beginFloatResize = (paneId: string, rect: FloatingRect) => {
      const origRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      startDrag({ type: "float-resize", paneId, startX: preciseX, startY: preciseShellY, origRect });
      updateDragFloatingRect({ paneId, rect: origRect });
    };

    const tryDividerDrag = (): boolean => {
      for (const divider of dockDividerLayouts) {
        if (!pointInRect(divider.rect, event.x, shellY)) continue;
        startDrag({
          type: "divider",
          path: divider.path,
          axis: divider.axis,
          startX: preciseX,
          startY: preciseShellY,
          startRatio: divider.ratio,
          bounds: divider.bounds,
        });
        updateDividerPreview({ pathKey: divider.path.join("."), rect: divider.rect, ratio: divider.ratio });
        consumeEvent(event);
        return true;
      }
      return false;
    };

    const handleHeaderDown = (
      paneId: string,
      rect: LayoutBounds,
      relativeX: number,
      floating: boolean,
      stack: readonly string[] | undefined,
    ) => {
      const isFocused = focusedPaneId === paneId;
      const headerAreas = resolveHeaderHitAreas(rect.width, {
        floating,
        focused: isFocused,
        fullscreen: transientFocusActive,
      });
      if (event.button === 2) {
        openPaneMenu(paneId, rect, event);
        return;
      }
      if ((floating || transientFocusActive) && headerAreas.closeStart != null && relativeX >= headerAreas.closeStart && relativeX < rect.width) {
        if (transientFocusActive) restoreFullscreen();
        else handleFloatingClose(paneId);
        consumeEvent(event);
        return;
      }
      if (headerAreas.actionStart != null && relativeX >= headerAreas.actionStart
        && (headerAreas.closeStart == null || relativeX < headerAreas.closeStart)) {
        openPaneMenu(paneId, rect, event);
        consumeEvent(event);
        return;
      }
      if (headerAreas.helpStart != null && headerAreas.actionStart != null
        && relativeX >= headerAreas.helpStart && relativeX < headerAreas.actionStart) {
        openPaneDocs(paneId);
        consumeEvent(event);
        return;
      }
      if (transientFocusActive) {
        consumeEvent(event);
        return;
      }
      const framed = floating || isFocused;
      const tabId = stack
        ? stackTabAt(stack, paneId, relativeX - paneHeaderTitleStart(framed), {
          width: rect.width,
          framed,
          corner: floating,
        }, paneMap, getPaneTitle, getPaneQuickSettings)
        : null;
      const origRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      startDrag({
        type: "pane-drag",
        paneId: tabId ?? paneId,
        mode: floating ? (tabId ? "tab" : "floating") : "docked",
        startX: preciseX,
        startY: preciseShellY,
        origRect,
      });
      if (floating && !tabId) updateDragFloatingRect({ paneId, rect: origRect });
      consumeEvent(event);
    };

    if (windowMode) {
      if (event.type !== "down") {
        handleActiveDrag(event);
        consumeEvent(event);
        return;
      }
      if (menuState) closePaneMenu();

      for (const { pane, rect: visibleRect } of sortedFloatingPanes(visibleFloatingPanes)) {
        const paneId = pane.instance.instanceId;
        const rect = getVisibleFloatingRect(visibleRect, paneId, live.get().floating, width, contentHeight);
        if (!pointInRect(rect, event.x, shellY)) continue;
        selectWindowModePane(paneId);
        if (event.x - rect.x >= rect.width - 2 && shellY - rect.y >= rect.height - 1) {
          beginFloatResize(paneId, rect);
        }
        consumeEvent(event);
        return;
      }

      if (!transientFocusActive && tryDividerDrag()) return;

      for (const leaf of dockLeafLayouts) {
        if (!pointInRect(leaf.rect, event.x, shellY)) continue;
        selectWindowModePane(leaf.instanceId);
        consumeEvent(event);
        return;
      }

      consumeEvent(event);
      return;
    }

    if (event.type === "down") {
      if (menuState) {
        setMenuState(null);
        setHoveredMenuItemId(null);
      }

      for (const { pane, rect: visibleRect } of sortedFloatingPanes(visibleFloatingPanes)) {
        const paneId = pane.instance.instanceId;
        const rect = getVisibleFloatingRect(visibleRect, paneId, live.get().floating, width, contentHeight);
        if (!pointInRect(rect, event.x, shellY)) continue;
        const relativeX = event.x - rect.x;
        const relativeY = shellY - rect.y;
        focusPane(paneId);
        if (relativeY === 0) {
          const stack = floatingStacks(visibleFloatingPanes.map((entry) => entry.pane.floating!), floatingOrder).get(paneId);
          handleHeaderDown(paneId, rect, relativeX, true, stack);
          return;
        }
        if (!transientFocusActive && relativeX >= rect.width - 2 && relativeY >= rect.height - 1) {
          beginFloatResize(paneId, rect);
          consumeEvent(event);
          return;
        }
        return;
      }

      if (tryDividerDrag()) return;

      for (const leaf of dockLeafLayouts) {
        if (!pointInRect(leaf.rect, event.x, shellY)) continue;
        if (!paneMap.get(leaf.instanceId)) continue;
        focusPane(leaf.instanceId);
        if (shellY - leaf.rect.y === 0) {
          handleHeaderDown(leaf.instanceId, leaf.rect, event.x - leaf.rect.x, false, leaf.stack);
        }
        return;
      }

      return;
    }

    handleActiveDrag(event);
  }, [
    appHeaderHeight,
    closePaneMenu,
    contentHeight,
    dockDividerLayouts,
    dockLeafLayouts,
    focusPane,
    floatingOrder,
    focusedPaneId,
    getPaneQuickSettings,
    getPaneTitle,
    handleActiveDrag,
    handleFloatingClose,
    live,
    restoreFullscreen,
    menuState,
    openPaneMenu,
    openPaneDocs,
    paneMap,
    selectWindowModePane,
    setHoveredMenuItemId,
    setMenuState,
    startDrag,
    transientFocusActive,
    updateDividerPreview,
    updateDragFloatingRect,
    visibleFloatingPanes,
    windowMode,
    width,
  ]);
}
