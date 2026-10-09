import { memo, useCallback, useMemo, useRef } from "react";
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
import { useLiveDrag, type LiveDragGeometry, type LiveDragStore } from "../drag/live";
import { slideStyle } from "../drag/slide";
import { pathKey } from "../../window-edit/mode";
import { FloatingPaneWrapper } from "../../floating-pane";
import { PaneContent } from "../../pane/content";
import { PaneWrapper } from "../../pane";
import type { PaneHeaderQuickSetting } from "../../pane/header";
import { hasPaneFooterContent, PaneFooterKeys, PaneFooterProvider } from "../../pane/footer";
import { resolvePaneBodyFrame, shouldReservePaneFooter } from "../../pane/sizing";

type ShellMouseHandler = (event: any) => void;

interface VisibleFloatingPane {
  pane: ResolvedPane;
  rect: FloatingRect;
}

interface ShellPaneLayersProps {
  contentHeight: number;
  dockDividerLayouts: DockDividerLayout[];
  dockLeafLayouts: DockLeafLayout[];
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
  live: LiveDragStore;
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

/**
 * What a pane's chrome calls back into the shell. One stable object that
 * always reaches the shell's current handlers, so a pane layer re-renders only
 * when something it draws changed, not whenever the shell does.
 */
interface PaneLayerActions {
  paneMouseDown: (paneId: string, event: any) => void;
  hover: (paneId: string) => void;
  dockedDragStart: (paneId: string, rect: LayoutBounds, event: any) => void;
  floatingDragStart: (paneId: string, rect: FloatingRect, event: any) => void;
  floatResizeStart: (paneId: string, rect: FloatingRect, event: any) => void;
  drag: ShellMouseHandler;
  contextMenu: (paneId: string, rect: LayoutBounds, event: any) => void;
  menu: (paneId: string, rect: LayoutBounds, event: any) => void;
  closeMouseDown: (paneId: string, event: any) => void;
  /** Also the failure card's Close: keep it stable, the pane body is memoized on it. */
  close: (paneId: string) => void;
  restoreFullscreen: ShellMouseHandler;
  dividerDragStart: (divider: DockDividerLayout, event: any) => void;
}

interface PaneLayerProps {
  pane: ResolvedPane;
  rect: LayoutBounds;
  title: string;
  focused: boolean;
  windowModeSelected: boolean;
  showActions: boolean;
  /** Fully covered (terminal only): skip drawing, keep the tree mounted. */
  hidden: boolean;
  inView: boolean;
  fullscreen: boolean;
  /** Whether the header can start a move: not in fullscreen. */
  movable: boolean;
  nativePaneChrome: boolean;
  nativeContextMenu: boolean;
  getPaneQuickSettings: (paneId: string) => PaneHeaderQuickSetting[];
  actions: PaneLayerActions;
}

const EMPTY_OCCLUSION: ReadonlySet<string> = new Set();
const selectFloatingDragActive = (geometry: LiveDragGeometry) => geometry.floating !== null;

function usePaneQuickSettings(getPaneQuickSettings: PaneLayerProps["getPaneQuickSettings"], paneId: string) {
  return useMemo(() => getPaneQuickSettings(paneId), [getPaneQuickSettings, paneId]);
}

const DockedPaneLayer = memo(function DockedPaneLayer({
  pane,
  rect,
  title,
  focused,
  windowModeSelected,
  showActions,
  hidden,
  inView,
  fullscreen,
  movable,
  nativePaneChrome,
  nativeContextMenu,
  getPaneQuickSettings,
  actions,
}: PaneLayerProps) {
  const paneId = pane.instance.instanceId;
  const quickSettings = usePaneQuickSettings(getPaneQuickSettings, paneId);
  const nativeMove = nativePaneChrome && movable;
  return (
    <Box
      position="absolute"
      left={rect.x}
      top={rect.y}
      width={rect.width}
      height={rect.height}
      visible={!hidden}
    >
      <PaneFooterProvider>
        {(footer) => {
          const showFooter = hasPaneFooterContent(footer);
          const reserveFooter = shouldReservePaneFooter(nativePaneChrome, showFooter);
          const bodyFrame = resolvePaneBodyFrame({
            width: rect.width,
            height: rect.height,
            nativePaneChrome,
            footerVisible: reserveFooter || showFooter,
            reserveFooter,
          });
          return (
            <PaneWrapper
              paneId={paneId}
              title={title}
              focused={focused}
              width={rect.width}
              height={rect.height}
              locked={pane.instance.locked === true}
              showActions={showActions}
              quickSettings={quickSettings}
              topRule={rect.y > 0.01}
              windowModeSelected={windowModeSelected}
              footer={footer}
              onMouseDownCapture={nativePaneChrome ? (event) => actions.paneMouseDown(paneId, event) : undefined}
              onHeaderMouseMove={() => actions.hover(paneId)}
              onHeaderMouseDown={nativeMove ? (event) => actions.dockedDragStart(paneId, rect, event) : undefined}
              onHeaderMouseDrag={nativeMove ? actions.drag : undefined}
              onHeaderMouseDragEnd={nativeMove ? actions.drag : undefined}
              onHeaderContextMenu={nativePaneChrome && nativeContextMenu ? (event) => actions.contextMenu(paneId, rect, event) : undefined}
              onActionMouseDown={(event) => actions.menu(paneId, rect, event)}
              fullscreen={fullscreen}
              onRestoreMouseDown={fullscreen ? actions.restoreFullscreen : undefined}
            >
              <PaneFooterKeys paneId={paneId} footer={footer} focused={focused} />
              <PaneContent
                component={pane.def.component}
                paneId={paneId}
                paneType={pane.instance.paneId}
                title={title}
                focused={focused}
                width={bodyFrame.width ?? 1}
                height={bodyFrame.height ?? 1}
                inView={inView}
                closePane={actions.close}
              />
            </PaneWrapper>
          );
        }}
      </PaneFooterProvider>
    </Box>
  );
});

const FloatingPaneFrame = memo(function FloatingPaneFrame({
  pane,
  rect,
  title,
  focused,
  windowModeSelected,
  showActions,
  hidden,
  inView,
  fullscreen,
  movable,
  nativePaneChrome,
  nativeContextMenu,
  getPaneQuickSettings,
  actions,
  zIndex,
}: PaneLayerProps & { rect: FloatingRect; zIndex: number }) {
  const paneId = pane.instance.instanceId;
  const quickSettings = usePaneQuickSettings(getPaneQuickSettings, paneId);
  const nativeMove = nativePaneChrome && movable;
  return (
    <PaneFooterProvider>
      {(footer) => {
        const showFooter = hasPaneFooterContent(footer);
        const reserveFooter = shouldReservePaneFooter(nativePaneChrome, showFooter);
        const bodyFrame = resolvePaneBodyFrame({
          width: rect.width,
          height: rect.height,
          nativePaneChrome,
          footerVisible: reserveFooter || showFooter,
          reserveFooter,
        });
        return (
          <FloatingPaneWrapper
            paneId={paneId}
            title={title}
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
            zIndex={zIndex}
            hidden={hidden}
            focused={focused}
            windowModeSelected={windowModeSelected}
            locked={pane.instance.locked === true}
            showActions={showActions}
            quickSettings={quickSettings}
            footer={footer}
            onMouseDownCapture={nativePaneChrome ? (event) => actions.paneMouseDown(paneId, event) : undefined}
            onHeaderMouseMove={() => actions.hover(paneId)}
            onHeaderMouseDown={nativeMove ? (event) => actions.floatingDragStart(paneId, rect, event) : undefined}
            onHeaderMouseDrag={nativeMove ? actions.drag : undefined}
            onHeaderMouseDragEnd={nativeMove ? actions.drag : undefined}
            onHeaderContextMenu={nativePaneChrome && nativeContextMenu ? (event) => actions.contextMenu(paneId, rect, event) : undefined}
            onActionMouseDown={(event) => actions.menu(paneId, rect, event)}
            onCloseMouseDown={fullscreen ? undefined : (event) => actions.closeMouseDown(paneId, event)}
            onRestoreMouseDown={fullscreen ? actions.restoreFullscreen : undefined}
            fullscreen={fullscreen}
            onResizeMouseDown={nativeMove ? (event) => actions.floatResizeStart(paneId, rect, event) : undefined}
            onResizeMouseDrag={nativeMove ? actions.drag : undefined}
            onResizeMouseDragEnd={nativeMove ? actions.drag : undefined}
          >
            <PaneFooterKeys paneId={paneId} footer={footer} focused={focused} />
            <PaneContent
              component={pane.def.component}
              paneId={paneId}
              paneType={pane.instance.paneId}
              title={title}
              focused={focused}
              width={bodyFrame.width ?? 1}
              height={bodyFrame.height ?? 1}
              inView={inView}
              onClose={actions.close}
              closePane={actions.close}
            />
          </FloatingPaneWrapper>
        );
      }}
    </PaneFooterProvider>
  );
});

/**
 * A floating pane, drawn at its layout rect or where a drag has it right now.
 * On the desktop a move slides the drawn pane with a compositor transform, so
 * nothing inside it re-renders, lays out or repaints while it follows the
 * pointer; a resize redraws it at the new size.
 */
const FloatingPaneLayer = memo(function FloatingPaneLayer({
  live,
  rect,
  width,
  contentHeight,
  zIndex,
  ...frame
}: PaneLayerProps & { rect: FloatingRect; zIndex: number; live: LiveDragStore; width: number; contentHeight: number }) {
  const paneId = frame.pane.instance.instanceId;
  const select = useCallback((geometry: LiveDragGeometry) => (
    geometry.floating?.paneId === paneId ? geometry.floating.rect : null
  ), [paneId]);
  const dragRect = useLiveDrag(live, select);
  const preview = dragRect ? constrainFloatingRectToBounds(dragRect, width, contentHeight) : rect;
  const slide = frame.nativePaneChrome;
  const sliding = slide && dragRect !== null && preview.width === rect.width && preview.height === rect.height;
  const content = <FloatingPaneFrame {...frame} rect={sliding ? rect : preview} zIndex={zIndex} />;
  if (!slide) return content;
  return (
    <Box
      position="absolute"
      left={0}
      top={0}
      width={0}
      height={0}
      zIndex={zIndex}
      style={sliding ? slideStyle(preview.x - rect.x, preview.y - rect.y) : undefined}
    >
      {content}
    </Box>
  );
});

/** A tiled split's divider, which follows the pointer while it is dragged. */
const DockDividerLayer = memo(function DockDividerLayer({
  divider,
  resizing,
  live,
  nativePaneChrome,
  actions,
}: {
  divider: DockDividerLayout;
  /** Window mode is resizing this split from the keyboard. */
  resizing: boolean;
  live: LiveDragStore;
  nativePaneChrome: boolean;
  actions: PaneLayerActions;
}) {
  const dividerPathKey = pathKey(divider.path);
  const select = useCallback((geometry: LiveDragGeometry) => (
    geometry.divider?.pathKey === dividerPathKey ? geometry.divider.rect : null
  ), [dividerPathKey]);
  const previewRect = useLiveDrag(live, select);
  const active = previewRect !== null || resizing;
  const rect = previewRect ?? divider.rect;
  return (
    <Box
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
      onMouseDown={nativePaneChrome ? (event: any) => actions.dividerDragStart(divider, event) : undefined}
      onMouseDrag={nativePaneChrome ? actions.drag : undefined}
      onMouseDragEnd={nativePaneChrome ? actions.drag : undefined}
    />
  );
});

export function ShellPaneLayers({
  contentHeight,
  dockDividerLayouts,
  dockLeafLayouts,
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
  live,
  menuPaneId,
  nativeContextMenu = false,
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
  const floatingDragActive = useLiveDrag(live, selectFloatingDragActive);
  const occludedPaneIds = nativePaneChrome || floatingDragActive ? EMPTY_OCCLUSION : coveredPaneIds;
  const fullscreenRect = useMemo(() => ({ x: 0, y: 0, width, height: contentHeight }), [contentHeight, width]);

  const handlersRef = useRef({
    handleFloatingClose,
    handleFloatingCloseMouseDown,
    handleRestoreFullscreen,
    handleNativeDrag,
    handleNativePaneContextMenu,
    handleNativePaneMouseDown,
    handlePaneAction,
    setHoveredPaneIfChanged,
    startNativeDividerDrag,
    startNativeDockedDrag,
    startNativeFloatingDrag,
    startNativeFloatResize,
  });
  handlersRef.current = {
    handleFloatingClose,
    handleFloatingCloseMouseDown,
    handleRestoreFullscreen,
    handleNativeDrag,
    handleNativePaneContextMenu,
    handleNativePaneMouseDown,
    handlePaneAction,
    setHoveredPaneIfChanged,
    startNativeDividerDrag,
    startNativeDockedDrag,
    startNativeFloatingDrag,
    startNativeFloatResize,
  };
  // Only called from events, never while rendering, so reading the latest handlers is safe.
  const actions = useMemo<PaneLayerActions>(() => ({
    paneMouseDown: (paneId, event) => handlersRef.current.handleNativePaneMouseDown(paneId, event),
    hover: (paneId) => handlersRef.current.setHoveredPaneIfChanged(paneId),
    dockedDragStart: (paneId, rect, event) => handlersRef.current.startNativeDockedDrag(paneId, rect, event),
    floatingDragStart: (paneId, rect, event) => handlersRef.current.startNativeFloatingDrag(paneId, rect, event),
    floatResizeStart: (paneId, rect, event) => handlersRef.current.startNativeFloatResize(paneId, rect, event),
    drag: (event) => handlersRef.current.handleNativeDrag(event),
    contextMenu: (paneId, rect, event) => handlersRef.current.handleNativePaneContextMenu(paneId, rect, event),
    menu: (paneId, rect, event) => handlersRef.current.handlePaneAction(paneId, rect, event),
    closeMouseDown: (paneId, event) => handlersRef.current.handleFloatingCloseMouseDown(paneId, event),
    close: (paneId) => handlersRef.current.handleFloatingClose(paneId),
    restoreFullscreen: (event) => handlersRef.current.handleRestoreFullscreen(event),
    dividerDragStart: (divider, event) => handlersRef.current.startNativeDividerDrag(divider, event),
  }), []);

  const layerProps = (pane: ResolvedPane, rect: LayoutBounds): PaneLayerProps => {
    const paneId = pane.instance.instanceId;
    const focused = focusedPaneId === paneId && (!overlayOpen || menuPaneId === paneId);
    const fullscreen = transientFocusActive && paneId === transientFocusPaneId;
    return {
      pane,
      rect,
      title: getPaneTitle(pane),
      focused,
      windowModeSelected: windowModePaneId === paneId,
      showActions: focused || hoveredPaneId === paneId || menuPaneId === paneId,
      hidden: occludedPaneIds.has(paneId),
      inView: !coveredPaneIds.has(paneId),
      fullscreen,
      movable: !transientFocusActive,
      nativePaneChrome,
      nativeContextMenu,
      getPaneQuickSettings,
      actions,
    };
  };

  return (
    <>
      {dockLeafLayouts.map((leaf) => {
        if (transientFocusActive && leaf.instanceId !== transientFocusPaneId) return null;
        const pane = paneMap.get(leaf.instanceId);
        if (!pane) return null;
        return (
          <DockedPaneLayer
            key={`dock:${leaf.instanceId}`}
            {...layerProps(pane, transientFocusActive ? fullscreenRect : leaf.rect)}
          />
        );
      })}

      {visibleFloatingPanes.map(({ pane, rect }) => {
        if (transientFocusActive && pane.instance.instanceId !== transientFocusPaneId) return null;
        return (
          <FloatingPaneLayer
            key={`float:${pane.instance.instanceId}`}
            {...layerProps(pane, transientFocusActive ? fullscreenRect : rect)}
            rect={transientFocusActive ? fullscreenRect : rect}
            zIndex={pane.floating?.zIndex ?? 50}
            live={live}
            width={width}
            contentHeight={contentHeight}
          />
        );
      })}

      {!transientFocusActive && dockDividerLayouts.map((divider) => (
        <DockDividerLayer
          key={`divider:${divider.path.join(".")}`}
          divider={divider}
          resizing={windowModeDockResizePathKey === pathKey(divider.path)}
          live={live}
          nativePaneChrome={nativePaneChrome}
          actions={actions}
        />
      ))}
    </>
  );
}
