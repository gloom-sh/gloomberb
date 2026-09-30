import { useMemo } from "react";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import { useThemeColors } from "../../../theme/theme-context";
import { blendHex } from "../../../theme/color-utils";
import type { ResolvedSeries } from "../../../time-series/types";
import { displayWidth } from "../../../utils/format";
import { CompositeChart } from "../composite/composite-chart";
import { buildCompositeChartScene, projectCompositeValue, resizeCompositePanel } from "../composite/scene";
import { compositeAxisTickLabels, renderCompositeAxisText, renderCompositePanelText } from "../composite/text-renderer";
import type { CompositePanelScene } from "../composite/types";
import { scalarPoint, staticSeries } from "./series";
import { buildTrailChart, trailAxisTicks, type ScatterTrail } from "./trail-chart-model";

/** How far a trail behind the selected one fades toward the background. */
const TRAIL_FADE = 0.55;

const PANELS = [{ id: "main" }];
/** The model's 100/100 lines, and the single-point anchors that stand in for them in cells. */
const isOrigin = (id: string) => id.startsWith("horizontal-origin") || id.startsWith("vertical-origin");
const axisValue = (value: number) => value.toFixed(1);
/** x is strength, not time: a custom axis keeps the last point at the right edge. The row below draws it. */
const STRENGTH_AXIS = { ticks: [] };

type Tone = "text" | "dim" | "muted" | "positive" | "negative" | "warning";

/** One label the overlay draws over the plot, in plot cells. */
interface TrailOverlayLabel {
  id: string;
  text: string;
  x: number;
  y: number;
  color?: string;
  tone?: Tone;
  bold?: boolean;
}

export interface TrailOverlayLayout {
  labels: TrailOverlayLabel[];
  /** Box-line cells in plot cells nothing else uses: the 100/100 crosshair and the cursor; a blank erases. */
  lines: Array<{ x: number; y: number; char: string; cursor: boolean }>;
}

interface HeadLabel {
  id: string;
  text: string;
  x: number;
  y: number;
  color: string;
  bold?: boolean;
}

const isBlank = (char: string | undefined) => char === undefined || char === " " || char === "·";

/**
 * Where the overlay draws, given the plot as the text renderer draws it: each
 * trail head's symbol beside it (never over another label or head, over as
 * few trail marks as it can), the momentum axis's name at the top of its line
 * and the quadrant names in the corners where the trails leave room, then the
 * 100/100 crosshair and the cursor as box lines in the cells nothing else uses.
 */
