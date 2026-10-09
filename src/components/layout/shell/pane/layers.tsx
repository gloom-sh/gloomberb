import { useCallback, useMemo, useRef } from "react";
import { Box } from "../../../../ui";
import { resolveOccludedPaneIds } from "../pane-occlusion";
import type {
  DockDividerLayout,
  DockLeafLayout,
  FloatingRect,
  LayoutBounds,
  ResolvedPane,
} from "../../../../layout/pane-manager";
import { colors } from "../../../../theme/colors";
import { constrainFloatingRectToBounds } from "../drag";
import { pathKey } from "../../window-edit/mode";
import { FloatingPaneWrapper } from "../../floating-pane";
import { PaneContent } from "../../pane/content";
import { PaneWrapper } from "../../pane";
import type { PaneHeaderQuickSetting } from "../../pane/header";
import { hasPaneFooterContent, PaneFooterKeys, PaneFooterProvider } from "../../pane/footer";
import { resolvePaneBodyFrame, shouldReservePaneFooter } from "../../pane/sizing";
import type { DividerPreviewState } from "../native/window-state";

type ShellMouseHandler = (event: any) => void;

interface VisibleFloatingPane {
  pane: ResolvedPane;
  rect: FloatingRect;
}

interface ShellPaneLayersProps {
  contentHeight: number;
  dividerPreview: DividerPreviewState | null;
  dockDividerLayouts: DockDividerLayout[];
  dockLeafLayouts: DockLeafLayout[];
  dragFloatingRect: { paneId: string; rect: FloatingRect } | null;
  focusedPaneId: string | null;
  getPaneTitle: (pane: ResolvedPane) => string;
  getPaneQuickSettings: (paneId: string) => PaneHeaderQuickSetting[];
  handleFloatingClose: (paneId: string) => void;
  handleFloatingCloseMouseDown: (paneId: string, event: any) => void;
  handleRestoreFullscreen: ShellMouseHandler;
  handleNativeDrag: ShellMouseHandler;
  handleNativePaneContextMenu: (paneId: string, rect: LayoutBounds, event: any) => void;
  handleNativePaneMouseDown: (paneId: string, event: any) => void;
  handlePaneAction: (paneId: string, rect: LayoutBounds, event: any) => void;
  hoveredPaneId: string | null;
  menuPaneId: string | null;
  nativeContextMenu?: boolean;
  nativePaneChrome: boolean;
  overlayOpen: boolean;
  paneMap: Map<string, ResolvedPane>;
  setHoveredPaneIfChanged: (paneId: string | null) => void;
  startNativeDividerDrag: (divider: DockDividerLayout, event: any) => void;
  startNativeDockedDrag: (paneId: string, rect: LayoutBounds, event: any) => void;
  startNativeFloatingDrag: (paneId: string, rect: FloatingRect, event: any) => void;
  startNativeFloatResize: (paneId: string, rect: FloatingRect, event: any) => void;
  transientFocusActive: boolean;
  transientFocusPaneId: string | null;
  visibleFloatingPanes: VisibleFloatingPane[];
  width: number;
  windowModeDockResizePathKey: string | null;
  windowModePaneId: string | null;
}

const EMPTY_OCCLUSION: ReadonlySet<string> = new Set();

