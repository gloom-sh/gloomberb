import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../ui";
import { blendHex, colors, priceColor } from "../../theme/colors";
import { blendForContrast, higherContrast } from "../../theme/color-utils";
import { t } from "../../i18n";
import { padTo } from "../../utils/format";
import {
  buildMetricTreemap,
  buildMetricTreemapRects,
  type FloatMetricTreemapTile,
  type MetricTreemapItem,
  type MetricTreemapTile,
} from "./layout";

export {
  buildMetricTreemapNavigationTiles,
  findMetricTreemapNeighbor,
  type MetricTreemapDirection,
  type MetricTreemapItem,
} from "./layout";

type PreventableMouseEvent = { preventDefault(): void };
type PointerMoveEvent = { x?: number; y?: number; pixelX?: number; pixelY?: number };

/**
 * Hover selects the tile under the pointer, but only when the pointer really
 * moved. The terminal re-sends "over" when tiles relayout under a resting
 * pointer, and a browser can replay a move after layout or scroll; either
 * would silently take the selection the keyboard just made.
 */
function usePointerMoved(): (event: PointerMoveEvent | undefined) => boolean {
  const lastRef = useRef<string | null>(null);
  return useCallback((event) => {
    const x = event?.pixelX ?? event?.x;
    const y = event?.pixelY ?? event?.y;
    if (typeof x !== "number" || typeof y !== "number") return true;
    const position = `${x}:${y}`;
    if (lastRef.current === position) return false;
    lastRef.current = position;
    return true;
  }, []);
}

export interface MetricTreemapSurfaceProps<T> {
  items: MetricTreemapItem<T>[];
  width: number;
  height: number;
  selectedId: string | null;
  onSelect: (item: MetricTreemapItem<T>) => void;
  onActivate?: (item: MetricTreemapItem<T>) => void;
  emptyStateTitle?: string;
}

function metricTileColor(item: MetricTreemapItem): string {
  if (item.colorValue == null) return colors.neutral;
  return priceColor(item.colorValue);
}

function desktopMetricTileColor(item: MetricTreemapItem): string {
  if (item.colorValue == null || item.colorValue === 0) {
    return colors.neutral;
  }
  const intensity = Math.max(0.38, Math.min(0.88, Math.log1p(Math.abs(item.colorValue)) / Math.log1p(30)));
  return blendHex(colors.panel, item.colorValue > 0 ? colors.positive : colors.negative, intensity);
}

const TILE_TEXT_MIN_CONTRAST = 4.5;

function tileTextColor(backgroundColor: string): string {
  const preferred = higherContrast(
    higherContrast(colors.text, colors.textBright, backgroundColor),
    colors.selectedText,
    backgroundColor,
  );
  const fallback = higherContrast("#000000", "#ffffff", backgroundColor);
  return blendForContrast(preferred, backgroundColor, fallback, TILE_TEXT_MIN_CONTRAST);
}

function visibleLines(item: MetricTreemapItem): string[] {
  return [
    item.label,
    item.primaryText,
    item.secondaryText,
    item.tertiaryText,
  ].filter((line): line is string => !!line);
}

function Tile<T>({ tile, selected, onSelect, onActivate, pointerMoved }: {
  tile: MetricTreemapTile<T>;
  selected: boolean;
  onSelect: () => void;
  onActivate?: () => void;
  pointerMoved: (event: PointerMoveEvent | undefined) => boolean;
}) {
  const renderWidth = Math.max(1, tile.width - (tile.width > 2 ? 1 : 0));
  const renderHeight = Math.max(1, tile.height - (tile.height > 2 ? 1 : 0));
  const innerWidth = Math.max(1, renderWidth - 1);
  const backgroundColor = selected ? colors.selected : metricTileColor(tile.item);
  const textColor = tileTextColor(backgroundColor);
  const attributes = selected ? TextAttributes.BOLD : TextAttributes.NONE;
  const lines = visibleLines(tile.item);

  return (
    <Box
      position="absolute"
      left={tile.x}
      top={tile.y}
      width={renderWidth}
      height={renderHeight}
      backgroundColor={backgroundColor}
      onMouseDown={(event: PreventableMouseEvent) => {
        event.preventDefault();
        onSelect();
      }}
      onMouseMove={(event: PointerMoveEvent) => {
        if (pointerMoved(event)) onSelect();
      }}
      // A held button sends no moves here, only "over" from the press it
      // started; a relayout's "over" has no source.
      onMouseOver={(event: PointerMoveEvent & { source?: unknown }) => {
        if (event.source && pointerMoved(event)) onSelect();
      }}
      onDoubleClick={onActivate}
    >
      {lines.slice(0, renderHeight).map((line, index) => (
        <Text key={`${tile.item.id}:${index}`} fg={textColor} attributes={attributes}>
          {padTo(line, innerWidth)}
        </Text>
      ))}
    </Box>
  );
}