export function layoutTrailOverlay({ marks, heads, centerX, centerY, cursorX = null, anchors = [], yName, quadrants }: {
  /** The plot's rows as the trails draw them, one char per cell. */
  marks: readonly string[];
  /** The selected head first: earlier heads get the better places. */
  heads: readonly HeadLabel[];
  centerX: number;
  centerY: number;
  /** The selected head's column. */
  cursorX?: number | null;
  /** Cells the chart marks only to keep 100 in the middle: always covered. */
  anchors?: ReadonlyArray<{ x: number; y: number }>;
  yName: string;
  quadrants: ReadonlyArray<{ text: string; tone: Tone; corner: "tl" | "tr" | "bl" | "br" }>;
}): TrailOverlayLayout {
  const height = marks.length;
  const width = marks[0]?.length ?? 0;
  const cells = marks.map((row) => [...row]);
  const taken = Array.from({ length: height }, () => Array<boolean>(width).fill(false));
  const headCells = new Set(heads.map((head) => `${head.x}:${head.y}`));
  const labels: TrailOverlayLabel[] = [];
  const inside = (x: number, y: number, length: number) => y >= 0 && y < height && x >= 0 && x + length <= width;
  // Labels keep a blank cell from each other on their row, so two symbols never read as one.
  const free = (x: number, y: number, length: number) => {
    for (let column = x - 1; column <= x + length; column += 1) {
      if (taken[y]?.[column]) return false;
    }
    for (let column = x; column < x + length; column += 1) {
      if (headCells.has(`${column}:${y}`)) return false;
    }
    return true;
  };
  const covered = (x: number, y: number, length: number) => {
    let count = 0;
    for (let column = x; column < x + length; column += 1) if (!isBlank(cells[y]?.[column])) count += 1;
    return count;
  };
  const take = (label: TrailOverlayLabel) => {
    const length = displayWidth(label.text);
    for (let column = label.x; column < label.x + length; column += 1) taken[label.y]![column] = true;
    labels.push(label);
  };

  // Heads that land in one cell share one label, the first (the selected) head's
  // name leading, so no name sits beside a cell another head is drawn in.
  const byCell = new Map<string, HeadLabel[]>();
  for (const head of heads) {
    const key = `${head.x}:${head.y}`;
    byCell.set(key, [...(byCell.get(key) ?? []), head]);
  }
  for (const group of byCell.values()) {
    const head = group.length === 1 ? group[0]! : { ...group[0]!, text: group.map((entry) => entry.text).join("/") };
    const length = displayWidth(head.text);
    const half = Math.floor(length / 2);
    const candidates = [
      [head.x + 1, head.y], [head.x - length, head.y],
      [head.x - half, head.y - 1], [head.x - half, head.y + 1],
      [head.x + 1, head.y - 1], [head.x + 1, head.y + 1],
      [head.x - length, head.y - 1], [head.x - length, head.y + 1],
    ] as const;
    // A label that touches another head on its row would read as that head's.
    const touchesOther = (x: number, y: number) => [x - 1, x + length].some((column) => (
      headCells.has(`${column}:${y}`) && !(column === head.x && y === head.y)
    ));
    let best: { x: number; y: number; cost: number } | null = null;
    candidates.forEach(([x, y], index) => {
      if (!inside(x, y, length) || !free(x, y, length) || touchesOther(x, y)) return;
      const cost = covered(x, y, length) * candidates.length + index;
      if (!best || cost < best.cost) best = { x, y, cost };
    });
    if (best) {
      const { x, y } = best;
      take({ id: head.id, text: head.text, x, y, color: head.color, bold: head.bold });
    }
  }

  // Orientation comes after the data: it goes only where no trail or label is.
  const clear = (x: number, y: number, text: string) => {
    const length = displayWidth(text);
    return inside(x, y, length) && free(x, y, length) && covered(x, y, length) === 0;
  };
  // The momentum axis is named at the top of its line, or beside it.
  const yText = `↑ ${yName}`;
  const yAt = ([[centerX, 0], [centerX - displayWidth(yText) + 1, 0], [centerX, 1]] as const)
    .map(([x, y]) => ({ x, y, text: x === centerX ? yText : `${yName} ↑` }))
    .find(({ x, y, text }) => clear(x, y, text));
  if (yAt) take({ id: "y-name", ...yAt, tone: "dim" });
  for (const quadrant of quadrants) {
    const length = displayWidth(quadrant.text);
    // A cell short of the right edge, so a name never runs into the momentum ticks.
    const x = quadrant.corner === "tl" || quadrant.corner === "bl" ? 0 : width - length - 1;
    const rows = quadrant.corner === "tl" || quadrant.corner === "tr" ? [0, 1] : [height - 1, height - 2];
    const y = rows.find((row) => clear(x, row, quadrant.text));
    if (y !== undefined) take({ id: `quadrant-${quadrant.corner}`, text: quadrant.text, x, y, tone: quadrant.tone });
  }

  const lines: TrailOverlayLayout["lines"] = [];
  const line = (x: number, y: number, char: string, cursor = false) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    if (taken[y]![x] || !isBlank(cells[y]![x])) return;
    lines.push({ x, y, char, cursor });
  };
  if (cursorX !== null) {
    for (let y = 0; y < height; y += 1) line(cursorX, y, y === centerY ? "┼" : "│", true);
  }
  // A cursor within a cell of 100 stands in for the vertical line rather than doubling it.
  const vertical = cursorX === null || Math.abs(cursorX - centerX) > 1;
  for (let x = 0; x < width; x += 1) {
    if (x !== cursorX) line(x, centerY, x === centerX && vertical ? "┼" : "─");
  }
  if (vertical) {
    for (let y = 0; y < height; y += 1) if (y !== centerY) line(centerX, y, "│");
  }
  const drawn = new Set(lines.map(({ x, y }) => `${x}:${y}`));
  for (const anchor of anchors) {
    if (!drawn.has(`${anchor.x}:${anchor.y}`)) line(anchor.x, anchor.y, " ");
  }
  return { labels, lines };
}

