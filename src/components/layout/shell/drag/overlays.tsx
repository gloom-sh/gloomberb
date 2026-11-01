import { useRef, type CSSProperties, type RefObject } from "react";
import { Box, useUiCapabilities, type BoxRenderable, type LiveBoxFrame } from "../../../../ui";
import { colors } from "../../../../theme/colors";
import { SHELL_DRAG_Z, type LayoutBounds } from "../../../../layout/pane-manager";
import type { DragPreview } from "./index";
import { useLiveBoxFrame, useLiveDrag, type LiveDragGeometry, type LiveDragStore } from "./live";
import { placeStyle } from "./slide";

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

export function ShellDragOverlays(props: {
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
 * Terminal: where the release would land is an outline with nothing filled
 * in, so what it is over stays readable.
 */
function TerminalDragOverlays({
  externalDockPreview,
  live,
}: {
  externalDockPreview: DragPreview | null;
  live: LiveDragStore;
}) {
  const dockPreview = useLiveDrag(live, selectDockPreview);
  const effectiveDockPreview = dockPreview ?? externalDockPreview;
  return (
    <>
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
  opacity = 1,
  boxRef,
  follows = false,
}: {
  rect: LayoutBounds | null;
  zIndex: number;
  role: string;
  framed?: boolean;
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
 * Desktop overlays of a pane move: the outline a docked pane drags around and
 * the dock or snap preview. They render when the drop target changes, never
 * on a move: the outline follows the pointer by restyling itself.
 */
function DesktopDragOverlays({
  externalDockPreview,
  live,
}: {
  externalDockPreview: DragPreview | null;
  live: LiveDragStore;
}) {
  const dragging = useLiveDrag(live, selectPaneDragActive);
  if (!dragging && !externalDockPreview) return null;
  return <DesktopDragOverlayLayers externalDockPreview={externalDockPreview} live={live} />;
}

function DesktopDragOverlayLayers({
  externalDockPreview,
  live,
}: {
  externalDockPreview: DragPreview | null;
  live: LiveDragStore;
}) {
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
