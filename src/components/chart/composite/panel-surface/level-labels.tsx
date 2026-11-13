import { Box, Text } from "../../../../ui";
import { layoutLevelLabels, levelLabelStyle, levelLabelText } from "../level-labels";
import { fitAxisLabels, type CompositeChartLevels, type ProjectedLevel } from "../levels";
import type { CompositeAxisDomain } from "../types";
import { usePanelCursor, type PanelCursorView } from "./panel-cursor";

/**
 * A panel's level labels at the plot's right edge, which step aside where the
 * cursor's label covers theirs on the axis. A level's label leaves its value
 * to the axis, unless the cursor's covers it there.
 */
export function PanelLevelLabels({
  view,
  projectedLevels,
  levels,
  levelDomain,
  plotWidth,
  leftAxisWidth,
  rightAxisWidth,
  axisGap,
  leftAxisMarkers,
  rightAxisMarkers,
  measuredPixelHeight,
  background,
  isDesktopWeb,
  cellHeightPx,
  cellWidthPx,
}: {
  view: PanelCursorView;
  projectedLevels: readonly ProjectedLevel[];
  levels: CompositeChartLevels | null;
  levelDomain: CompositeAxisDomain | null;
  plotWidth: number;
  leftAxisWidth: number;
  rightAxisWidth: number;
  axisGap: number;
  leftAxisMarkers: readonly { id?: string }[] | undefined;
  rightAxisMarkers: readonly { id?: string }[] | undefined;
  /** The plot's measured height in px. */
  measuredPixelHeight: number;
  background: string;
  isDesktopWeb: boolean;
  cellHeightPx: number;
  cellWidthPx: number;
}) {
  const { panel } = view;
  const { activeCursorYRatio, scene } = usePanelCursor(view);
  const cursorValues = scene.cursorValues;
  return (
    <>
      {(isDesktopWeb
        ? layoutLevelLabels(projectedLevels, measuredPixelHeight, cellHeightPx)
        : fitAxisLabels(projectedLevels.filter((entry) => entry.level.label), [], (entry) => entry.yRatio * Math.max(1, panel.height - 1))
      ).map((entry) => {
        const { level, yRatio } = entry;
        const axisWidth = levelDomain?.side === "left" ? leftAxisWidth : rightAxisWidth;
        const axisMarkers = levelDomain?.side === "left" ? leftAxisMarkers : rightAxisMarkers;
        const cursorCovers = activeCursorYRatio !== null && Math.abs(activeCursorYRatio - yRatio) * panel.height < 1;
        const axisVisible = !cursorCovers && (level.axisLabel?.length ?? 0) <= axisWidth && !!axisMarkers?.some((marker) => marker.id === level.id);
        // A cursor on a bar at the level's own value (RETURN's on its best
        // day) reads that value on the axis already: the label does not repeat it.
        const cursorReadsLevel = cursorCovers && !!levels
          && cursorValues.some((entry) => entry.seriesId === levels.seriesId && entry.value === level.value);
        const label = levelLabelText(level, axisVisible || cursorReadsLevel);
        const labelStyle = isDesktopWeb ? {
          ...levelLabelStyle(entry, background), left: "auto", right: (rightAxisWidth + (rightAxisWidth ? axisGap : 0) + 1) * cellWidthPx,
          maxWidth: Math.max(1, plotWidth - 2) * cellWidthPx,
        } : undefined;
        const labelWidth = Math.min(plotWidth - 2, label.length + 2);
        return <Box key={`annotation:${level.id}`} position="absolute" left={leftAxisWidth + (leftAxisWidth ? axisGap : 0) + plotWidth - labelWidth - 1} top={yRatio * Math.max(0, panel.height - 1)} height={1}
          width={labelWidth} flexDirection="row" justifyContent="flex-end" backgroundColor={background} zIndex={20}
          style={labelStyle} data-gloom-role="chart-level-label">
          <Text fg={labelStyle?.color ?? level.color} wrapMode="none" style={isDesktopWeb ? { lineHeight: 1 } : undefined}>{label}</Text>
        </Box>;
      })}
    </>
  );
}
