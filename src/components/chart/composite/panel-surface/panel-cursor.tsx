import { useMemo, type ComponentProps, type RefObject } from "react";
import { ChartSurface, Span, Text, useUiCapabilities, type BoxRenderable } from "../../../../ui";
import { useCursorScene, useValueStore, type CompositeCursorSource, type ValueStore } from "../cursor-source";
import type { CompositeAxisValueFormatter } from "../format";
import { writeLevelText, type ProjectedLevel } from "../levels";
import type { useCompositePanelBitmap } from "../panel-bitmap";
import { cursorAxisLabel, resolvePanelCrosshair, resolveSeriesAxisTags, resolveSeriesCursorYRatio } from "../panel-labels";
import { PriceAxisLabels } from "../price-axis-labels";
import { renderCompositePanelCells, type CompositePanelCells } from "../text-renderer";
import type { CompositeAxisSide, CompositePanelScene } from "../types";
import type { KeyboardToolDrag } from "../use-composite-chart-keyboard";
import type { LevelGrab } from "./panel-levels";

export const DESKTOP_PLOT_STYLE = { flex: "1 1 0px", width: "auto", minWidth: 0, height: "auto", alignSelf: "stretch" } as const;
/** Over a level that drags, or while one does: it moves up and down only. */
const DESKTOP_PLOT_LEVEL_STYLE = { ...DESKTOP_PLOT_STYLE, cursor: "ns-resize" } as const;
export const DESKTOP_PLOT_PICK_STYLE = { ...DESKTOP_PLOT_STYLE, cursor: "crosshair" } as const;

/** What a panel's crosshair is read from: everything else in the panel holds still while it moves. */
export interface PanelCursorView {
  panel: CompositePanelScene;
  cursor: CompositeCursorSource;
  pointerY: ValueStore<number | null>;
  keyboardDrag: KeyboardToolDrag | null;
  sharedCursor: boolean;
}

/** The crosshair over a panel, read by the parts that draw it, so a pointer move renders only them. */
export function usePanelCursor({ panel, cursor, pointerY, keyboardDrag, sharedCursor }: PanelCursorView) {
  const scene = useCursorScene(cursor);
  const cursorYRatio = useValueStore(pointerY);
  // A keyboard placement's end sits at the level the user put it, so it
  // draws a level line where otherwise only the pointer would.
  const heldCursorYRatio = keyboardDrag ? keyboardDrag.drag.endYRatio : sharedCursor ? null : cursorYRatio;
  const seriesCursorYRatio = useMemo(
    () => resolveSeriesCursorYRatio(panel, scene),
    [panel, scene],
  );
  return {
    scene,
    cursorYRatio,
    activeCursorYRatio: scene.cursorXRatio === null ? null : heldCursorYRatio ?? seriesCursorYRatio,
    // The chart under the pointer draws both lines: the level line follows the
    // pointer, and its value sits on the axes, beside each series' own tag on
    // the desktop and the web. A keyboard or shared cursor knows its column
    // only, so a chart following another chart's cursor draws the time line
    // alone. A tool placed from the keyboard is the exception: its end is a level.
    pointerCursorYRatio: scene.cursorXRatio === null ? null : heldCursorYRatio,
  };
}

