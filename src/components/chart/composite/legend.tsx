import { useEffect, useRef } from "react";
import { Box, ScrollBox, Span, Text, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { colors as themeColors, hoverBg } from "../../../theme/colors";
import { CANONICAL_EXCHANGE_ALIASES } from "../../../utils/exchanges";
import { displayWidth, formatPercentRaw, truncateToDisplayWidth } from "../../../utils/format";
import type { ResolvedSeries } from "../../../time-series/types";
import { consumeChartMouseEvent, type ChartMouseEvent } from "../core/pointer";
import {
  formatCompositeCarriedStamp,
  formatCompositeDatasetDate,
  formatCompositePointDetails,
  formatCompositeSeriesValue,
  seriesPriceReference,
} from "./format";
import type { CompositeChartProps, CompositeChartScene } from "./types";
import { DIRECTION_MARKER, seriesColorsDirection, seriesCueCssBackground, type SeriesLineCue } from "./series-cues";
import { DisclosureMarker } from "../../ui/disclosure-marker";

const LEGEND_WHEEL_DELTA_PER_CELL = 8;
const NO_LINE_CUES: ReadonlyMap<string, SeriesLineCue> = new Map();
/** The dot every legend entry had before lines carried cues, and still has where they do not. */
const DOT_MARKER = "● ";
/** Cells the desktop and web marker takes: an 8px dot, or a 16px line sample, plus its margin. */
const DOM_DOT_CELLS = 2;
const DOM_LINE_CELLS = 3;

/** A series' value as the legend prints it, in the series' own unit. */
function formatLegendSeriesValue(
  series: ResolvedSeries,
  value: number | null,
  formatValue: CompositeChartProps["formatValue"],
  scene: CompositeChartScene | null,
): string {
  if (value === null) return "—";
  return formatValue ? formatValue(value, series) : formatCompositeSeriesValue(value, series, axisPriceReference(scene, series));
}

/** The reference the axis holding a series keeps for its asset, so an average
 * of the price shows the price's decimals rather than its own float tail. A
 * series far from that price (another coin on a shared axis) keeps its own. */
function axisPriceReference(scene: CompositeChartScene | null, series: ResolvedSeries): number | undefined {
  const own = seriesPriceReference(series);
  for (const panel of scene?.panels ?? []) {
    for (const domain of [panel.axes.left, panel.axes.right]) {
      if (!domain?.seriesIds.includes(series.id)) continue;
      const shared = domain.priceReferences?.[series.priceAssetCategory ?? ""];
      if (shared === undefined || own === undefined) return own ?? shared;
      const ratio = Math.abs(own / shared);
      return ratio > 0.1 && ratio < 10 ? shared : own;
    }
  }
  return own;
}

/**
 * A dataset's values arrive days late, so the legend dates them. Idle, one
 * date leads the legend when it is every value's; otherwise, and under the
 * cursor for a value older than the cursor's date, each carries its own.
 */
function legendValueDates(
  series: readonly ResolvedSeries[],
  scene: CompositeChartScene | null,
  cursorValueById: ReadonlyMap<string, CompositeChartScene["cursorValues"][number]>,
): { lead: string | null; own: ReadonlyMap<string, string> } {
  const dates = new Map<string, Date>();
  let valued = 0;
  for (const entry of series) {
    const cursorValue = cursorValueById.get(entry.id);
    if (cursorValue?.value == null) continue;
    valued += 1;
    if (entry.observationKind === "dataset" && cursorValue.point) dates.set(entry.id, cursorValue.point.date);
  }
  const text = new Map([...dates].map(([id, date]) => [id, formatCompositeDatasetDate(date, scene?.endTime)] as const));
  const cursorDate = scene?.cursorDate;
  if (cursorDate) {
    const cursorDay = cursorDate.toISOString().slice(0, 10);
    const own = new Map([...text].filter(([id]) => dates.get(id)!.toISOString().slice(0, 10) !== cursorDay));
    // Any other value carried from before the cursor says when it is from:
    // another venue's last bar, a coarser series, the last print before a halt.
    for (const entry of series) {
      const cursorValue = cursorValueById.get(entry.id);
      if (dates.has(entry.id) || !cursorValue?.carried || cursorValue.value == null || !cursorValue.point) continue;
      own.set(entry.id, formatCompositeCarriedStamp(cursorValue.point.date, cursorDate, scene?.timeZone));
    }
    return { lead: null, own };
  }
  const shared = new Set(text.values());
  return text.size > 0 && text.size === valued && shared.size === 1
    ? { lead: [...shared][0]!, own: new Map() }
    : { lead: null, own: text };
}

const LISTED_TICKER_PATTERN = /(^|[\s(])([A-Z0-9^][A-Z0-9.^=/-]*):([A-Z0-9]{2,})(?=$|[\s),])/g;

/** `Volume AAPL:XNAS Price` → `Volume AAPL Price`, for a legend name that must shorten. */
function withoutListingExchange(label: string): string {
  return label.replace(LISTED_TICKER_PATTERN, (match, lead: string, symbol: string, exchange: string) => (
    CANONICAL_EXCHANGE_ALIASES[exchange] ? `${lead}${symbol}` : match
  ));
}

/**
 * Entries laid left to right into lines of `available` cells, one cell apart,
 * a new line when the next does not fit. With `maxLines`, what does not fit in
 * the last line stays on it (that line scrolls).
 */
function packLegendLines(widths: readonly number[], available: number, maxLines = Infinity): number[][] {
  const lines: number[][] = [];
  let used = 0;
  widths.forEach((width, index) => {
    const line = lines.at(-1);
    if (line && (used + 1 + width <= available || lines.length >= maxLines)) {
      line.push(index);
      used += 1 + width;
    } else {
      lines.push([index]);
      used = width;
    }
  });
  return lines;
}

/** A triangle pointing up or down, as the desktop legend keys a bar's direction. */
const DIRECTION_TRIANGLES = {
  up: "polygon(50% 0, 100% 100%, 0 100%)",
  down: "polygon(0 0, 100% 0, 50% 100%)",
} as const;

/** The legend's marker for a series on the desktop: its line as the plot strokes it, its up and down colors, or a dot. */
function CompositeSeriesSwatch({ series, cue, downColor = null, filled = true }: {
  series: ResolvedSeries;
  cue: SeriesLineCue | null;
  /** The down color, for a series keyed by direction: an up triangle in its color, then a down one in this. */
  downColor?: string | null;
  filled?: boolean;
}) {
  if (downColor) {
    return (
      <Box
        flexShrink={0}
        flexDirection="row"
        style={{ gap: 2, marginInlineEnd: 6, opacity: filled ? 1 : 0.35 }}
        data-gloom-role="composite-chart-legend-marker"
        data-gloom-cue="direction"
      >
        {([["up", series.color], ["down", downColor]] as const).map(([direction, color]) => (
          <Box key={direction} flexShrink={0} style={{ width: 7, height: 7, backgroundColor: color, clipPath: DIRECTION_TRIANGLES[direction] }} />
        ))}
      </Box>
    );
  }
  return cue ? (
    // The line as the plot strokes it: solid, dashed, dotted or heavy.
    <Box
      flexShrink={0}
      style={{
        width: 16,
        height: Math.max(2, Math.round(cue.thickness)),
        marginInlineEnd: 6,
        background: seriesCueCssBackground(cue, series.color),
        opacity: filled ? 1 : 0.35,
      }}
      data-gloom-role="composite-chart-legend-marker"
      data-gloom-cue={cue.id}
    />
  ) : (
    <Box
      flexShrink={0}
      style={{
        width: 8,
        height: 8,
        marginInlineEnd: 6,
        borderRadius: "var(--gloom-radius-full)",
        border: `1px solid ${series.color}`,
        backgroundColor: filled ? series.color : "transparent",
      }}
      data-gloom-role="composite-chart-legend-marker"
    />
  );
}

export function CompositeLegend({
  scene,
  series: allSeries,
  visibleSeriesIds,
  lineCues = NO_LINE_CUES,
  cellPlot = false,
  directionDownColor = null,
  width,
  accessory,
  accessoryWidth,
  formatValue,
  showLatestChangePercent,
  onActivate,
  onToggleSeries,
  isSeriesToggleable,
  keyboardIndex,
  rows = 1,
  onWantedRowsChange,
  collapsed = false,
  onToggleCollapsed,
}: {
  scene: CompositeChartScene | null;
  series: ResolvedSeries[];
  visibleSeriesIds: ReadonlySet<string>;
  /** Each line's cue on a chart that draws several; a chart with one keeps its dot. */
  lineCues?: ReadonlyMap<string, SeriesLineCue>;
  /** The plot is cell text, so a line's cue is its mark rather than its dash. */
  cellPlot?: boolean;
  /**
   * The color bars that closed down are drawn in, where the theme's up and
   * down are not the familiar green and red: a candle series' marker then keys
   * both (`▲▼`). Null keeps its dot.
   */
  directionDownColor?: string | null;
  width: number;
  accessory: CompositeChartProps["legendAccessory"];
  accessoryWidth: CompositeChartProps["legendAccessoryWidth"];
  formatValue: CompositeChartProps["formatValue"];
  showLatestChangePercent: CompositeChartProps["showLatestChangePercent"];
  onActivate: CompositeChartProps["onActivate"];
  onToggleSeries: CompositeChartProps["onToggleSeries"];
  isSeriesToggleable: CompositeChartProps["isSeriesToggleable"];
  keyboardIndex?: number | null;
  /** Lines the chart gives the legend; more than one lets entries that cannot share a line wrap. */
  rows?: number;
  /** The lines the legend needs to show every entry whole, told while no cursor moves the values. */
  onWantedRowsChange?: (rows: number) => void;
  /** Folded to its first series and a count of the rest, which a press opens. */
  collapsed?: boolean;
  /** Folds or opens the legend: a chevron in its inset, shown under the pointer while it is open. */
  onToggleCollapsed?: () => void;
}) {
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  // Folded, the legend keeps its first series; the rest wait behind a count.
  const foldedCount = collapsed ? Math.max(0, allSeries.length - 1) : 0;
  const series = foldedCount > 0 ? allSeries.slice(0, 1) : allSeries;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const cursorValueById = new Map(
    scene?.cursorValues.map((entry) => [entry.seriesId, entry] as const) ?? [],
  );
  const valueDates = legendValueDates(series, scene, cursorValueById);
  const buildEntries = (withFiscalPeriods: boolean) => series.map((entry) => {
    const cue = lineCues.get(entry.id) ?? null;
    const downColor = !cue && directionDownColor && seriesColorsDirection(entry) ? directionDownColor : null;
    const marker = cue ? `${cellPlot ? cue.glyph : cue.sample} ` : downColor ? DIRECTION_MARKER.text : DOT_MARKER;
    const markerWidth = isDesktopWeb ? cue || downColor ? DOM_LINE_CELLS : DOM_DOT_CELLS : displayWidth(marker);
    const toggleable = !!onToggleSeries && (isSeriesToggleable?.(entry) ?? true);
    const cursorValue = cursorValueById.get(entry.id);
    // A stacked layer reads its own amount, not the top of the stack it is drawn to.
    const legendValue = entry.stacked ? cursorValue?.point?.rawValue ?? null : cursorValue?.value ?? null;
    const changeText = showLatestChangePercent
        && !scene?.cursorDate
        && typeof entry.latestChangePercent === "number"
        && Number.isFinite(entry.latestChangePercent)
      ? ` ${formatPercentRaw(entry.latestChangePercent)}`
      : "";
    const ownDate = valueDates.own.get(entry.id);
    // Carried from an earlier observation: another venue's closed session, a coarser series.
    const carried = !!scene?.cursorDate && !!cursorValue?.carried && cursorValue.value != null;
    // What a futures price counts, beside its number as FUT prints it.
    const statedUnit = entry.points.length > 0 && !formatValue && entry.statedUnit ? ` ${entry.statedUnit}` : "";
    // A statement value names the fiscal period it reports, as FA's columns do.
    const fiscalPeriod = withFiscalPeriods && cursorValue?.value != null ? cursorValue.point?.fiscalPeriod : undefined;
    const valueTail = `${ownDate ? ` ${ownDate}` : ""}${fiscalPeriod ? ` ${fiscalPeriod}` : ""}${changeText}`;
    const valueText = entry.points.length === 0
      ? entry.hidden ? "" : "no data"
      : `${formatLegendSeriesValue(
        entry,
        legendValue,
        formatValue,
        scene,
      )}${statedUnit}${valueTail}`;
    const fullText = [entry.label, valueText].filter(Boolean).join(" ");
    const details = formatCompositePointDetails(cursorValue?.point);
    const exactTotal = entry.unitGroup.split(":")[0] === "currency-total"
      && cursorValue?.value != null && Number.isFinite(cursorValue.value)
      ? `Value ${cursorValue.value} ${entry.unit}` : "";
    const tooltip = [fullText, exactTotal, details].filter(Boolean).join(" · ");
    const label = entry.label;
    const compactLabel = withoutListingExchange(label);
    const labelWidth = displayWidth(label);
    const text = [label, valueText].filter(Boolean).join(" ");
    return {
      entry,
      cue,
      downColor,
      marker,
      markerWidth,
      label,
      compactLabel,
      text,
      width: Math.max(1, displayWidth(text)) + markerWidth,
      labelWidth,
      valueText,
      statedUnit,
      valueTail,
      fiscalPeriod,
      toggleable,
      tooltip,
      carried,
    };
  });
  let entries = buildEntries(true);
  type LegendEntry = (typeof entries)[number];
  const setEntryLabel = (target: LegendEntry, label: string, labelWidth: number) => {
    target.label = label;
    target.labelWidth = labelWidth;
    target.text = [truncateToDisplayWidth(label, labelWidth), target.valueText].filter(Boolean).join(" ");
    target.width = Math.max(1, displayWidth(target.text)) + target.markerWidth;
  };
  const measureSeriesWidth = () => entries.reduce(
    (total, entry, index) => total + entry.width + (index > 0 ? 1 : 0),
    0,
  );
  // One cell in from the pane border, so the first marker and the legend text
  // line up with the query bar and tables above and below the chart.
  const inset = width > 1 ? 1 : 0;
  const leadWidth = valueDates.lead ? displayWidth(valueDates.lead) + 1 : 0;
  const innerWidth = Math.max(0, width - inset - leadWidth);
  const resolvedAccessoryWidth = accessory
    ? Math.max(1, Math.min(innerWidth, Math.floor(accessoryWidth ?? 14)))
    : 0;
  const reservedAccessoryGap = accessory && innerWidth > resolvedAccessoryWidth ? 1 : 0;
  const foldedText = foldedCount > 0 ? `+${foldedCount}` : null;
  const foldedWidth = foldedText ? displayWidth(foldedText) + 1 : 0;
  // The cursor date lives on the time axis, where the crosshair points at it.
  const widthBeforeAccessory = Math.max(0, innerWidth - resolvedAccessoryWidth - reservedAccessoryGap - foldedWidth);
  // Names get the room the row has. When it overflows, the widest name
  // shortens first: its listing exchange goes before any of the name is cut.
  // The value (including its sign/unit) always stays intact. If the row cannot
  // fit even with every name at a readable fragment, it keeps the old 30-cell
  // entries and scrolls.
  const minimumWidthOf = (list: LegendEntry[]) => list.reduce((total, entry, index) => {
    const text = [truncateToDisplayWidth(entry.compactLabel, Math.min(8, displayWidth(entry.compactLabel))), entry.valueText]
      .filter(Boolean).join(" ");
    return total + Math.max(1, displayWidth(text)) + entry.markerWidth + (index > 0 ? 1 : 0);
  }, 0);
  // A fiscal period is context beside a value. Where it would push the row past
  // what fits with every name at a fragment, the row reads as it did without
  // them (the tooltip keeps the period's dates) and does not scroll a value away.
  if (entries.some(({ fiscalPeriod }) => fiscalPeriod) && minimumWidthOf(entries) > widthBeforeAccessory) {
    entries = buildEntries(false);
  }
  const minimumSeriesWidth = minimumWidthOf(entries);
  const fitsOneLine = minimumSeriesWidth <= widthBeforeAccessory;
  // Entries that cannot share a line even with names cut to fragments wrap onto
  // more lines when the chart gives them room, each whole, its name only cut
  // past a line's width; with one line they keep the old 30-cell entries and scroll.
  let lines: number[][] | null = null;
  let wantedRows = 1;
  if (!fitsOneLine) {
    const wrappedLabelWidth = (entry: LegendEntry) => Math.min(
      displayWidth(entry.compactLabel),
      Math.max(1, widthBeforeAccessory - entry.markerWidth - (entry.valueText ? displayWidth(entry.valueText) + 1 : 0)),
    );
    const wrappedWidths = entries.map((entry) => entry.markerWidth + Math.max(1, displayWidth(
      [truncateToDisplayWidth(entry.compactLabel, wrappedLabelWidth(entry)), entry.valueText].filter(Boolean).join(" "),
    )));
    wantedRows = packLegendLines(wrappedWidths, widthBeforeAccessory).length;
    if (rows > 1) {
      for (const entry of entries) setEntryLabel(entry, entry.compactLabel, wrappedLabelWidth(entry));
      lines = packLegendLines(wrappedWidths, widthBeforeAccessory, rows);
    }
  }
  const idle = !scene?.cursorDate;
  useEffect(() => {
    if (idle) onWantedRowsChange?.(wantedRows);
  }, [idle, onWantedRowsChange, wantedRows]);
  if (fitsOneLine) {
    while (measureSeriesWidth() > widthBeforeAccessory) {
      const shrinkable = entries
        .filter((entry) => entry.label !== entry.compactLabel || entry.labelWidth > 8)
        .sort((left, right) => right.labelWidth - left.labelWidth)[0];
      if (!shrinkable) break;
      if (shrinkable.label !== shrinkable.compactLabel) {
        setEntryLabel(shrinkable, shrinkable.compactLabel, Math.min(shrinkable.labelWidth, displayWidth(shrinkable.compactLabel)));
      } else {
        setEntryLabel(shrinkable, shrinkable.label, shrinkable.labelWidth - 1);
      }
    }
  } else if (!lines) {
    for (const entry of entries) {
      const budget = Math.max(0, 30 - (entry.valueText ? displayWidth(entry.valueText) + 1 : 0));
      if (entry.labelWidth > budget) setEntryLabel(entry, entry.compactLabel, budget);
    }
  }
  const lineWidth = (line: readonly number[]) => line.reduce(
    (total, index, position) => total + entries[index]!.width + (position > 0 ? 1 : 0),
    0,
  );
  const desiredSeriesWidth = lines ? lineWidth(lines.at(-1)!) : measureSeriesWidth();
  const seriesWidth = lines ? widthBeforeAccessory : Math.min(desiredSeriesWidth, widthBeforeAccessory);
  const accessorySpacerWidth = accessory
    ? Math.max(reservedAccessoryGap, innerWidth - seriesWidth - foldedWidth - resolvedAccessoryWidth)
    : 0;
  const keyboardEntryStart = keyboardIndex === null || keyboardIndex === undefined || lines
    ? null
    : entries.slice(0, keyboardIndex).reduce(
      (total, entry, index) => total + entry.width + (index > 0 ? 1 : 0),
      0,
    ) + (keyboardIndex > 0 ? 1 : 0);
  const keyboardEntryEnd = keyboardEntryStart === null
    ? null
    : keyboardEntryStart + (entries[keyboardIndex!]?.width ?? 0);

  useEffect(() => {
    if (keyboardEntryStart === null || keyboardEntryEnd === null) return;
    const scrollBox = scrollRef.current;
    const viewportWidth = scrollBox?.viewport?.width || scrollBox?.width || seriesWidth;
    if (!scrollBox || viewportWidth <= 0) return;
    const currentLeft = scrollBox.scrollLeft ?? 0;
    const nextLeft = keyboardEntryStart < currentLeft
      ? keyboardEntryStart
      : keyboardEntryEnd > currentLeft + viewportWidth
        ? keyboardEntryEnd - viewportWidth
        : currentLeft;
    if (nextLeft === currentLeft) return;
    scrollBox.scrollLeft = nextLeft;
    scrollBox.scrollTo({ x: nextLeft, y: scrollBox.scrollTop });
  }, [keyboardEntryEnd, keyboardEntryStart, seriesWidth]);
  const handleMouseScroll = (event?: {
    preventDefault?: () => void;
    stopPropagation?: () => void;
    scroll?: { direction?: string; delta?: number };
  }) => {
    const direction = event?.scroll?.direction;
    const scrollBox = scrollRef.current;
    const viewportWidth = scrollBox?.viewport?.width || scrollBox?.width || 0;
    const contentWidth = Math.max(desiredSeriesWidth, scrollBox?.scrollWidth ?? 0);
    if (!direction || !scrollBox || viewportWidth <= 0 || contentWidth <= viewportWidth) return;

    event.preventDefault?.();
    event.stopPropagation?.();
    const rawDelta = Math.abs(event.scroll?.delta ?? 1);
    const deltaCells = Math.max(1, Math.round(rawDelta / LEGEND_WHEEL_DELTA_PER_CELL));
    const directionSign = direction === "right" || direction === "down" ? 1 : -1;
    const nextLeft = Math.max(
      0,
      Math.min(
        contentWidth - viewportWidth,
        (scrollBox.scrollLeft ?? 0) + directionSign * deltaCells,
      ),
    );
    scrollBox.scrollLeft = nextLeft;
    scrollBox.scrollTo({ x: nextLeft, y: scrollBox.scrollTop });
  };
  const renderEntry = (
    { entry, cue, downColor, marker, text, statedUnit, valueTail, toggleable, tooltip, carried, width: entryWidth }: LegendEntry,
    index: number,
  ) => {
    const entryVisible = visibleSeriesIds.has(entry.id);
    const unitAt = statedUnit ? text.length - statedUnit.length - valueTail.length : -1;
    return (
      <Box
        key={entry.id}
        flexDirection="row"
        alignItems="center"
        width={entryWidth}
        height={1}
        flexShrink={0}
        overflow="hidden"
        backgroundColor={keyboardIndex === index ? themeColors.selected : undefined}
        hoverBackgroundColor={toggleable ? hoverBg() : undefined}
        onMouseDown={toggleable ? (event: ChartMouseEvent) => {
          onActivate?.();
          consumeChartMouseEvent(event);
          onToggleSeries?.(entry.id);
        } : undefined}
        cursor={toggleable ? "pointer" : undefined}
        data-gloom-interactive={toggleable ? "true" : undefined}
        data-gloom-role="composite-chart-legend-series"
        data-gloom-label={`${toggleable
          ? `${entryVisible ? "Hide" : "Show"} `
          : ""}${tooltip}`}
        data-visible={entryVisible ? "true" : "false"}
        data-carried={carried ? "true" : undefined}
        title={isDesktopWeb ? tooltip : undefined}
      >
        {isDesktopWeb ? (
          <CompositeSeriesSwatch series={entry} cue={cue} downColor={downColor} filled={entryVisible} />
        ) : downColor && entryVisible ? (
          <Text>
            <Span fg={entry.color}>{DIRECTION_MARKER.up}</Span>
            <Span fg={downColor}>{DIRECTION_MARKER.down}</Span>
            {" "}
          </Text>
        ) : (
          <Text fg={entryVisible ? entry.color : themeColors.textMuted}>{marker}</Text>
        )}
        {/* The filled/hollow marker already says whether a series is
            shown; the word only repeated it in every legend slot. */}
        <Text fg={entryVisible && !carried ? themeColors.text : themeColors.textDim}>
          {unitAt >= 0 ? (
            <>
              {text.slice(0, unitAt)}
              <Span fg={themeColors.textDim}>{statedUnit}</Span>
              {valueTail}
            </>
          ) : text}
        </Text>
      </Box>
    );
  };
  const scrollLine = (line: number[] | null, key: string | number, ref: typeof scrollRef | undefined) => (
    <ScrollBox
      key={key}
      ref={ref}
      width={seriesWidth}
      height={1}
      flexShrink={0}
      scrollX
      focusable={false}
      horizontalScrollbarOptions={{ visible: false }}
      onMouseScroll={ref ? handleMouseScroll : undefined}
      data-gloom-role="composite-chart-legend-scroll"
    >
      <Box flexDirection="row" width={line ? lineWidth(line) : desiredSeriesWidth} height={1} gap={1}>
        {line ? line.map((index) => renderEntry(entries[index]!, index)) : entries.map(renderEntry)}
      </Box>
    </ScrollBox>
  );
  const lineCount = lines?.length ?? 1;
  const foldLabel = foldedCount > 0
    ? `Show ${foldedCount} more series (Shift+L)`
    : "Collapse the legend to its first series (Shift+L)";
  const pressFold = (event: ChartMouseEvent) => {
    consumeChartMouseEvent(event);
    onToggleCollapsed?.();
  };
  return (
    <Box
      flexDirection="row"
      alignItems={lines ? "flex-start" : "flex-end"}
      width={width}
      height={lineCount}
      paddingLeft={inset}
      position="relative"
      overflow="visible"
      // Accessory dropdowns must escape above the sibling drawing toolbar.
      zIndex={accessory ? 40 : 20}
      data-gloom-role="composite-chart-legend"
      data-gloom-reveal-scope="true"
      data-collapsed={foldedCount > 0 ? "true" : undefined}
    >
      {/* The chevron sits in the inset, so it moves nothing: folded it always
          shows, open it shows under the pointer (the terminal has Shift+L). */}
      {onToggleCollapsed && inset > 0 && (foldedCount > 0 || isDesktopWeb) ? (
        <Box
          position="absolute"
          left={0}
          top={0}
          width={inset}
          height={1}
          zIndex={22}
          alignItems="center"
          justifyContent="center"
          hoverBackgroundColor={hoverBg()}
          onMouseDown={pressFold}
          cursor="pointer"
          data-gloom-interactive="true"
          data-gloom-role="composite-chart-legend-toggle"
          data-gloom-label={foldLabel}
          data-gloom-reveal={foldedCount > 0 ? undefined : "hover"}
          title={isDesktopWeb ? foldLabel : undefined}
          role={isDesktopWeb ? "button" : undefined}
          aria-label={isDesktopWeb ? foldLabel : undefined}
          aria-expanded={isDesktopWeb ? foldedCount === 0 : undefined}
        >
          <DisclosureMarker expanded={foldedCount === 0} color={themeColors.textDim} />
        </Box>
      ) : null}
      {valueDates.lead ? (
        <Box width={leadWidth} height={1} flexShrink={0} data-gloom-role="composite-chart-legend-date">
          <Text fg={themeColors.textMuted}>{valueDates.lead}</Text>
        </Box>
      ) : null}
      {seriesWidth > 0 && lines ? (
        <Box flexDirection="column" width={seriesWidth} height={lineCount} flexShrink={0}>
          {lines.map((line, index) => scrollLine(line, index, index === lines!.length - 1 ? scrollRef : undefined))}
        </Box>
      ) : seriesWidth > 0 ? scrollLine(null, "line", scrollRef) : null}
      {foldedText ? (
        <Box
          flexDirection="row"
          width={foldedWidth}
          height={1}
          flexShrink={0}
          paddingLeft={1}
          data-gloom-role="composite-chart-legend-more"
        >
          <Box
            height={1}
            flexShrink={0}
            hoverBackgroundColor={onToggleCollapsed ? hoverBg() : undefined}
            onMouseDown={onToggleCollapsed ? pressFold : undefined}
            cursor={onToggleCollapsed ? "pointer" : undefined}
            data-gloom-interactive={onToggleCollapsed ? "true" : undefined}
            data-gloom-label={foldLabel}
            title={isDesktopWeb ? foldLabel : undefined}
          >
            <Text fg={themeColors.textDim}>{foldedText}</Text>
          </Box>
        </Box>
      ) : null}
      {accessorySpacerWidth > 0 ? (
        <Box width={accessorySpacerWidth} flexShrink={0} />
      ) : null}
      {accessory ? (
        <Box
          position="relative"
          width={resolvedAccessoryWidth}
          flexShrink={0}
          height={1}
          overflow="visible"
          zIndex={21}
        >
          {accessory}
        </Box>
      ) : null}
    </Box>
  );
}
