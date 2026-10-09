import { useEffect, useRef } from "react";
import { Box, ScrollBox, Text, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { colors as themeColors, hoverBg } from "../../../theme/colors";
import { CANONICAL_EXCHANGE_ALIASES } from "../../../utils/exchanges";
import { displayWidth, formatPercentRaw, truncateToDisplayWidth } from "../../../utils/format";
import type { ResolvedSeries } from "../../../time-series/types";
import { consumeChartMouseEvent, type ChartMouseEvent } from "../core/pointer";
import { formatCompositePointDetails, formatCompositeSeriesValue, seriesPriceReference } from "./format";
import type { CompositeChartProps, CompositeChartScene } from "./types";

const LEGEND_WHEEL_DELTA_PER_CELL = 8;

function legendValue(
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

const LISTED_TICKER_PATTERN = /(^|[\s(])([A-Z0-9^][A-Z0-9.^=/-]*):([A-Z0-9]{2,})(?=$|[\s),])/g;

/** `Volume AAPL:XNAS Price` → `Volume AAPL Price`, for a legend name that must shorten. */
function withoutListingExchange(label: string): string {
  return label.replace(LISTED_TICKER_PATTERN, (match, lead: string, symbol: string, exchange: string) => (
    CANONICAL_EXCHANGE_ALIASES[exchange] ? `${lead}${symbol}` : match
  ));
}

export function CompositeLegend({
  scene,
  series,
  visibleSeriesIds,
  width,
  accessory,
  accessoryWidth,
  formatValue,
  showLatestChangePercent,
  onActivate,
  onToggleSeries,
  isSeriesToggleable,
  keyboardIndex,
}: {
  scene: CompositeChartScene | null;
  series: ResolvedSeries[];
  visibleSeriesIds: ReadonlySet<string>;
  width: number;
  accessory: CompositeChartProps["legendAccessory"];
  accessoryWidth: CompositeChartProps["legendAccessoryWidth"];
  formatValue: CompositeChartProps["formatValue"];
  showLatestChangePercent: CompositeChartProps["showLatestChangePercent"];
  onActivate: CompositeChartProps["onActivate"];
  onToggleSeries: CompositeChartProps["onToggleSeries"];
  isSeriesToggleable: CompositeChartProps["isSeriesToggleable"];
  keyboardIndex?: number | null;
}) {
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const cursorValueById = new Map(
    scene?.cursorValues.map((entry) => [entry.seriesId, entry] as const) ?? [],
  );
  const entries = series.map((entry) => {
    const toggleable = !!onToggleSeries && (isSeriesToggleable?.(entry) ?? true);
    const cursorValue = cursorValueById.get(entry.id);
    const changeText = showLatestChangePercent
        && !scene?.cursorDate
        && typeof entry.latestChangePercent === "number"
        && Number.isFinite(entry.latestChangePercent)
      ? ` ${formatPercentRaw(entry.latestChangePercent)}`
      : "";
    const valueText = entry.points.length === 0
      ? entry.hidden ? "" : "no data"
      : `${legendValue(
        entry,
        cursorValue?.value ?? null,
        formatValue,
        scene,
      )}${changeText}`;
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
      label,
      compactLabel,
      text,
      width: Math.max(1, displayWidth(text)) + 2,
      labelWidth,
      valueText,
      toggleable,
      tooltip,
    };
  });
  type LegendEntry = (typeof entries)[number];
  const setEntryLabel = (target: LegendEntry, label: string, labelWidth: number) => {
    target.label = label;
    target.labelWidth = labelWidth;
    target.text = [truncateToDisplayWidth(label, labelWidth), target.valueText].filter(Boolean).join(" ");
    target.width = Math.max(1, displayWidth(target.text)) + 2;
  };
  const measureSeriesWidth = () => entries.reduce(
    (total, entry, index) => total + entry.width + (index > 0 ? 1 : 0),
    0,
  );
  // One cell in from the pane border, so the first marker and the legend text
  // line up with the query bar and tables above and below the chart.
  const inset = width > 1 ? 1 : 0;
  const innerWidth = Math.max(0, width - inset);
  const resolvedAccessoryWidth = accessory
    ? Math.max(1, Math.min(innerWidth, Math.floor(accessoryWidth ?? 14)))
    : 0;
  const reservedAccessoryGap = accessory && innerWidth > resolvedAccessoryWidth ? 1 : 0;
  // The cursor date lives on the time axis, where the crosshair points at it.
  const widthBeforeAccessory = Math.max(0, innerWidth - resolvedAccessoryWidth - reservedAccessoryGap);
  // Names get the room the row has. When it overflows, the widest name
  // shortens first: its listing exchange goes before any of the name is cut.
  // The value (including its sign/unit) always stays intact. If the row cannot
  // fit even with every name at a readable fragment, it keeps the old 30-cell
  // entries and scrolls.
  const minimumSeriesWidth = entries.reduce((total, entry, index) => {
    const text = [truncateToDisplayWidth(entry.compactLabel, Math.min(8, displayWidth(entry.compactLabel))), entry.valueText]
      .filter(Boolean).join(" ");
    return total + Math.max(1, displayWidth(text)) + 2 + (index > 0 ? 1 : 0);
  }, 0);
  if (minimumSeriesWidth <= widthBeforeAccessory) {
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
  } else {
    for (const entry of entries) {
      const budget = Math.max(0, 30 - (entry.valueText ? displayWidth(entry.valueText) + 1 : 0));
      if (entry.labelWidth > budget) setEntryLabel(entry, entry.compactLabel, budget);
    }
  }
  const desiredSeriesWidth = measureSeriesWidth();
  const seriesWidth = Math.min(desiredSeriesWidth, widthBeforeAccessory);
  const accessorySpacerWidth = accessory
    ? Math.max(reservedAccessoryGap, innerWidth - seriesWidth - resolvedAccessoryWidth)
    : 0;
  const keyboardEntryStart = keyboardIndex === null || keyboardIndex === undefined
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
  return (
    <Box
      flexDirection="row"
      alignItems="flex-end"
      width={width}
      height={1}
      paddingLeft={inset}
      overflow="visible"
      // Accessory dropdowns must escape above the sibling drawing toolbar.
      zIndex={accessory ? 40 : 20}
      data-gloom-role="composite-chart-legend"
    >
      {seriesWidth > 0 ? (
        <ScrollBox
          ref={scrollRef}
          width={seriesWidth}
          height={1}
          flexShrink={0}
          scrollX
          focusable={false}
          horizontalScrollbarOptions={{ visible: false }}
          onMouseScroll={handleMouseScroll}
          data-gloom-role="composite-chart-legend-scroll"
        >
          <Box flexDirection="row" width={desiredSeriesWidth} height={1} gap={1}>
            {entries.map(({ entry, text, toggleable, tooltip, width: entryWidth }, index) => {
              const entryVisible = visibleSeriesIds.has(entry.id);
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
                title={isDesktopWeb ? tooltip : undefined}
              >
                {isDesktopWeb ? (
                  <Box
                    flexShrink={0}
                    style={{
                      width: 8,
                      height: 8,
                      marginInlineEnd: 6,
                      borderRadius: 999,
                      border: `1px solid ${entry.color}`,
                      backgroundColor: entryVisible ? entry.color : "transparent",
                    }}
                    data-gloom-role="composite-chart-legend-marker"
                  />
                ) : (
                  <Text fg={entryVisible ? entry.color : themeColors.textMuted}>● </Text>
                )}
                {/* The filled/hollow marker already says whether a series is
                    shown; the word only repeated it in every legend slot. */}
                <Text fg={entryVisible ? themeColors.text : themeColors.textDim}>{text}</Text>
              </Box>
              );
            })}
          </Box>
        </ScrollBox>
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