function pct(value: number, total: number): string {
  return `${total > 0 ? value / total * 100 : 0}%`;
}

function DesktopTile<T>({ tile, chartWidth, chartHeight, selected, hovered, onSelect, onActivate, onHover, pointerMoved }: {
  tile: FloatMetricTreemapTile<T>;
  chartWidth: number;
  chartHeight: number;
  selected: boolean;
  hovered: boolean;
  onSelect: () => void;
  onActivate?: () => void;
  onHover: (hovered: boolean) => void;
  pointerMoved: (event: PointerMoveEvent | undefined) => boolean;
}) {
  const lines = visibleLines(tile.item);
  const canShowDetails = tile.width >= 7 && tile.height >= 3;
  const canShowExtra = tile.height >= 3.7;
  const canShowLabel = tile.width >= 4 && tile.height >= 1.4;
  const isTiny = tile.width < 5 || tile.height < 2;
  const backgroundColor = desktopMetricTileColor(tile.item);
  const textColor = tileTextColor(backgroundColor);
  const style: CSSProperties = {
    position: "absolute",
    left: `calc(${pct(tile.x, chartWidth)} + 1px)`,
    top: `calc(${pct(tile.y, chartHeight)} + 1px)`,
    width: `max(1px, calc(${pct(tile.width, chartWidth)} - 2px))`,
    height: `max(1px, calc(${pct(tile.height, chartHeight)} - 2px))`,
    minWidth: 1,
    minHeight: 1,
    padding: isTiny ? "3px 4px" : "7px 8px",
    overflow: "hidden",
    borderRadius: 5,
    border: selected
      ? `1px solid ${colors.textBright}`
      : hovered
        ? `1px solid ${blendHex(colors.textBright, backgroundColor, 0.55)}`
        : `1px solid ${blendHex(backgroundColor, colors.textBright, 0.11)}`,
    boxShadow: selected
      ? `inset 0 0 0 1px ${blendHex(backgroundColor, colors.textBright, 0.55)}`
      : hovered
        ? `inset 0 0 0 1px ${blendHex(backgroundColor, colors.textBright, 0.18)}`
        : "none",
    backgroundColor,
    color: textColor,
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "flex-start",
    gap: 2,
    cursor: "pointer",
    transition: "border-color 120ms ease, box-shadow 120ms ease, filter 120ms ease",
    filter: hovered ? "brightness(1.08)" : undefined,
  };
  const textStyle: CSSProperties = {
    display: "block",
    minWidth: 0,
    width: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    lineHeight: 1.1,
    letterSpacing: 0,
    textShadow: `0 1px 1px ${blendHex(backgroundColor, colors.bg, 0.35)}`,
  };
  const moveHover = (event: PointerMoveEvent) => {
    onHover(true);
    if (pointerMoved(event)) onSelect();
  };

  return (
    <Box
      data-gloom-role="metric-treemap-desktop-tile"
      style={style}
      onMouseDown={(event: PreventableMouseEvent) => {
        event.preventDefault();
        onSelect();
      }}
      onDoubleClick={onActivate}
      onMouseOver={() => onHover(true)}
      onMouseMove={moveHover}
      onMouseOut={() => onHover(false)}
    >
      {canShowLabel && (
        <Text
          fg={textColor}
          attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE}
          style={{
            ...textStyle,
            fontSize: isTiny ? 11 : 13,
            fontWeight: 700,
          }}
        >
          {lines[0]}
        </Text>
      )}
      {canShowDetails && lines.slice(1, canShowExtra ? 4 : 3).map((line, index) => (
        <Text key={`${tile.item.id}:detail:${index}`} fg={textColor} style={{ ...textStyle, fontSize: 12, fontWeight: 600 }}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

function DesktopMetricTreemapSurface<T>({ items, width, height, selectedId, onSelect, onActivate, cellAspect, emptyStateTitle }: MetricTreemapSurfaceProps<T> & {
  cellAspect: number;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const pointerMoved = usePointerMoved();
  const chartWidth = Math.max(1, width - 2);
  const tiles = useMemo(() => buildMetricTreemapRects(items, chartWidth, height, cellAspect), [cellAspect, chartWidth, height, items]);

  if (tiles.length === 0) {
    return (
      <Box width={width} height={height} paddingX={1} paddingY={1}>
        <Text fg={colors.textDim}>{t(emptyStateTitle ?? "No chart data")}</Text>
      </Box>
    );
  }

  return (
    <Box
      width={width}
      height={height}
      paddingX={1}
      style={{
        backgroundColor: colors.bg,
        overflow: "hidden",
      }}
    >
      <Box
        data-gloom-role="metric-treemap"
        width={chartWidth}
        height={height}
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          backgroundColor: colors.bg,
          overflow: "hidden",
        }}
      >
        {tiles.map((tile) => (
          <DesktopTile
            key={tile.item.id}
            tile={tile}
            chartWidth={chartWidth}
            chartHeight={height}
            selected={tile.item.id === selectedId}
            hovered={tile.item.id === hoveredId}
            onSelect={() => onSelect(tile.item)}
            onActivate={onActivate ? () => onActivate(tile.item) : undefined}
            onHover={(isHovered) => setHoveredId((current) => (isHovered ? tile.item.id : current === tile.item.id ? null : current))}
            pointerMoved={pointerMoved}
          />
        ))}
      </Box>
    </Box>
  );
}

export function MetricTreemapSurface<T>({
  items,
  width,
  height,
  selectedId,
  onSelect,
  onActivate,
  emptyStateTitle,
}: MetricTreemapSurfaceProps<T>) {
  const { cellWidthPx = 8, cellHeightPx = 18, nativePaneChrome } = useUiCapabilities();
  const chartWidth = Math.max(1, width - 2);
  const cellAspect = Math.max(0.5, Math.min(4, cellHeightPx / Math.max(1, cellWidthPx)));
  const tiles = useMemo(() => buildMetricTreemap(items, chartWidth, height, cellAspect), [cellAspect, chartWidth, height, items]);
  const pointerMoved = usePointerMoved();

  if (nativePaneChrome) {
    return (
      <DesktopMetricTreemapSurface
        items={items}
        width={width}
        height={height}
        selectedId={selectedId}
        onSelect={onSelect}
        onActivate={onActivate}
        cellAspect={cellAspect}
        emptyStateTitle={emptyStateTitle}
      />
    );
  }

  if (tiles.length === 0) {
    return (
      <Box width={width} height={height} paddingX={1} paddingY={1}>
        <Text fg={colors.textDim}>{t(emptyStateTitle ?? "No chart data")}</Text>
      </Box>
    );
  }

  return (
    <Box width={width} height={height} paddingX={1} backgroundColor={colors.bg}>
      <Box position="relative" width={chartWidth} height={height} backgroundColor={colors.bg}>
        {tiles.map((tile) => (
          <Tile
            key={tile.item.id}
            tile={tile}
            selected={tile.item.id === selectedId}
            onSelect={() => onSelect(tile.item)}
            onActivate={onActivate ? () => onActivate(tile.item) : undefined}
            pointerMoved={pointerMoved}
          />
        ))}
      </Box>
    </Box>
  );
}
