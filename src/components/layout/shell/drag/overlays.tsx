import { useRef, type CSSProperties, type RefObject } from "react";
import { Box, Text, useUiCapabilities, type BoxRenderable, type LiveBoxFrame } from "../../../../ui";
import { colors } from "../../../../theme/colors";
import { blendHex } from "../../../../theme/color-utils";
import { SHELL_DRAG_Z, type LayoutBounds } from "../../../../layout/pane-manager";
import type { DragPreview } from "./index";
import { useLiveBoxFrame, useLiveDrag, type LiveDragGeometry, type LiveDragStore } from "./live";
import { placeStyle } from "./slide";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../../../theme/font-scale";
import {
  desktopDropZoneMetrics,
  dropStrips,
  dropZoneSquares,
  TERMINAL_DROP_ZONE_METRICS,
  type DropStripEdge,
  type DropZoneSide,
  type DropZoneState,
} from "./drop-zones";

/** Desktop: how opaque a pane on the move is while it is over somewhere to land, so the preview under it shows. */
export const ARMED_DRAG_OPACITY = 0.7;

/** A pane of the layout, or a tab pulled out of a floating stack, moves as an outline. */
function selectDockedOutline(geometry: LiveDragGeometry) {
  const { paneDrag, floating } = geometry;
  return paneDrag && paneDrag.mode !== "floating" && floating?.paneId === paneDrag.paneId ? floating.rect : null;
}

const selectDockPreview = (geometry: LiveDragGeometry) => geometry.dockPreview;
const selectZones = (geometry: LiveDragGeometry) => geometry.zones;
const selectPaneDragActive = (geometry: LiveDragGeometry) => geometry.paneDrag !== null;
const selectOutlineWidth = (geometry: LiveDragGeometry) => selectDockedOutline(geometry)?.width ?? null;
const selectOutlineHeight = (geometry: LiveDragGeometry) => selectDockedOutline(geometry)?.height ?? null;

