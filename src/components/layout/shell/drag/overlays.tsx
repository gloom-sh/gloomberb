import { useRef, type CSSProperties, type RefObject } from "react";
import { Box, useUiCapabilities, type BoxRenderable, type LiveBoxFrame } from "../../../../ui";
import { colors } from "../../../../theme/colors";
import type { DockLeafLayout, LayoutBounds } from "../../../../layout/pane-manager";
import type { DragPreview, HoverOverlay } from "./index";
import { useLiveBoxFrame, useLiveDrag, useLiveHoverOverlay, type LiveDragGeometry, type LiveDragStore } from "./live";
import { placeStyle } from "./slide";

const CELL_POSITIONS = ["top", "left", "center", "right", "bottom"] as const;

function selectDockedOutline(geometry: LiveDragGeometry) {
  const { paneDrag, floating } = geometry;
  return paneDrag?.mode === "docked" && floating?.paneId === paneDrag.paneId ? floating.rect : null;
}

const selectDockPreview = (geometry: LiveDragGeometry) => geometry.dockPreview;
const selectPaneDragActive = (geometry: LiveDragGeometry) => geometry.paneDrag !== null;
const selectOutlineWidth = (geometry: LiveDragGeometry) => selectDockedOutline(geometry)?.width ?? null;
const selectOutlineHeight = (geometry: LiveDragGeometry) => selectDockedOutline(geometry)?.height ?? null;

function isActiveCell(dockPreview: DragPreview | null, overlay: HoverOverlay, position: string): boolean {
  return dockPreview?.kind === "dock"
    && dockPreview.target.kind === "leaf"
    && dockPreview.target.targetId === overlay.targetId
    && dockPreview.target.position === position;
}