/** The plot, with the crosshair over it and, in a terminal without graphics, the text that draws both. */
export function PanelPlotSurface({
  view,
  plotRef,
  bitmap,
  crosshairColor,
  textColor,
  fallColor,
  textFallback,
  plotWidth,
  projectedLevels,
  selectedLevelId,
  levelGrab,
  ...surface
}: Omit<ComponentProps<typeof ChartSurface>, "ref" | "crosshair" | "children"> & {
  view: PanelCursorView;
  plotRef: RefObject<BoxRenderable | null>;
  bitmap: ReturnType<typeof useCompositePanelBitmap>;
  crosshairColor: string;
  textColor: string;
  /** A falling candle or volume column in a terminal without graphics. */
  fallColor: string;
  textFallback: boolean;
  plotWidth: number;
  projectedLevels: readonly ProjectedLevel[];
  selectedLevelId: string | null;
  levelGrab: LevelGrab;
}) {
  const { panel } = view;
  const { scene, cursorYRatio, pointerCursorYRatio } = usePanelCursor(view);
  const crosshair = useMemo(
    () => resolvePanelCrosshair(panel, bitmap, scene, pointerCursorYRatio, crosshairColor),
    [bitmap, crosshairColor, panel, pointerCursorYRatio, scene],
  );
  const textLines = useMemo(() => {
    if (!textFallback) return [];
    const cells = renderCompositePanelCells(panel, plotWidth, scene.cursorXRatio, pointerCursorYRatio, { negative: fallColor });
    return tintedRuns(cells, writeLevelText(cells.lines, projectedLevels, selectedLevelId));
  }, [fallColor, panel, plotWidth, pointerCursorYRatio, projectedLevels, scene.cursorXRatio, selectedLevelId, textFallback]);
  const grab = typeof levelGrab === "function" ? cursorYRatio !== null && levelGrab(cursorYRatio) : levelGrab;
  return (
    <ChartSurface
      ref={plotRef}
      {...surface}
      style={grab && surface.style ? DESKTOP_PLOT_LEVEL_STYLE : surface.style}
      cursor={grab && surface.cursor ? "ns-resize" : surface.cursor}
      crosshair={crosshair}
    >
      {textLines.map((runs, index) => (
        <Text key={index} fg={textColor}>
          {runs.map((run, at) => (run.color ? <Span key={at} fg={run.color}>{run.text}</Span> : run.text))}
        </Text>
      ))}
    </ChartSurface>
  );
}

/**
 * Each row as runs of one colour: a series' marks in its colour, the rest
 * (and any level drawn over a mark) in the text colour.
 */
function tintedRuns(cells: CompositePanelCells, lines: readonly string[]): Array<Array<{ text: string; color: string | null }>> {
  return lines.map((line, y) => {
    const drawn = Array.from(cells.lines[y] ?? "");
    const runs: Array<{ text: string; color: string | null }> = [];
    Array.from(line).forEach((char, x) => {
      const color = char === drawn[x] ? cells.tints[y]?.[x] ?? null : null;
      const last = runs.at(-1);
      if (last && last.color === color) last.text += char;
      else runs.push({ text: char, color });
    });
    return runs;
  });
}

/** A value axis, with the cursor's value and each series' observation at that time. */
export function PanelValueAxis({
  view,
  formatAxisValue,
  side,
  ...axis
}: Omit<ComponentProps<typeof PriceAxisLabels>, "cursorRow" | "cursorPixelY" | "cursorLabel" | "seriesTags" | "side"> & {
  view: PanelCursorView;
  formatAxisValue?: CompositeAxisValueFormatter;
  side: CompositeAxisSide;
}) {
  const { panel } = view;
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  const { cellHeightPx = 18 } = useUiCapabilities();
  const { scene, activeCursorYRatio, pointerCursorYRatio } = usePanelCursor(view);
  // The pointer's value on the axes follows the level line it belongs to.
  const axisCursorYRatio = isDesktopWeb ? pointerCursorYRatio : activeCursorYRatio;
  const seriesTags = useMemo(
    () => resolveSeriesAxisTags(panel, scene, formatAxisValue).filter((tag) => tag.side === side),
    [formatAxisValue, panel, scene, side],
  );
  const cursorLabel = cursorAxisLabel(panel, side, axisCursorYRatio, formatAxisValue);
  return (
    <PriceAxisLabels
      {...axis}
      side={side}
      cursorRow={activeCursorYRatio === null ? null : Math.round(activeCursorYRatio * Math.max(panel.height - 1, 0))}
      cursorPixelY={activeCursorYRatio === null ? null : activeCursorYRatio * Math.max(panel.height * cellHeightPx - 1, 0)}
      // A keyboard cursor sits on a series' value, which that series' tag already gives in its colour:
      // the terminal rounds the two to rows of their own, and would print the value twice.
      cursorLabel={cursorLabel !== null && seriesTags.some((tag) => tag.label === cursorLabel) ? null : cursorLabel}
      seriesTags={seriesTags}
    />
  );
}
