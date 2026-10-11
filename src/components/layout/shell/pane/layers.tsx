import { memo, useCallback, useMemo, useRef, type RefObject } from "react";
import { Box, type BoxRenderable, type LiveBoxFrame } from "../../../../ui";
import { cssLayoutMode } from "../../../../ui/css-layout";
import { useMeasuredCells, useMeasuredPaneFrame } from "../../../../ui/measured-cells";
import type { DockLayoutNode } from "../../../../types/config";
import { anchoredPaneStyle, CSS_ANCHORS, CssDockTree } from "./css-dock";
import { resolveOccludedPaneIds } from "../pane-occlusion";
import type {
  DockDividerLayout,
  DockLeafLayout,
  FloatingRect,
  LayoutBounds,
  ResolvedPane,
} from "../../../../layout/pane-manager";
import { colors } from "../../../../theme/colors";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../../../theme/font-scale";
import { LivePaneFrameContext, type CellSize, type LivePaneFrame } from "../../../../ui/live-stretch";
import { constrainFloatingRectToBounds, sameRect, type ResizeEdges } from "../drag";
import { useLiveBoxFrame, useLiveCatchUp, useLiveDrag, type LiveDragGeometry, type LiveDragStore } from "../drag/live";
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
  /** The CSS layout spike (`ui/css-layout.ts`) draws the docked panes from the tree itself. */
  dockRoot?: DockLayoutNode | null;
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
  handlePaneHelp: (paneId: string) => void;
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
  startNativeFloatResize: (paneId: string, rect: FloatingRect, event: any, edges?: ResizeEdges) => void;
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
  floatResizeStart: (paneId: string, rect: FloatingRect, event: any, edges?: ResizeEdges) => void;
  drag: ShellMouseHandler;
  contextMenu: (paneId: string, rect: LayoutBounds, event: any) => void;
  menu: (paneId: string, rect: LayoutBounds, event: any) => void;
  /** The `?`: the pane's entry in DOCS. */
  help: (paneId: string) => void;
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
  /** The CSS layout spike is on: the browser sizes the frame and the content measures it. */
  cssLayout: boolean;
  getPaneQuickSettings: (paneId: string) => PaneHeaderQuickSetting[];
  actions: PaneLayerActions;
}

const EMPTY_OCCLUSION: ReadonlySet<string> = new Set();
const selectFloatingDragActive = (geometry: LiveDragGeometry) => geometry.floating !== null;
const selectNothing = () => null;
const selectNoDrag = () => false;

function usePaneQuickSettings(getPaneQuickSettings: PaneLayerProps["getPaneQuickSettings"], paneId: string) {
  return useMemo(() => getPaneQuickSettings(paneId), [getPaneQuickSettings, paneId]);
}

/**
 * Desktop: what a pane's content reads to follow a resize between catch-ups
 * (`useLiveStretch`): the frame's size as the content rendered, and where the
 * drag has it on each move. `sizeOf` must be stable while its inputs are.
 */
function useLivePaneFrame(
  live: LiveDragStore,
  rendered: LayoutBounds,
  sizeOf: ((geometry: LiveDragGeometry) => CellSize | null) | null,
): LivePaneFrame | null {
  const { width, height } = rendered;
  return useMemo(() => (sizeOf ? {
    rendered: { width, height },
    live: () => sizeOf(live.get()),
    subscribe: live.subscribeMotion,
  } : null), [height, live, sizeOf, width]);
}

/**
 * A docked pane at its layout rect. On the desktop a divider drag moves and
 * sizes it by restyling its box on every move (`useLiveBoxFrame`), so its
 * header, body and footer stretch with the split and nothing renders; its
 * content renders at the new size a few times a second (`useLiveCatchUp`),
 * charts and heat maps follow the frame in between (`useLiveStretch`), and
 * the release lays the split out once.
 */