/**
 * The strength axis row: the cursor's reading where its column meets the row,
 * the axis name at the right end, then whichever round ticks still fit, each a
 * cell clear of the next.
 */
export function layoutTrailAxis({ width, ticks, name, readout }: {
  width: number;
  /** Round values and the column each marks. */
  ticks: ReadonlyArray<{ label: string; x: number }>;
  name: string;
  readout: { label: string; x: number } | null;
}): Array<{ text: string; left: number; kind: "readout" | "name" | "tick" }> {
  const placed: Array<{ text: string; left: number; kind: "readout" | "name" | "tick" }> = [];
  const fits = (left: number, length: number) => left >= 0 && left + length <= width
    && placed.every((item) => left + length < item.left || left > item.left + displayWidth(item.text));
  const place = (text: string, left: number, kind: "readout" | "name" | "tick") => {
    if (fits(left, displayWidth(text))) placed.push({ text, left, kind });
  };
  const centered = (text: string, x: number) =>
    Math.max(0, Math.min(width - displayWidth(text), x - Math.floor(displayWidth(text) / 2)));
  if (readout) place(readout.label, centered(readout.label, readout.x), "readout");
  place(name, width - displayWidth(name), "name");
  for (const tick of ticks) place(tick.label, centered(tick.label, tick.x), "tick");
  return placed;
}

/**
 * Relative rotation trails over a 100/100 crosshair: strength across,
 * momentum up. Each trail head carries its symbol, so the chart reads without
 * colour; the selected trail keeps its colour and the cursor, which reads its
 * strength under the plot and its momentum beside it.
 */