export function ShellPaneLayers({
  contentHeight,
  dividerPreview,
  dockDividerLayouts,
  dockLeafLayouts,
  dragFloatingRect,
  focusedPaneId,
  getPaneTitle,
  getPaneQuickSettings,
  handleFloatingClose,
  handleFloatingCloseMouseDown,
  handleRestoreFullscreen,
  handleNativeDrag,
  handleNativePaneContextMenu,
  handleNativePaneMouseDown,
  handlePaneAction,
  hoveredPaneId,
  menuPaneId,
  nativeContextMenu,
  nativePaneChrome,
  overlayOpen,
  paneMap,
  setHoveredPaneIfChanged,
  startNativeDividerDrag,
  startNativeDockedDrag,
  startNativeFloatingDrag,
  startNativeFloatResize,
  transientFocusActive,
  transientFocusPaneId,
  visibleFloatingPanes,
  width,
  windowModeDockResizePathKey,
  windowModePaneId,
}: ShellPaneLayersProps) {
  // Panes whose every cell sits under floating windows. Their streams drop to
  // the off-screen cadence on every renderer; a transient focus unmounts the
  // other panes, so there is nothing to cover. The floating rects here are the
  // committed ones, so a drag in progress does not churn subscriptions.
  const coveredPaneIds = useMemo(() => {
    if (transientFocusActive || visibleFloatingPanes.length === 0) return EMPTY_OCCLUSION;
    return resolveOccludedPaneIds([
      ...dockLeafLayouts.map((leaf, order) => ({ paneId: leaf.instanceId, rect: leaf.rect, zIndex: null, order })),
      ...visibleFloatingPanes.map(({ pane, rect }, order) => ({
        paneId: pane.instance.instanceId,
        rect,
        zIndex: pane.floating?.zIndex ?? 50,
        order: dockLeafLayouts.length + order,
      })),
    ], { width, height: contentHeight });
  }, [contentHeight, dockLeafLayouts, transientFocusActive, visibleFloatingPanes, width]);
  // Skipping the draw is a terminal concern: desktop pane chrome is DOM, where
  // the compositor already skips covered windows, and a drag keeps everything
  // drawn so the preview never reveals a blank spot.
  const occludedPaneIds = nativePaneChrome || dragFloatingRect ? EMPTY_OCCLUSION : coveredPaneIds;
  // The failure card's Close. Stable, so a focus or layout change does not
  // re-render every memoized pane body.
  const closePaneRef = useRef(handleFloatingClose);
  closePaneRef.current = handleFloatingClose;
  const closePane = useCallback((paneId: string) => closePaneRef.current(paneId), []);

  return (
    <>
      {dockLeafLayouts.map((leaf) => {
        if (transientFocusActive && leaf.instanceId !== transientFocusPaneId) return null;
        const pane = paneMap.get(leaf.instanceId);
        if (!pane) return null;
        const rect = transientFocusActive
          ? { x: 0, y: 0, width, height: contentHeight }
          : leaf.rect;
        const isFullscreenBase = transientFocusActive && leaf.instanceId === transientFocusPaneId;
        const focused = focusedPaneId === leaf.instanceId && (!overlayOpen || menuPaneId === leaf.instanceId);
        const windowModeSelected = windowModePaneId === leaf.instanceId;
        const showActions = focused || hoveredPaneId === leaf.instanceId || menuPaneId === leaf.instanceId;
        const title = getPaneTitle(pane);
        return (
          <Box
            key={`dock:${leaf.instanceId}`}
            position="absolute"
            left={rect.x}
            top={rect.y}
            width={rect.width}
            height={rect.height}
            visible={!occludedPaneIds.has(leaf.instanceId)}
          >
            <PaneFooterProvider>
              {(footer) => {
                const showFooter = hasPaneFooterContent(footer);
                const reserveFooter = shouldReservePaneFooter(nativePaneChrome, showFooter);
                const renderFooter = reserveFooter || showFooter;
                const bodyFrame = resolvePaneBodyFrame({
                  width: rect.width,
                  height: rect.height,
                  nativePaneChrome,
                  footerVisible: renderFooter,
                  reserveFooter,
                });
                return (
                  <PaneWrapper
                    paneId={leaf.instanceId}
                    title={title}
                    focused={focused}
                    width={rect.width}
                    height={rect.height}
                    locked={pane.instance.locked === true}
                    showActions={showActions}
                    quickSettings={getPaneQuickSettings(leaf.instanceId)}
                    topRule={rect.y > 0.01}
                    windowModeSelected={windowModeSelected}
                    footer={footer}
                    onMouseDownCapture={nativePaneChrome ? (event) => handleNativePaneMouseDown(leaf.instanceId, event) : undefined}
                    onHeaderMouseMove={() => setHoveredPaneIfChanged(leaf.instanceId)}
                    onHeaderMouseDown={nativePaneChrome && !transientFocusActive ? (event) => startNativeDockedDrag(leaf.instanceId, rect, event) : undefined}
                    onHeaderMouseDrag={nativePaneChrome && !transientFocusActive ? handleNativeDrag : undefined}
                    onHeaderMouseDragEnd={nativePaneChrome && !transientFocusActive ? handleNativeDrag : undefined}
                    onHeaderContextMenu={nativePaneChrome && nativeContextMenu === true ? (event) => handleNativePaneContextMenu(leaf.instanceId, rect, event) : undefined}
                    onActionMouseDown={(event) => handlePaneAction(leaf.instanceId, rect, event)}
                    fullscreen={isFullscreenBase}
                    onRestoreMouseDown={isFullscreenBase ? handleRestoreFullscreen : undefined}
                  >
                    <PaneFooterKeys paneId={leaf.instanceId} footer={footer} focused={focused} />
                    <PaneContent
                      component={pane.def.component}
                      paneId={pane.instance.instanceId}
                      paneType={pane.instance.paneId}
                      title={title}
                      focused={focused}
                      width={bodyFrame.width ?? 1}
                      height={bodyFrame.height ?? 1}
                      inView={!coveredPaneIds.has(leaf.instanceId)}
                      closePane={closePane}
                    />
                  </PaneWrapper>
                );
              }}
            </PaneFooterProvider>
          </Box>
        );
      })}

      {visibleFloatingPanes.map(({ pane, rect }) => {
        if (transientFocusActive && pane.instance.instanceId !== transientFocusPaneId) return null;
        const isFullscreenBase = transientFocusActive && pane.instance.instanceId === transientFocusPaneId;
        const preview = transientFocusActive
          ? { x: 0, y: 0, width, height: contentHeight }
          : dragFloatingRect?.paneId === pane.instance.instanceId
          ? constrainFloatingRectToBounds(dragFloatingRect.rect, width, contentHeight)
          : rect;
        const focused = focusedPaneId === pane.instance.instanceId && (!overlayOpen || menuPaneId === pane.instance.instanceId);
        const windowModeSelected = windowModePaneId === pane.instance.instanceId;
        const showActions = focused || hoveredPaneId === pane.instance.instanceId || menuPaneId === pane.instance.instanceId;
        const title = getPaneTitle(pane);
        return (
          <PaneFooterProvider key={`float:${pane.instance.instanceId}`}>
            {(footer) => {
              const showFooter = hasPaneFooterContent(footer);
              const reserveFooter = shouldReservePaneFooter(nativePaneChrome, showFooter);
              const renderFooter = reserveFooter || showFooter;
              const bodyFrame = resolvePaneBodyFrame({
                width: preview.width,
                height: preview.height,
                nativePaneChrome,
                footerVisible: renderFooter,
                reserveFooter,
              });
              return (
                <FloatingPaneWrapper
                  paneId={pane.instance.instanceId}
                  title={title}
                  x={preview.x}
                  y={preview.y}
                  width={preview.width}
                  height={preview.height}
                  zIndex={pane.floating?.zIndex ?? 50}
                  hidden={occludedPaneIds.has(pane.instance.instanceId)}
                  focused={focused}
                  windowModeSelected={windowModeSelected}
                  locked={pane.instance.locked === true}
                  showActions={showActions}
                  quickSettings={getPaneQuickSettings(pane.instance.instanceId)}
                  footer={footer}
                  onMouseDownCapture={nativePaneChrome ? (event) => handleNativePaneMouseDown(pane.instance.instanceId, event) : undefined}
                  onHeaderMouseMove={() => setHoveredPaneIfChanged(pane.instance.instanceId)}
                  onHeaderMouseDown={nativePaneChrome && !isFullscreenBase ? (event) => startNativeFloatingDrag(pane.instance.instanceId, preview, event) : undefined}
                  onHeaderMouseDrag={nativePaneChrome && !isFullscreenBase ? handleNativeDrag : undefined}
                  onHeaderMouseDragEnd={nativePaneChrome && !isFullscreenBase ? handleNativeDrag : undefined}
                  onHeaderContextMenu={nativePaneChrome && nativeContextMenu === true ? (event) => handleNativePaneContextMenu(pane.instance.instanceId, preview, event) : undefined}
                  onActionMouseDown={(event) => handlePaneAction(pane.instance.instanceId, preview, event)}
                  onCloseMouseDown={isFullscreenBase ? undefined : (event) => handleFloatingCloseMouseDown(pane.instance.instanceId, event)}
                  onRestoreMouseDown={isFullscreenBase ? handleRestoreFullscreen : undefined}
                  fullscreen={isFullscreenBase}
                  onResizeMouseDown={nativePaneChrome && !isFullscreenBase ? (event) => startNativeFloatResize(pane.instance.instanceId, preview, event) : undefined}
                  onResizeMouseDrag={nativePaneChrome && !isFullscreenBase ? handleNativeDrag : undefined}
                  onResizeMouseDragEnd={nativePaneChrome && !isFullscreenBase ? handleNativeDrag : undefined}
                >
                  <PaneFooterKeys paneId={pane.instance.instanceId} footer={footer} focused={focused} />
                  <PaneContent
                    component={pane.def.component}
                    paneId={pane.instance.instanceId}
                    paneType={pane.instance.paneId}
                    title={title}
                    focused={focused}
                    width={bodyFrame.width ?? 1}
                    height={bodyFrame.height ?? 1}
                    inView={!coveredPaneIds.has(pane.instance.instanceId)}
                    onClose={handleFloatingClose}
                    closePane={closePane}
                  />
                </FloatingPaneWrapper>
              );
            }}
          </PaneFooterProvider>
        );
      })}

      {dockDividerLayouts.map((divider) => {
        if (transientFocusActive) return null;
        const dividerPathKey = pathKey(divider.path);
        const previewActive = dividerPreview?.pathKey === dividerPathKey;
        const active = previewActive || windowModeDockResizePathKey === dividerPathKey;
        const rect = previewActive ? dividerPreview.rect : divider.rect;
        return (
          <Box
            key={`divider:${divider.path.join(".")}`}
            position="absolute"
            left={rect.x}
            top={rect.y}
            width={rect.width}
            height={rect.height}
            zIndex={active ? 2 : 1}
            backgroundColor={active ? colors.borderFocused : colors.border}
            {...(nativePaneChrome ? {
              "data-gloom-role": "dock-divider",
              "data-axis": divider.axis,
              "data-active": active ? "true" : "false",
              style: { "--divider-color": active ? colors.borderFocused : colors.border } as any,
            } : {})}
            onMouseDown={nativePaneChrome ? (event: any) => startNativeDividerDrag(divider, event) : undefined}
            onMouseDrag={nativePaneChrome ? handleNativeDrag : undefined}
            onMouseDragEnd={nativePaneChrome ? handleNativeDrag : undefined}
          />
        );
      })}
    </>
  );
}