const DockedPaneLayer = memo(function DockedPaneLayer({
  pane,
  rect: layoutRect,
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
  live,
}: PaneLayerProps & { live: LiveDragStore }) {
  const paneId = pane.instance.instanceId;
  const quickSettings = usePaneQuickSettings(getPaneQuickSettings, paneId);
  const nativeMove = nativePaneChrome && movable;
  const boxRef = useRef<BoxRenderable | null>(null);
  const frameOf = useMemo(() => (nativePaneChrome ? (geometry: LiveDragGeometry): LiveBoxFrame | null => {
    const at = geometry.dock?.leaves.get(paneId);
    return at ? { x: at.x, y: at.y, width: at.width, height: at.height } : null;
  } : null), [nativePaneChrome, paneId]);
  useLiveBoxFrame(live, boxRef, frameOf);
  const selectCatchUp = useMemo(() => (nativePaneChrome ? (geometry: LiveDragGeometry) => {
    const at = geometry.dock?.leaves.get(paneId);
    return at && !sameRect(at, layoutRect) ? at : null;
  } : null), [layoutRect, nativePaneChrome, paneId]);
  const rect = useLiveCatchUp(live, selectCatchUp) ?? layoutRect;
  const sizeOf = useMemo(() => (nativePaneChrome
    ? (geometry: LiveDragGeometry): CellSize | null => geometry.dock?.leaves.get(paneId) ?? null
    : null), [nativePaneChrome, paneId]);
  const liveFrame = useLivePaneFrame(live, rect, sizeOf);
  return (
    <Box
      ref={boxRef}
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
              stretch={nativePaneChrome}
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
              onHelpMouseDown={() => actions.help(paneId)}
              fullscreen={fullscreen}
              onRestoreMouseDown={fullscreen ? actions.restoreFullscreen : undefined}
            >
              <PaneFooterKeys paneId={paneId} footer={footer} focused={focused} />
              <LivePaneFrameContext.Provider value={liveFrame}>
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
              </LivePaneFrameContext.Provider>
            </PaneWrapper>
          );
        }}
      </PaneFooterProvider>
    </Box>
  );
});

const FILL_SLOT = { width: "100%", height: "100%" } as const;

/**
 * CSS layout spike (`ui/css-layout.ts`): a docked pane on the box the browser
 * lays out for it (`CssDockTree`), over its slot by anchor positioning or
 * inside it. Nothing restyles it during a divider drag: its box follows the
 * flex layout, the content box fills it and the content's root fills that
 * (`fill`), and what the content renders for one size gets the size its box
 * measures (`useMeasuredCells`). Fullscreen, it covers the shell's content
 * area instead, as the same component, so it keeps its state. Its layout rect
 * still names where it is to the drag and menu handlers.
 */