export function ShellDragOverlays(props: {
  dockLeafLayouts: DockLeafLayout[];
  /** A pane from another window over this one's edge. */
  externalDockPreview: DragPreview | null;
  live: LiveDragStore;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  return nativePaneChrome ? <DesktopDragOverlays {...props} /> : <TerminalDragOverlays {...props} />;
}

/** A docked pane on the move is drawn as an outline at its floating size, until it is over a drop target. */
function TerminalDockedDragOutline({ live }: { live: LiveDragStore }) {
  const rect = useLiveDrag(live, selectDockedOutline);
  if (!rect) return null;
  return (
    <Box
      position="absolute"
      left={rect.x}
      top={rect.y}
      width={rect.width}
      height={rect.height}
      border
      borderStyle="single"
      borderColor={colors.borderFocused}
      backgroundColor={colors.panel}
      zIndex={95}
    />
  );
}

function TerminalDragOverlays({
  dockLeafLayouts,
  externalDockPreview,
  live,
}: {
  dockLeafLayouts: DockLeafLayout[];
  externalDockPreview: DragPreview | null;
  live: LiveDragStore;
}) {
  const activeHoverOverlay = useLiveHoverOverlay(live, dockLeafLayouts);
  const dockPreview = useLiveDrag(live, selectDockPreview);
  const effectiveDockPreview = dockPreview ?? externalDockPreview;
  return (
    <>
      {activeHoverOverlay && activeHoverOverlay.cells.map((cell) => {
        const active = isActiveCell(dockPreview, activeHoverOverlay, cell.position);
        return (
          <Box
            key={`cell:${activeHoverOverlay.targetId}:${cell.position}`}
            position="absolute"
            left={cell.rect.x}
            top={cell.rect.y}
            width={cell.rect.width}
            height={cell.rect.height}
            border
            borderStyle="single"
            borderColor={active ? colors.borderFocused : colors.border}
            backgroundColor={active ? colors.header : colors.panel}
            zIndex={cell.position === "center" ? 98 : 97}
          />
        );
      })}

      {!effectiveDockPreview && <TerminalDockedDragOutline live={live} />}

      {effectiveDockPreview && (
        <Box
          position="absolute"
          left={effectiveDockPreview.rect.x}
          top={effectiveDockPreview.rect.y}
          width={effectiveDockPreview.rect.width}
          height={effectiveDockPreview.rect.height}
          border
          borderStyle="single"
          borderColor={colors.borderFocused}
          backgroundColor={colors.panel}
          zIndex={96}
        />
      )}
    </>
  );
}

/**
 * Desktop: an outline laid out at the shell's corner and drawn at `rect` by a
 * transform, hidden by opacity, so a new drop target restyles it in place.
 */
function OutlineBox({
  rect,
  zIndex,
  borderColor = colors.borderFocused,
  backgroundColor = colors.panel,
  role,
  boxRef,
  follows = false,
}: {
  rect: LayoutBounds | null;
  zIndex: number;
  borderColor?: string;
  backgroundColor?: string;
  role: string;
  boxRef?: RefObject<BoxRenderable | null>;
  /** Its position follows the pointer outside React (`useLiveBoxFrame`). */
  follows?: boolean;
}) {
  const style: CSSProperties = {
    ...(rect && !follows ? placeStyle(rect.x, rect.y) : undefined),
    opacity: rect ? 1 : 0,
    pointerEvents: "none",
  };
  return (
    <Box
      ref={boxRef}
      position="absolute"
      left={0}
      top={0}
      width={rect?.width ?? 0}
      height={rect?.height ?? 0}
      border
      borderStyle="single"
      borderColor={borderColor}
      backgroundColor={backgroundColor}
      zIndex={zIndex}
      data-gloom-role={role}
      style={style}
    />
  );
}

/**
 * Desktop overlays of a pane move: the outline a docked pane drags around, the
 * drop grid of the pane under the pointer and the dock or snap preview. They
 * render when the drop target changes, never on a move: the outline follows
 * the pointer by restyling itself.
 */
function DesktopDragOverlays({
  dockLeafLayouts,
  externalDockPreview,
  live,
}: {
  dockLeafLayouts: DockLeafLayout[];
  externalDockPreview: DragPreview | null;
  live: LiveDragStore;
}) {
  const dragging = useLiveDrag(live, selectPaneDragActive);
  if (!dragging && !externalDockPreview) return null;
  return <DesktopDragOverlayLayers dockLeafLayouts={dockLeafLayouts} externalDockPreview={externalDockPreview} live={live} />;
}

function DesktopDragOverlayLayers({
  dockLeafLayouts,
  externalDockPreview,
  live,
}: {
  dockLeafLayouts: DockLeafLayout[];
  externalDockPreview: DragPreview | null;
  live: LiveDragStore;
}) {
  const activeHoverOverlay = useLiveHoverOverlay(live, dockLeafLayouts);
  const dockPreview = useLiveDrag(live, selectDockPreview);
  const effectiveDockPreview = dockPreview ?? externalDockPreview;
  const outlineWidth = useLiveDrag(live, selectOutlineWidth);
  const outlineHeight = useLiveDrag(live, selectOutlineHeight);
  const outlineRef = useRef<BoxRenderable | null>(null);
  useLiveBoxFrame(live, outlineRef, followDockedOutline);
  const outline = outlineWidth !== null && outlineHeight !== null && !effectiveDockPreview
    ? { x: 0, y: 0, width: outlineWidth, height: outlineHeight }
    : null;
  return (
    <>
      {CELL_POSITIONS.map((position) => {
        const cell = activeHoverOverlay?.cells.find((entry) => entry.position === position) ?? null;
        const active = !!activeHoverOverlay && isActiveCell(dockPreview, activeHoverOverlay, position);
        return (
          <OutlineBox
            key={position}
            role="drop-cell"
            rect={cell?.rect ?? null}
            borderColor={active ? colors.borderFocused : colors.border}
            backgroundColor={active ? colors.header : colors.panel}
            zIndex={position === "center" ? 98 : 97}
          />
        );
      })}
      <OutlineBox role="drag-outline" rect={outline} zIndex={95} boxRef={outlineRef} follows />
      <OutlineBox role="drop-preview" rect={effectiveDockPreview?.rect ?? null} zIndex={96} />
    </>
  );
}

/** The docked pane's outline sits where the drag has it; laid out at the shell's corner. */
function followDockedOutline(geometry: LiveDragGeometry): LiveBoxFrame | null {
  const rect = selectDockedOutline(geometry);
  return rect ? { dx: rect.x, dy: rect.y } : null;
}