export function ScatterTrailSurface({
  trails,
  width,
  height,
  center = 100,
  selectedId,
  fadeOthers = true,
  xLabel = "Strength",
  yLabel = "Momentum",
}: {
  trails: ScatterTrail[];
  width: number;
  height: number;
  center?: number;
  selectedId?: string | null;
  /**
   * Fade the other trails behind the selected one. Off while the selection is
   * only the table's default cursor, so the chart opens with every trail in
   * its colour.
   */
  fadeOthers?: boolean;
  /** The table's words for the axes. */
  xLabel?: string;
  yLabel?: string;
}) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const isDesktop = nativePaneChrome === true;
  const model = useMemo(() => {
    const built = buildTrailChart(
      trails.map((trail) => ({
        ...trail,
        // Behind the selected trail, the others fade but keep their hue, so
        // every tail can still be told from its neighbours.
        color: fadeOthers && selectedId && trail.id !== selectedId ? blendHex(trail.color, colors.bg, TRAIL_FADE) : trail.color,
      })),
      center,
      colors.textDim,
    );
    // In cells the origin lines would draw as dots, like a trail. There they
    // become four anchor points on the crosshair, which keep 100 in the middle
    // of the plot, and the overlay draws the lines.
    const origins = built.series.filter((entry) => isOrigin(entry.id)).flatMap((entry) => (
      isDesktop ? [entry] : entry.points.map((point, index) => staticSeries(
        // Both vertical anchors share the first one's column.
        [scalarPoint(entry.id === "vertical-origin" ? entry.points[0]!.date : point.date, point.value)],
        { id: `${entry.id}:${index}`, color: entry.color, style: "points", calendarSpaced: true },
      ))
    ));
    // Heads draw after every edge, and the selected trail over the rest, so
    // no trail's line covers another's latest week.
    const rank = (entry: ResolvedSeries) => (entry.id.endsWith(":head") ? 2 : 0)
      + (selectedId && entry.id.startsWith(`${selectedId}:`) ? 1 : 0);
    const marks = built.series.filter((entry) => !isOrigin(entry.id))
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) => rank(left.entry) - rank(right.entry) || left.index - right.index)
      .map(({ entry }) => entry);
    return { ...built, series: [...origins, ...marks] };
  }, [trails, center, colors.textDim, colors.bg, selectedId, fadeOthers, isDesktop]);
  const selectedHead = trails.find((trail) => trail.id === selectedId)?.points.at(-1);
  const plotHeight = Math.max(1, height - 1);

  // The plot's scene as the chart builds it, so the gutter and the overlay
  // land on the chart's own rows and columns.
  const panel = useMemo<CompositePanelScene | null>(() => {
    const scene = buildCompositeChartScene(model.series, PANELS, { width: 1, height: 1, rightOffsetRatio: 0 });
    const first = scene?.panels[0];
    return first ? resizeCompositePanel(first, plotHeight) : null;
  }, [model.series, plotHeight]);
  const domain = panel?.axes.right;
  const gutterLabelWidth = Math.max(
    1,
    ...compositeAxisTickLabels(domain, 12, axisValue).map((tick) => displayWidth(tick.label)),
    displayWidth(axisValue(center)),
    selectedHead ? displayWidth(axisValue(selectedHead.y)) : 0,
  );
  const gutter = gutterLabelWidth + 1;
  const plotWidth = Math.max(1, Math.floor(width - gutter));
  const cell = (ratio: number, size: number) => Math.max(0, Math.min(size - 1, Math.round(ratio * (size - 1))));
  const axisItems = layoutTrailAxis({
    width: plotWidth,
    ticks: trailAxisTicks(model.min, model.max).map(({ label, ratio }) => ({ label, x: cell(ratio, plotWidth) })),
    name: `${xLabel} →`,
    readout: selectedHead ? {
      label: selectedHead.x.toFixed(2),
      x: cell((selectedHead.x - model.min) / (model.max - model.min), plotWidth),
    } : null,
  });

  const overlay = useMemo(() => {
    if (!panel) return null;
    const trailPanel = { ...panel, series: panel.series.filter((entry) => !isOrigin(entry.source.id)) };
    const headPoint = (id: string) => panel.series.find((entry) => entry.source.id === `${id}:head`)?.points[0];
    const marks = renderCompositePanelText(trailPanel, plotWidth, null, null);
    const ordered = [...trails].sort((left, right) => Number(right.id === selectedId) - Number(left.id === selectedId));
    const heads = ordered.flatMap((trail): HeadLabel[] => {
      const point = headPoint(trail.id);
      return point ? [{
        id: trail.id, text: trail.label, color: trail.color, bold: trail.id === selectedId,
        x: cell(point.xRatio, plotWidth), y: cell(point.yRatio, plotHeight),
      }] : [];
    });
    // The crosshair runs through the cells the chart put 100 in.
    const origin = (prefix: string) => panel.series.find((entry) => entry.source.id.startsWith(prefix))?.points[0];
    const centerX = cell(origin("vertical-origin")?.xRatio ?? 0.5, plotWidth);
    const centerY = cell(origin("horizontal-origin")?.yRatio ?? 0.5, plotHeight);
    const selected = heads.find((head) => head.id === selectedId) ?? null;
    const anchors = panel.series.filter((entry) => isOrigin(entry.source.id)).flatMap((entry) => (
      entry.points.map((point) => ({ x: cell(point.xRatio, plotWidth), y: cell(point.yRatio, plotHeight) }))
    ));
    return {
      centerY,
      selected,
      ...layoutTrailOverlay({
        marks, heads, centerX, centerY, cursorX: selected?.x ?? null, anchors, yName: yLabel,
        quadrants: [
          { text: "Improving", tone: "muted", corner: "tl" },
          { text: "Leading", tone: "positive", corner: "tr" },
          { text: "Lagging", tone: "negative", corner: "bl" },
          { text: "Weakening", tone: "warning", corner: "br" },
        ],
      }),
    };
  }, [panel, plotWidth, plotHeight, trails, selectedId, yLabel]);

  const toneColor = (tone: Tone | undefined) => tone === "positive" ? colors.positive
    : tone === "negative" ? colors.negative
      : tone === "warning" ? colors.warning
        : tone === "muted" ? colors.textMuted
          : tone === "dim" ? colors.textDim
            : colors.text;
  // The gutter names the crosshair 100 and the cursor's momentum; the chart's
  // own ticks fill the rest, clear of both.
  const cursorRatio = selectedHead && domain ? projectCompositeValue(selectedHead.y, domain) : null;
  const cursorRow = cursorRatio === null ? null : cell(cursorRatio, plotHeight);
  const centerRow = overlay?.centerY ?? null;
  const axisRows = renderCompositeAxisText(domain, plotHeight, gutterLabelWidth, "right", axisValue)
    .map((row, index) => (centerRow !== null && Math.abs(index - centerRow) <= 1)
      || (cursorRow !== null && Math.abs(index - cursorRow) <= 1) ? "" : row);
  const at = (x: number, y: number) => isDesktop
    ? { left: `${(x / plotWidth) * 100}%`, top: `${(y / plotHeight) * 100}%` }
    : { left: x, top: y };

  return (
    <Box width={width} height={height} flexDirection="row">
      <Box width={plotWidth} height={height} position="relative" flexDirection="column">
        <CompositeChart
          series={model.series}
          panels={PANELS}
          width={plotWidth}
          height={plotHeight}
          axisWidth={0}
          showLegend={false}
          showTimeAxis={false}
          xAxis={STRENGTH_AXIS}
          formatAxisValue={axisValue}
          // Cells draw their own cursor, clear of the trails; the desktop's is a hairline.
          cursorDate={isDesktop && selectedHead ? model.toDate(selectedHead.x) : null}
          interactive={false}
          navigable={false}
          remoteKind="scatter-trails"
        />
        {overlay ? (
          <Box position="absolute" left={0} top={0} width={plotWidth} height={plotHeight} zIndex={12}
            style={isDesktop ? { pointerEvents: "none" } : undefined}>
            {isDesktop ? null : overlay.lines.map(({ x, y, char, cursor }) => (
              <Box key={`line:${x}:${y}`} position="absolute" left={x} top={y} width={1} height={1}
                backgroundColor={char === " " ? colors.bg : undefined}>
                <Text fg={cursor ? colors.borderFocused : colors.border}>{char}</Text>
              </Box>
            ))}
            {!isDesktop && overlay.selected ? (
              // The cursor runs through the selected head, which keeps its colour on top.
              <Box position="absolute" left={overlay.selected.x} top={overlay.selected.y} width={1} height={1}>
                <Text fg={overlay.selected.color}>●</Text>
              </Box>
            ) : null}
            {overlay.labels.map((label) => (
              // Opaque in cells: a label's blanks would otherwise show the grid under it.
              <Box key={label.id} position="absolute" {...at(label.x, label.y)} height={1}
                width={isDesktop ? undefined : displayWidth(label.text)}
                backgroundColor={isDesktop ? undefined : colors.bg}>
                <Text fg={label.color ?? toneColor(label.tone)} attributes={label.bold ? TextAttributes.BOLD : undefined}>
                  {label.text}
                </Text>
              </Box>
            ))}
          </Box>
        ) : null}
        <Box position="relative" width={plotWidth} height={1}>
          {axisItems.map((item) => (
            <Box key={`${item.kind}:${item.text}`} position="absolute" top={0} height={1}
              {...(isDesktop ? { left: `${(item.left / plotWidth) * 100}%` } : { left: item.left, width: displayWidth(item.text) })}>
              <Text fg={item.kind === "readout" ? colors.borderFocused : colors.textDim}>{item.text}</Text>
            </Box>
          ))}
        </Box>
      </Box>
      <Box width={gutter} height={height} flexDirection="column" paddingLeft={1}>
        {axisRows.map((row, index) => index === cursorRow && selectedHead ? (
          <Text key={index} fg={colors.borderFocused}>{axisValue(selectedHead.y)}</Text>
        ) : index === centerRow ? (
          <Text key={index} fg={colors.textDim}>{axisValue(center)}</Text>
        ) : (
          <Text key={index} fg={colors.textDim}>{row}</Text>
        ))}
      </Box>
    </Box>
  );
}