const CssDockedPaneLayer = memo(function CssDockedPaneLayer({
  pane,
  rect: layoutRect,
  title,
  focused,
  windowModeSelected,
  showActions,
  inView,
  fullscreen,
  movable,
  nativeContextMenu,
  getPaneQuickSettings,
  actions,
}: PaneLayerProps) {
  const paneId = pane.instance.instanceId;
  const quickSettings = usePaneQuickSettings(getPaneQuickSettings, paneId);
  const boxRef = useRef<BoxRenderable | null>(null);
  const size = useMeasuredCells(boxRef, layoutRect, true);
  const liveFrame = useMeasuredPaneFrame(boxRef, size, true);
  const { width: fullWidth, height: fullHeight } = layoutRect;
  const placement = useMemo(() => (fullscreen
    ? { position: "absolute", left: 0, top: 0, width: `calc(${fullWidth} * var(--cell-w))`, height: `calc(${fullHeight} * var(--cell-h))` } as const
    : CSS_ANCHORS ? anchoredPaneStyle(paneId) : FILL_SLOT), [fullHeight, fullWidth, fullscreen, paneId]);
  return (
    <Box ref={boxRef} style={placement}>
      <PaneFooterProvider>
        {(footer) => {
          const showFooter = hasPaneFooterContent(footer);
          const bodyFrame = resolvePaneBodyFrame({
            width: size.width,
            height: size.height,
            nativePaneChrome: true,
            footerVisible: showFooter,
            reserveFooter: false,
          });
          return (
            <PaneWrapper
              paneId={paneId}
              title={title}
              focused={focused}
              width={size.width}
              height={size.height}
              stretch
              locked={pane.instance.locked === true}
              showActions={showActions}
              quickSettings={quickSettings}
              topRule={layoutRect.y > 0.01}
              windowModeSelected={windowModeSelected}
              footer={footer}
              onMouseDownCapture={(event) => actions.paneMouseDown(paneId, event)}
              onHeaderMouseMove={() => actions.hover(paneId)}
              onHeaderMouseDown={movable ? (event) => actions.dockedDragStart(paneId, layoutRect, event) : undefined}
              onHeaderMouseDrag={movable ? actions.drag : undefined}
              onHeaderMouseDragEnd={movable ? actions.drag : undefined}
              onHeaderContextMenu={nativeContextMenu ? (event) => actions.contextMenu(paneId, layoutRect, event) : undefined}
              onActionMouseDown={(event) => actions.menu(paneId, layoutRect, event)}
              onHelpMouseDown={() => actions.help(paneId)}
              fullscreen={fullscreen}
              onRestoreMouseDown={fullscreen ? actions.restoreFullscreen : undefined}
            >
              <PaneFooterKeys paneId={paneId} footer={footer} focused={focused} />
              <LivePaneFrameContext.Provider value={liveFrame}>
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
                  fill
                />
              </LivePaneFrameContext.Provider>
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
  cssLayout,
  getPaneQuickSettings,
  actions,
  zIndex,
  frameRef,
}: PaneLayerProps & {
  rect: FloatingRect;
  zIndex: number;
  /** Desktop: the frame a resize sizes outside React. */
  frameRef?: RefObject<BoxRenderable | null>;
}) {
  const paneId = pane.instance.instanceId;
  const quickSettings = usePaneQuickSettings(getPaneQuickSettings, paneId);
  const nativeMove = nativePaneChrome && movable;
  // CSS layout spike: the content renders at the size its frame measures, not at a catch-up's.
  const noFrame = useRef<BoxRenderable | null>(null);
  const size = useMeasuredCells(frameRef ?? noFrame, rect, cssLayout && !!frameRef);
  const measuredFrame = useMeasuredPaneFrame(frameRef ?? noFrame, size, cssLayout && !!frameRef);
  return (
    <PaneFooterProvider>
      {(footer) => {
        const showFooter = hasPaneFooterContent(footer);
        const reserveFooter = shouldReservePaneFooter(nativePaneChrome, showFooter);
        const bodyFrame = resolvePaneBodyFrame({
          width: size.width,
          height: size.height,
          nativePaneChrome,
          footerVisible: reserveFooter || showFooter,
          reserveFooter,
        });
        const content = (
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
            fill={cssLayout}
          />
        );
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
            onHelpMouseDown={() => actions.help(paneId)}
            onCloseMouseDown={fullscreen ? undefined : (event) => actions.closeMouseDown(paneId, event)}
            onRestoreMouseDown={fullscreen ? actions.restoreFullscreen : undefined}
            fullscreen={fullscreen}
            onResizeMouseDown={nativeMove ? (event) => actions.floatResizeStart(paneId, rect, event) : undefined}
            onResizeMouseDrag={nativeMove ? actions.drag : undefined}
            onResizeMouseDragEnd={nativeMove ? actions.drag : undefined}
            frameRef={frameRef}
          >
            <PaneFooterKeys paneId={paneId} footer={footer} focused={focused} />
            {measuredFrame ? (
              <LivePaneFrameContext.Provider value={measuredFrame}>
                {content}
              </LivePaneFrameContext.Provider>
            ) : content}
          </FloatingPaneWrapper>
        );
      }}
    </PaneFooterProvider>
  );
});

/**
 * Px a desktop resize edge reaches out past a floating pane's border, and in
 * over it: a few px either way, so it takes neither a press meant for what
 * sits next to the pane nor much of the pane's own scrollbar.
 */
const RESIZE_EDGE_OUTSIDE_PX = 3;
const RESIZE_EDGE_INSIDE_PX = 3;
/** A corner's grab square runs this far along both edges, in px, short of the header's buttons. */
const RESIZE_CORNER_PX = 10;

const RESIZE_EDGES: Array<{ id: string; edges: ResizeEdges }> = [
  { id: "left", edges: { x: -1, y: 0 } },
  { id: "right", edges: { x: 1, y: 0 } },
  { id: "top", edges: { x: 0, y: -1 } },
  { id: "bottom", edges: { x: 0, y: 1 } },
  { id: "top-left", edges: { x: -1, y: -1 } },
  { id: "top-right", edges: { x: 1, y: -1 } },
  { id: "bottom-left", edges: { x: -1, y: 1 } },
  { id: "bottom-right", edges: { x: 1, y: 1 } },
];

/** Where an edge's grab strip sits, in px from the layer's corner (the shell's), around a pane at `rect`. */
function resizeEdgeStyle(rect: FloatingRect, edges: ResizeEdges) {
  const left = rect.x * WEB_CELL_WIDTH;
  const top = rect.y * WEB_CELL_HEIGHT;
  const width = rect.width * WEB_CELL_WIDTH;
  const height = rect.height * WEB_CELL_HEIGHT;
  const thick = RESIZE_EDGE_OUTSIDE_PX + RESIZE_EDGE_INSIDE_PX;
  const span = (start: number, length: number, edge: -1 | 0 | 1): [number, number] => {
    if (edge === -1) return [start - RESIZE_EDGE_OUTSIDE_PX, edges.x !== 0 && edges.y !== 0 ? RESIZE_CORNER_PX : thick];
    if (edge === 1) {
      const size = edges.x !== 0 && edges.y !== 0 ? RESIZE_CORNER_PX : thick;
      return [start + length + RESIZE_EDGE_OUTSIDE_PX - size, size];
    }
    // Along the edge, short of the corners.
    return [start + RESIZE_CORNER_PX - RESIZE_EDGE_OUTSIDE_PX, Math.max(0, length - 2 * (RESIZE_CORNER_PX - RESIZE_EDGE_OUTSIDE_PX))];
  };
  const [x, w] = span(left, width, edges.x);
  const [y, h] = span(top, height, edges.y);
  return { left: x, top: y, width: w, height: h };
}

/**
 * Desktop: the invisible strips along a floating pane's edges and corners
 * that resize it, as a window's do. They straddle the border, short of the
 * header's buttons.
 */
const FloatingResizeEdges = memo(function FloatingResizeEdges({
  paneId,
  rect,
  zIndex,
  actions,
}: {
  paneId: string;
  rect: FloatingRect;
  zIndex: number;
  actions: PaneLayerActions;
}) {
  return (
    <>
      {RESIZE_EDGES.map(({ id, edges }) => (
        <Box
          key={id}
          position="absolute"
          zIndex={zIndex + 1}
          data-gloom-role="resize-edge"
          data-edge={id}
          style={resizeEdgeStyle(rect, edges)}
          onMouseDown={(event: any) => actions.floatResizeStart(paneId, rect, event, edges)}
          onMouseDrag={actions.drag}
          onMouseDragEnd={actions.drag}
        />
      ))}
    </>
  );
});

/**
 * A floating pane, drawn at its layout rect or where a drag has it right now.
 * On the desktop a move never renders: the pane's layer is promoted at the
 * press and each frame of the move only writes its transform (see
 * `useLiveBoxFrame`), so nothing inside it re-renders, lays out or repaints
 * until the release commits the new position. A resize writes the frame's
 * size the same way, on the same layer (moved too when a left or top edge
 * leads), and the header, body, footer and content stretch with it; what the
 * content lays out on the cell grid renders at the new size a few times a
 * second (`useLiveCatchUp`), and charts and heat maps follow the frame in
 * between (`useLiveStretch`). Every terminal frame redraws it at the drag's
 * rect.
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
  const slide = frame.nativePaneChrome;
  const selectRedraw = useCallback((geometry: LiveDragGeometry) => {
    if (geometry.floating?.paneId !== paneId) return null;
    // A desktop move or resize follows by restyling the pane instead.
    if (slide && (geometry.paneDrag?.paneId === paneId || geometry.paneResize?.paneId === paneId)) return null;
    return geometry.floating.rect;
  }, [paneId, slide]);
  const dragRect = useLiveDrag(live, selectRedraw);
  const layerRef = useRef<BoxRenderable | null>(null);
  const frameOf = useMemo(() => (slide ? (geometry: LiveDragGeometry): LiveBoxFrame | null => {
    // A resize keeps the pane on its own layer too: the panes it uncovers or
    // covers never repaint, only the pane does. A left or top edge moves it.
    if (geometry.paneResize?.paneId === paneId) {
      const resized = geometry.floating?.paneId === paneId ? constrainFloatingRectToBounds(geometry.floating.rect, width, contentHeight) : null;
      return resized ? { dx: resized.x - rect.x, dy: resized.y - rect.y } : { dx: 0, dy: 0 };
    }
    if (geometry.paneDrag?.paneId !== paneId) return null;
    const moving = geometry.floating?.paneId === paneId ? geometry.floating.rect : null;
    // Promoted from the press, so the first move already only slides it.
    if (!moving) return { dx: 0, dy: 0 };
    const at = constrainFloatingRectToBounds(moving, width, contentHeight);
    return { dx: at.x - rect.x, dy: at.y - rect.y };
  } : null), [contentHeight, paneId, rect.x, rect.y, slide, width]);
  useLiveBoxFrame(live, layerRef, frameOf);
  const frameRef = useRef<BoxRenderable | null>(null);
  const sizeOf = useMemo(() => (slide ? (geometry: LiveDragGeometry): CellSize | null => {
    if (geometry.paneResize?.paneId !== paneId || geometry.floating?.paneId !== paneId) return null;
    const at = constrainFloatingRectToBounds(geometry.floating.rect, width, contentHeight);
    return { width: at.width, height: at.height };
  } : null), [contentHeight, paneId, slide, width]);
  useLiveBoxFrame(live, frameRef, sizeOf);
  // The CSS layout spike measures the frame instead (`FloatingPaneFrame`).
  const catchUp = slide && !frame.cssLayout;
  const selectCatchUp = useMemo(() => (catchUp ? (geometry: LiveDragGeometry) => {
    if (geometry.paneResize?.paneId !== paneId || geometry.floating?.paneId !== paneId) return null;
    const resized = constrainFloatingRectToBounds(geometry.floating.rect, width, contentHeight);
    return sameRect(resized, rect) ? null : resized;
  } : null), [catchUp, contentHeight, paneId, rect, width]);
  const resizeRect = useLiveCatchUp(live, selectCatchUp);
  const preview = dragRect
    ? constrainFloatingRectToBounds(dragRect, width, contentHeight)
    // The content catches up with the size; a left or top edge's move stays
    // on the layer's offset until the release lays it out.
    : resizeRect
      ? { ...rect, width: resizeRect.width, height: resizeRect.height }
      : rect;
  const liveFrame = useLivePaneFrame(live, preview, catchUp ? sizeOf : null);
  const content = (
    <LivePaneFrameContext.Provider value={liveFrame}>
      <FloatingPaneFrame
        {...frame}
        rect={preview}
        zIndex={zIndex}
        frameRef={slide ? frameRef : undefined}
      />
    </LivePaneFrameContext.Provider>
  );
  if (!slide) return content;
  return (
    <Box
      ref={layerRef}
      position="absolute"
      left={0}
      top={0}
      width={0}
      height={0}
      zIndex={zIndex}
    >
      {content}
      {frame.movable && !frame.hidden && (
        <FloatingResizeEdges paneId={paneId} rect={rect} zIndex={zIndex} actions={frame.actions} />
      )}
    </Box>
  );
});

/**
 * A tiled split's divider, which follows the pointer while it is dragged: on
 * the desktop by restyling itself each move, with the dividers inside the
 * split it resizes, in the terminal by redrawing.
 */
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
  const selectDragged = useCallback((geometry: LiveDragGeometry) => (
    geometry.divider?.pathKey === dividerPathKey
  ), [dividerPathKey]);
  const selectRect = useCallback((geometry: LiveDragGeometry) => (
    geometry.divider?.pathKey === dividerPathKey ? geometry.divider.rect : null
  ), [dividerPathKey]);
  const dragged = useLiveDrag(live, selectDragged);
  const previewRect = useLiveDrag(live, nativePaneChrome ? selectNothing : selectRect);
  const boxRef = useRef<BoxRenderable | null>(null);
  const frameOf = useMemo(() => (nativePaneChrome ? (geometry: LiveDragGeometry): LiveBoxFrame | null => {
    const placed = geometry.dock?.dividers.get(dividerPathKey);
    if (placed) return { x: placed.x, y: placed.y, width: placed.width, height: placed.height };
    const at = geometry.divider?.pathKey === dividerPathKey ? geometry.divider.rect : null;
    return at && (at.x !== divider.rect.x || at.y !== divider.rect.y) ? { dx: at.x - divider.rect.x, dy: at.y - divider.rect.y } : null;
  } : null), [divider.rect.x, divider.rect.y, dividerPathKey, nativePaneChrome]);
  useLiveBoxFrame(live, boxRef, frameOf);
  const active = dragged || resizing;
  const rect = previewRect ?? divider.rect;
  return (
    <Box
      ref={boxRef}
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
  dockRoot = null,
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
  handlePaneHelp,
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
  const floatingDragActive = useLiveDrag(live, nativePaneChrome ? selectNoDrag : selectFloatingDragActive);
  const occludedPaneIds = nativePaneChrome || floatingDragActive ? EMPTY_OCCLUSION : coveredPaneIds;
  const fullscreenRect = useMemo(() => ({ x: 0, y: 0, width, height: contentHeight }), [contentHeight, width]);
  // The CSS layout spike, off unless switched on (`ui/css-layout.ts`). Fullscreen keeps main's layers.
  const cssLayout = nativePaneChrome && cssLayoutMode() !== null;
  // Fullscreen keeps the panes where they are in the tree only with anchors; otherwise main's layers draw it.
  const cssDock = cssLayout && dockRoot !== null && (CSS_ANCHORS || !transientFocusActive);
  const leafRects = useMemo(() => new Map(dockLeafLayouts.map((leaf) => [leaf.instanceId, leaf.rect])), [dockLeafLayouts]);
  const dividersByPath = useMemo(() => new Map(dockDividerLayouts.map((divider) => [pathKey(divider.path), divider])), [dockDividerLayouts]);

  const handlersRef = useRef({
    handleFloatingClose,
    handleFloatingCloseMouseDown,
    handleRestoreFullscreen,
    handleNativeDrag,
    handleNativePaneContextMenu,
    handleNativePaneMouseDown,
    handlePaneAction,
    handlePaneHelp,
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
    handlePaneHelp,
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
    floatResizeStart: (paneId, rect, event, edges) => handlersRef.current.startNativeFloatResize(paneId, rect, event, edges),
    drag: (event) => handlersRef.current.handleNativeDrag(event),
    contextMenu: (paneId, rect, event) => handlersRef.current.handleNativePaneContextMenu(paneId, rect, event),
    menu: (paneId, rect, event) => handlersRef.current.handlePaneAction(paneId, rect, event),
    help: (paneId) => handlersRef.current.handlePaneHelp(paneId),
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
      cssLayout,
      getPaneQuickSettings,
      actions,
    };
  };

  return (
    <>
      {cssDock && dockRoot && !transientFocusActive ? (
        <CssDockTree
          width={width}
          height={contentHeight}
          node={dockRoot}
          live={live}
          dividers={dividersByPath}
          resizingPathKey={windowModeDockResizePathKey}
          onDividerMouseDown={actions.dividerDragStart}
          onDrag={actions.drag}
          // With anchors the panes are flat siblings below; without, they render in their slots.
          renderLeaf={CSS_ANCHORS ? null : (instanceId) => {
            const pane = paneMap.get(instanceId);
            const rect = leafRects.get(instanceId);
            return pane && rect ? <CssDockedPaneLayer key={`dock:${instanceId}`} {...layerProps(pane, rect)} /> : null;
          }}
        />
      ) : null}
      {cssDock && CSS_ANCHORS ? dockLeafLayouts.map((leaf) => {
        if (transientFocusActive && leaf.instanceId !== transientFocusPaneId) return null;
        const pane = paneMap.get(leaf.instanceId);
        return pane
          ? <CssDockedPaneLayer key={`dock:${leaf.instanceId}`} {...layerProps(pane, transientFocusActive ? fullscreenRect : leaf.rect)} />
          : null;
      }) : null}
      {cssDock ? null : dockLeafLayouts.map((leaf) => {
        if (transientFocusActive && leaf.instanceId !== transientFocusPaneId) return null;
        const pane = paneMap.get(leaf.instanceId);
        if (!pane) return null;
        return (
          <DockedPaneLayer
            key={`dock:${leaf.instanceId}`}
            {...layerProps(pane, transientFocusActive ? fullscreenRect : leaf.rect)}
            live={live}
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

      {!transientFocusActive && !cssDock && dockDividerLayouts.map((divider) => (
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
