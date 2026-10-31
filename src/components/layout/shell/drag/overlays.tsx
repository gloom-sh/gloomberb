import { useRef, type CSSProperties, type RefObject } from "react";
import { Box, useUiCapabilities, type BoxRenderable, type LiveBoxFrame } from "../../../../ui";
import { colors } from "../../../../theme/colors";
import { SHELL_DRAG_Z, type DockLeafLayout, type LayoutBounds } from "../../../../layout/pane-manager";
import type { DragPreview, HoverOverlay } from "./index";
import { useLiveBoxFrame, useLiveDrag, useLiveHoverOverlay, type LiveDragGeometry, type LiveDragStore } from "./live";
import { placeStyle } from "./slide";

const CELL_POSITIONS = ["top", "left", "center", "right", "bottom"] as const;

/** Desktop: how opaque a pane on the move is while it is over somewhere to land, so the preview under it shows. */
export const ARMED_DRAG_OPACITY = 0.7;

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
      zIndex={SHELL_DRAG_Z.under}
    />
  );
}

/**
 * Terminal: the drop grid and where the release would land are outlines with
 * nothing filled in, so what they are over stays readable.
 */
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
            zIndex={cell.position === "center" ? SHELL_DRAG_Z.centerCell : SHELL_DRAG_Z.cell}
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
          zIndex={SHELL_DRAG_Z.over}
        />
      )}
    </>
  );
}

/**
 * Desktop: an overlay laid out at the shell's corner and drawn at `rect` by a
 * transform, hidden by opacity, so a new drop target restyles it in place.
 * `framed` draws the border and fill of a pane (the outline a docked pane
 * drags around); without it, styles.css draws the box by its role.
 */
function OverlayBox({
  rect,
  zIndex,
  role,
  framed = false,
  active,
  opacity = 1,
  boxRef,
  follows = false,
}: {
  rect: LayoutBounds | null;
  zIndex: number;
  role: string;
  framed?: boolean;
  active?: boolean;
  opacity?: number;
  boxRef?: RefObject<BoxRenderable | null>;
  /** Its position follows the pointer outside React (`useLiveBoxFrame`). */
  follows?: boolean;
}) {
  const style: CSSProperties = {
    ...(rect && !follows ? placeStyle(rect.x, rect.y) : undefined),
    opacity: rect ? opacity : 0,
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
      {...(framed ? {
        border: true,
        borderStyle: "single",
        borderColor: colors.borderFocused,
        backgroundColor: colors.panel,
      } : {})}
      zIndex={zIndex}
      data-gloom-role={role}
      data-active={active === undefined ? undefined : active ? "true" : "false"}
      style={style}
    />
  );
}

/**
 * Desktop: where a pane would land. The exact rectangle, outlined in the
 * accent over a light tint of it (styles.css), so the panes under it still
 * show; window mode's keyboard move draws the same.
 */
export function DesktopDropPreview({
  rect,
  zIndex,
  role = "drop-preview",
  attributes,
}: {
  rect: LayoutBounds | null;
  zIndex: number;
  role?: string;
  attributes?: Record<string, string>;
}) {
  return (
    <Box
      position="absolute"
      left={0}
      top={0}
      width={rect?.width ?? 0}
      height={rect?.height ?? 0}
      zIndex={zIndex}
      data-gloom-role={role}
      {...attributes}
      style={{
        ...(rect ? placeStyle(rect.x, rect.y) : undefined),
        opacity: rect ? 1 : 0,
        pointerEvents: "none",
      }}
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
  const outline = outlineWidth !== null && outlineHeight !== null
    ? { x: 0, y: 0, width: outlineWidth, height: outlineHeight }
    : null;
  return (
    <>
      {CELL_POSITIONS.map((position) => {
        const cell = activeHoverOverlay?.cells.find((entry) => entry.position === position) ?? null;
        const active = !!activeHoverOverlay && isActiveCell(dockPreview, activeHoverOverlay, position);
        return (
          <OverlayBox
            key={position}
            role="drop-cell"
            rect={cell?.rect ?? null}
            active={active}
            zIndex={position === "center" ? SHELL_DRAG_Z.centerCell : SHELL_DRAG_Z.cell}
          />
        );
      })}
      {/* The preview sits under what is moving, which turns see-through over it. */}
      <DesktopDropPreview rect={effectiveDockPreview?.rect ?? null} zIndex={SHELL_DRAG_Z.under} />
      <OverlayBox
        role="drag-outline"
        rect={outline}
        zIndex={SHELL_DRAG_Z.over}
        framed
        opacity={effectiveDockPreview ? ARMED_DRAG_OPACITY : 1}
        boxRef={outlineRef}
        follows
      />
    </>
  );
}

/** The docked pane's outline sits where the drag has it; laid out at the shell's corner. */
function followDockedOutline(geometry: LiveDragGeometry): LiveBoxFrame | null {
  const rect = selectDockedOutline(geometry);
  return rect ? { dx: rect.x, dy: rect.y } : null;
}
