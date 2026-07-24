import { Box, Text, useUiCapabilities } from "../../../../ui";
import { blendHex, colors } from "../../../../theme/colors";
import type { FloatingRect } from "../../../../plugins/pane-manager";
import {
  LAYOUT_GRID_COLUMNS,
  LAYOUT_GRID_ROWS,
  makeLayoutGridCells,
  type DragPreview,
  type HoverOverlay,
} from "./index";

export function ShellLayoutGridOverlay({
  excludedRows = [],
  height,
  width,
}: {
  excludedRows?: number[];
  height: number;
  width: number;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const cells = makeLayoutGridCells(width, height);

  if (nativePaneChrome) {
    return (
      <Box
        position="absolute"
        left={0}
        top={0}
        width={width}
        height={height}
        zIndex={90}
        data-gloom-role="layout-grid-overlay"
        data-columns={LAYOUT_GRID_COLUMNS}
        data-rows={LAYOUT_GRID_ROWS}
        style={{
          pointerEvents: "none",
          opacity: 0.38,
          backgroundImage: [
            `linear-gradient(to right, ${blendHex(colors.bg, colors.borderFocused, 0.42)} 1px, transparent 1px)`,
            `linear-gradient(to bottom, ${blendHex(colors.bg, colors.borderFocused, 0.34)} 1px, transparent 1px)`,
          ].join(", "),
          backgroundSize: `${100 / LAYOUT_GRID_COLUMNS}% ${100 / LAYOUT_GRID_ROWS}%`,
        }}
      />
    );
  }

  const lineColor = blendHex(colors.bg, colors.borderFocused, 0.42);
  const excluded = new Set(excludedRows.flatMap((row) => {
    const headerRow = Math.floor(row);
    return [headerRow - 1, headerRow, headerRow + 1];
  }));
  const verticalLines = [...new Set(cells.map((cell) => cell.rect.x))].filter((x) => x > 0);
  const horizontalLines = [...new Set(cells.map((cell) => cell.rect.y))]
    .filter((y) => y > 0 && !excluded.has(y));
  return (
    <Box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      zIndex={90}
      data-gloom-role="layout-grid-overlay"
      data-columns={LAYOUT_GRID_COLUMNS}
      data-rows={LAYOUT_GRID_ROWS}
    >
      {verticalLines.map((x) => (
        Array.from({ length: Math.max(1, Math.floor(height)) }, (_, y) => (
          excluded.has(y) ? null : (
            <Box key={`grid-v:${x}:${y}`} position="absolute" left={x} top={y} width={1} height={1}>
              <Text fg={lineColor} selectable={false}>┊</Text>
            </Box>
          )
        ))
      ))}
      {horizontalLines.map((y) => (
        <Box key={`grid-h:${y}`} position="absolute" left={0} top={y} width={width} height={1}>
          <Text fg={lineColor} selectable={false}>{"┄".repeat(Math.max(1, Math.floor(width)))}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function ShellDragOverlays({
  activeHoverOverlay,
  activePaneDrag,
  dockPreview,
  dragFloatingRect,
  effectiveDockPreview,
  gridHeight,
  gridWidth,
  gridExcludedRows,
  showGrid,
}: {
  activeHoverOverlay: HoverOverlay | null;
  activePaneDrag: { paneId: string; mode: "docked" | "floating" } | null;
  dockPreview: DragPreview | null;
  dragFloatingRect: { paneId: string; rect: FloatingRect } | null;
  effectiveDockPreview: DragPreview | null;
  gridHeight: number;
  gridWidth: number;
  gridExcludedRows?: number[];
  showGrid: boolean;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  return (
    <>
      {showGrid && <ShellLayoutGridOverlay width={gridWidth} height={gridHeight} excludedRows={gridExcludedRows} />}

      {activeHoverOverlay && activeHoverOverlay.cells.map((cell) => {
        const active = dockPreview?.kind === "dock"
          && dockPreview.target.kind === "leaf"
          && dockPreview.target.targetId === activeHoverOverlay.targetId
          && dockPreview.target.position === cell.position;
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

      {activePaneDrag
        && activePaneDrag.mode === "docked"
        && dragFloatingRect?.paneId === activePaneDrag.paneId
        && !effectiveDockPreview
        && (
          <Box
            position="absolute"
            left={dragFloatingRect.rect.x}
            top={dragFloatingRect.rect.y}
            width={dragFloatingRect.rect.width}
            height={dragFloatingRect.rect.height}
            border
            borderStyle="single"
            borderColor={colors.borderFocused}
            backgroundColor={colors.panel}
            zIndex={95}
          />
        )}

      {effectiveDockPreview && effectiveDockPreview.rects.map((preview, index) => (
        <Box
          key={`drag-preview:${preview.instanceId}`}
          id={`drag-preview:${preview.instanceId}`}
          position="absolute"
          left={preview.rect.x}
          top={preview.rect.y}
          width={preview.rect.width}
          height={preview.rect.height}
          border
          borderStyle="single"
          borderColor={colors.borderFocused}
          backgroundColor={effectiveDockPreview.kind === "snap" && index === 0 ? colors.header : colors.panel}
          zIndex={96}
          data-gloom-role={effectiveDockPreview.kind === "snap" && index === 0 ? "grid-snap-placeholder" : "dock-preview"}
          data-preview-pane-id={preview.instanceId}
          data-snap-position={effectiveDockPreview.kind === "snap" && index === 0 ? effectiveDockPreview.position : undefined}
          style={nativePaneChrome && effectiveDockPreview.kind === "snap" && index === 0 ? {
            pointerEvents: "none",
            backgroundColor: blendHex(colors.panel, colors.borderFocused, 0.24),
            border: `2px solid ${colors.borderFocused}`,
            boxShadow: `inset 0 0 0 1px ${blendHex(colors.borderFocused, colors.textBright, 0.35)}`,
          } : undefined}
        />
      ))}
    </>
  );
}