export function ShellDragOverlays(props: {
  /** A pane from another window over this one's edge. */
  externalDockPreview: DragPreview | null;
  live: LiveDragStore;
  /** The shell's content area, whose edges have the strips that put a pane along them. */
  area: LayoutBounds;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  return nativePaneChrome ? <DesktopDragOverlays {...props} /> : <TerminalDragOverlays {...props} />;
}

const ZONE_SIDES: readonly DropZoneSide[] = ["center", "left", "right", "top", "bottom"];
const STRIP_EDGES: readonly DropStripEdge[] = ["left", "right", "top", "bottom"];

/** A pane of the layout on the move is drawn as an outline at its floating size, until it is over a target. */
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
 * in, so what it is over stays readable; the targets sit over it.
 */
function TerminalDragOverlays({
  externalDockPreview,
  live,
  area,
}: {
  externalDockPreview: DragPreview | null;
  live: LiveDragStore;
  area: LayoutBounds;
}) {
  const dockPreview = useLiveDrag(live, selectDockPreview);
  const dragging = useLiveDrag(live, selectPaneDragActive);
  const effectiveDockPreview = dockPreview ?? externalDockPreview;
  return (
    <>
      {dragging && <TerminalDropTargets live={live} area={area} />}

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

/** What a square of the target shows of the pane it lands in: all of it for a tab, a half for a side. */
const TERMINAL_ZONE_GLYPHS: Record<DropZoneSide, string> = {
  center: "█",
  left: "▌",
  right: "▐",
  top: "▀",
  bottom: "▄",
};

/**
 * Terminal: how much of the accent tints a target, at rest and under the
 * pointer. The desktop's tint is lighter (styles.css) because its targets
 * also have an accent border; a strip here is a single cell with none.
 */
const TERMINAL_TARGET_TINT = { rest: 0.25, lit: 0.55 } as const;

/** `hex` (#rrggbb) at `alpha`: the terminal blends it over the cells under it and keeps their text. */
function translucent(hex: string, alpha: number): string {
  return `${hex.slice(0, 7)}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

/**
 * Terminal: the targets a pane on the move can land on, drawn in cells while
 * it moves, as the desktop draws them: the window's outermost cells (a strip
 * along each edge, tinted so what is under it still reads) and, on the pane
 * under the pointer, the five squares of its target, each three cells wide.
 * The one under the pointer is tinted stronger and its mark drawn full.
 */
function TerminalDropTargets({ live, area }: { live: LiveDragStore; area: LayoutBounds }) {
  const zones: DropZoneState | null = useLiveDrag(live, selectZones);
  const strips = dropStrips(area, TERMINAL_DROP_ZONE_METRICS);
  const squares = zones?.host ? dropZoneSquares(zones.host.rect, TERMINAL_DROP_ZONE_METRICS) : null;
  const accent = colors.borderFocused;
  const rest = blendHex(colors.bg, accent, TERMINAL_TARGET_TINT.rest);
  const lit = blendHex(colors.bg, accent, TERMINAL_TARGET_TINT.lit);
  return (
    <>
      {STRIP_EDGES.map((edge) => (
        <Box
          key={`strip:${edge}`}
          position="absolute"
          left={strips[edge].x}
          top={strips[edge].y}
          width={strips[edge].width}
          height={strips[edge].height}
          zIndex={SHELL_DRAG_Z.targets}
          backgroundColor={translucent(accent, zones?.edge === edge ? TERMINAL_TARGET_TINT.lit : TERMINAL_TARGET_TINT.rest)}
        />
      ))}
      {squares && (
        // The cells between the squares across, so the target reads as one.
        <Box
          position="absolute"
          left={squares.left.x}
          top={squares.left.y}
          width={squares.right.x + squares.right.width - squares.left.x}
          height={squares.left.height}
          zIndex={SHELL_DRAG_Z.targets}
          backgroundColor={colors.bg}
        />
      )}
      {squares && ZONE_SIDES.map((side) => {
        const active = zones?.side === side;
        return (
          <Box
            key={`zone:${side}`}
            position="absolute"
            left={squares[side].x}
            top={squares[side].y}
            width={squares[side].width}
            height={squares[side].height}
            zIndex={SHELL_DRAG_Z.targets}
            flexDirection="row"
            backgroundColor={active ? lit : rest}
          >
            <Text fg={accent} selectable={false}>[</Text>
            <Text fg={active ? accent : colors.textDim} selectable={false}>{TERMINAL_ZONE_GLYPHS[side]}</Text>
            <Text fg={accent} selectable={false}>]</Text>
          </Box>
        );
      })}
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
  area,
}: {
  externalDockPreview: DragPreview | null;
  live: LiveDragStore;
  area: LayoutBounds;
}) {
  const dragging = useLiveDrag(live, selectPaneDragActive);
  if (!dragging && !externalDockPreview) return null;
  return (
    <>
      <DesktopDragOverlayLayers externalDockPreview={externalDockPreview} live={live} />
      {dragging && <DesktopDropTargets live={live} area={area} />}
    </>
  );
}

/** Where a box at `rect` (cells) sits, in px from the shell's corner. */
function pxStyle(rect: LayoutBounds): CSSProperties {
  return {
    ...placeStyle(rect.x, rect.y),
    width: rect.width * WEB_CELL_WIDTH,
    height: rect.height * WEB_CELL_HEIGHT,
    pointerEvents: "none",
  };
}

/**
 * Desktop: the targets a pane on the move can land on, drawn while it moves.
 * A strip along each edge of the window (along that whole edge of the
 * layout), and on the pane under the pointer a target of five squares (its
 * centre a tab there, a side a split of that pane on that side); the one
 * under the pointer lit. They render when what the pointer is over changes,
 * never on a move.
 */
function DesktopDropTargets({ live, area }: { live: LiveDragStore; area: LayoutBounds }) {
  const zones: DropZoneState | null = useLiveDrag(live, selectZones);
  const metrics = desktopDropZoneMetrics({ width: WEB_CELL_WIDTH, height: WEB_CELL_HEIGHT });
  const strips = dropStrips(area, metrics);
  const squares = zones?.host ? dropZoneSquares(zones.host.rect, metrics) : null;
  return (
    <>
      {STRIP_EDGES.map((edge) => (
        <Box
          key={`strip:${edge}`}
          position="absolute"
          left={0}
          top={0}
          zIndex={SHELL_DRAG_Z.targets}
          data-gloom-role="drop-strip"
          data-edge={edge}
          data-active={zones?.edge === edge ? "true" : "false"}
          style={pxStyle(strips[edge])}
        />
      ))}
      {squares && ZONE_SIDES.map((side) => (
        <Box
          key={`zone:${side}`}
          position="absolute"
          left={0}
          top={0}
          zIndex={SHELL_DRAG_Z.targets}
          data-gloom-role="drop-zone"
          data-side={side}
          data-active={zones?.side === side ? "true" : "false"}
          style={pxStyle(squares[side])}
        />
      ))}
    </>
  );
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
