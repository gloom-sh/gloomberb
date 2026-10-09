import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../ui";
import { blendHex } from "../../theme/colors";
import {
  heatmapColorDistance,
  resolveHeatmapSelectedTileColors,
  resolveHeatmapSelectionRing,
  resolveHeatmapTileColors,
} from "../../theme/heat-colors";
import { useThemeColors } from "../../theme/theme-context";
import { t } from "../../i18n";
import { clipToDisplayWidth, padTo } from "../../utils/format";
import type { FloatMetricTreemapTile, MetricTreemapItem } from "./layout";
import {
  buildMetricTreemapScene,
  type MetricTreemapHeader,
  type MetricTreemapScene,
  type MetricTreemapSceneOptions,
  type TreemapRect,
} from "./scene";
import {
  HeatPulseTracker,
  heatTileLabelCells,
  heatTileLabelPx,
  heatTileMotion,
  heatTileValueWithSuffix,
} from "./heat-tiles";

type PreventableMouseEvent = { preventDefault(): void };
type PointerEvent = { x?: number; y?: number; pixelX?: number; pixelY?: number; source?: unknown };

export interface HeatTreemapCanvas {
  /** Layout units: px on the desktop and the web, cells in the terminal. */
  width: number;
  height: number;
  options: MetricTreemapSceneOptions;
}

const NARROW_CANVAS_PX = 600;

/**
 * The canvas a heat map is laid out on. The pane and the surface both build
 * the scene from this, so keyboard navigation walks the tiles the user sees.
 */
export function heatTreemapCanvas(
  width: number,
  height: number,
  capabilities: { nativePaneChrome?: boolean; cellWidthPx?: number; cellHeightPx?: number },
): HeatTreemapCanvas {
  const cellWidthPx = capabilities.cellWidthPx ?? 8;
  const cellHeightPx = capabilities.cellHeightPx ?? 18;
  if (capabilities.nativePaneChrome) {
    const pxWidth = Math.max(1, width * cellWidthPx);
    const pxHeight = Math.max(1, height * cellHeightPx);
    const narrow = pxWidth < NARROW_CANVAS_PX;
    return {
      width: pxWidth,
      height: pxHeight,
      options: {
        snap: false,
        aspect: 1,
        groupInset: narrow ? 1.5 : 2,
        subgroupInset: 1,
        headerHeight: narrow ? [14, 12] : [16, 13],
        headerMin: [{ width: 44, height: 40 }, { width: 84, height: 56 }],
        minTile: { width: 7, height: 7 },
      },
    };
  }
  return {
    width: Math.max(1, width - 2),
    height: Math.max(1, height),
    options: {
      snap: true,
      aspect: Math.max(0.5, Math.min(4, cellHeightPx / Math.max(1, cellWidthPx))),
      groupInset: 0,
      subgroupInset: 0,
      headerHeight: [1, 1],
      headerMin: [{ width: 8, height: 4 }, { width: 16, height: 7 }],
      minTile: { width: 3, height: 1 },
    },
  };
}

export function buildHeatTreemapScene<T>(
  items: readonly MetricTreemapItem<T>[],
  canvas: HeatTreemapCanvas,
  previous?: MetricTreemapScene<T> | null,
): MetricTreemapScene<T> {
  return buildMetricTreemapScene(items, canvas.width, canvas.height, canvas.options, previous);
}

export interface HeatTreemapSurfaceProps<T> {
  /** Geometry, from `buildHeatTreemapScene`; rebuilt only when sizes change. */
  scene: MetricTreemapScene<T>;
  /** Current colours and text, by id; they change with every tick. */
  items: readonly MetricTreemapItem<T>[];
  width: number;
  height: number;
  selectedId: string | null;
  onSelect: (item: MetricTreemapItem<T>) => void;
  onActivate?: (item: MetricTreemapItem<T>) => void;
  emptyStateTitle?: string;
  /** Hover text for the Other block, given the names it holds. */
  otherTooltip?: (items: readonly MetricTreemapItem<T>[]) => readonly string[];
  /** One short line under the Other label, where there is room for it. */
  otherSummary?: (items: readonly MetricTreemapItem<T>[]) => string;
}

interface SurfaceEvents {
  select(id: string): void;
  activate(id: string): void;
  hover(id: string, event: PointerEvent | undefined, selects: boolean): void;
  leave(id: string): void;
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * Hover selects the tile under the pointer only when the pointer really moved:
 * a relayout under a resting pointer must not take the keyboard's selection.
 */
function usePointerMoved(): (event: PointerEvent | undefined) => boolean {
  const lastRef = useRef<string | null>(null);
  return useMemo(() => (event: PointerEvent | undefined) => {
    const x = event?.pixelX ?? event?.x;
    const y = event?.pixelY ?? event?.y;
    if (typeof x !== "number" || typeof y !== "number") return true;
    const position = `${x}:${y}`;
    if (lastRef.current === position) return false;
    lastRef.current = position;
    return true;
  }, []);
}

interface MediaQueryLike {
  matches: boolean;
  addEventListener?(type: "change", listener: () => void): void;
  removeEventListener?(type: "change", listener: () => void): void;
}

function reducedMotionQuery(): MediaQueryLike | null {
  const matchMedia = (globalThis as { matchMedia?: (query: string) => MediaQueryLike }).matchMedia;
  return typeof matchMedia === "function" ? matchMedia.call(globalThis, "(prefers-reduced-motion: reduce)") : null;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reducedMotionQuery()?.matches === true);
  useEffect(() => {
    const query = reducedMotionQuery();
    if (!query) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

function useSurfaceEvents<T>(
  itemsById: ReadonlyMap<string, MetricTreemapItem<T>>,
  onSelect: (item: MetricTreemapItem<T>) => void,
  onActivate: ((item: MetricTreemapItem<T>) => void) | undefined,
  onHover?: (id: string | null, event: PointerEvent | undefined) => void,
): SurfaceEvents {
  const latest = useLatest({ itemsById, onSelect, onActivate, onHover });
  const pointerMoved = usePointerMoved();
  return useMemo<SurfaceEvents>(() => ({
    select(id) {
      const item = latest.current.itemsById.get(id);
      if (item) latest.current.onSelect(item);
    },
    activate(id) {
      const item = latest.current.itemsById.get(id);
      if (item) latest.current.onActivate?.(item);
    },
    hover(id, event, selects) {
      latest.current.onHover?.(id, event);
      if (!selects || !pointerMoved(event)) return;
      const item = latest.current.itemsById.get(id);
      if (item) latest.current.onSelect(item);
    },
    leave(id) {
      latest.current.onHover?.(null, undefined);
      void id;
    },
  }), [latest, pointerMoved]);
}

function pct(value: number, total: number): string {
  return `${total > 0 ? value / total * 100 : 0}%`;
}

function useItemsById<T>(scene: MetricTreemapScene<T>, items: readonly MetricTreemapItem<T>[]) {
  return useMemo(() => {
    const byId = new Map<string, MetricTreemapItem<T>>();
    for (const tile of scene.tiles) byId.set(tile.item.id, tile.item);
    for (const item of items) byId.set(item.id, item);
    return byId;
  }, [items, scene]);
}

// ---------------------------------------------------------------------------
// Desktop and web: real DOM boxes, CSS transitions for fades and glides.

const VISIBLE_FADE_DISTANCE = 0.03;

const DomHeatTile = memo(function DomHeatTile({
  id, rect, canvasWidth, canvasHeight, gap, label, value, valueSuffix, background, foreground,
  selected, reducedMotion, glide, pulseCount, events,
}: {
  id: string;
  rect: TreemapRect;
  canvasWidth: number;
  canvasHeight: number;
  gap: number;
  label: string;
  value: string | null;
  valueSuffix: string | null;
  background: string;
  foreground: string;
  selected: boolean;
  reducedMotion: boolean;
  glide: boolean;
  pulseCount: number;
  events: SurfaceEvents;
}) {
  const text = heatTileLabelPx(rect.width - gap * 2, rect.height - gap * 2, label, value);
  const shownValue = heatTileValueWithSuffix(value, valueSuffix, { width: rect.width - gap * 2, valuePx: text.valuePx });
  // Where this tile sat before the last relayout, kept to slide it from there.
  const placedRef = useRef(rect);
  const glideRef = useRef<{ dx: number; dy: number; count: number }>({ dx: 0, dy: 0, count: 0 });
  if (placedRef.current !== rect) {
    const dx = placedRef.current.x - rect.x;
    const dy = placedRef.current.y - rect.y;
    if (glide && (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5)) {
      glideRef.current = { dx, dy, count: glideRef.current.count + 1 };
    }
    placedRef.current = rect;
  }
  const motion = heatTileMotion({ reducedMotion, glide, glideCount: glideRef.current.count, pulseCount });
  const colors = useThemeColors();
  const ring = resolveHeatmapSelectionRing(colors);
  // The colour this tile showed before, kept to fade out over the new one.
  const shownRef = useRef(background);
  const fadeRef = useRef<{ from: string; key: number } | null>(null);
  const paletteRef = useRef(colors);
  // A theme switch recolours every tile at once; only a move fades.
  const themeChanged = paletteRef.current !== colors;
  paletteRef.current = colors;
  if (shownRef.current !== background) {
    // A step too small to see snaps: a fade costs a compositor layer for its whole run.
    const visible = heatmapColorDistance(shownRef.current, background) >= VISIBLE_FADE_DISTANCE;
    if (!motion.fadeAnimation || themeChanged) fadeRef.current = null;
    else if (visible) fadeRef.current = { from: shownRef.current, key: (fadeRef.current?.key ?? 0) + 1 };
    shownRef.current = background;
  }
  const fade = fadeRef.current;
  // A finished overlay leaves the DOM, so idle tiles carry no extra nodes.
  const [, setOverlayVersion] = useState(0);
  const pulseDoneRef = useRef(0);
  const pulsing = motion.pulseAnimation != null && pulseCount > pulseDoneRef.current;
  const style: CSSProperties = {
    position: "absolute",
    left: `calc(${pct(rect.x, canvasWidth)} + ${gap}px)`,
    top: `calc(${pct(rect.y, canvasHeight)} + ${gap}px)`,
    width: `max(1px, calc(${pct(rect.width, canvasWidth)} - ${gap * 2}px))`,
    height: `max(1px, calc(${pct(rect.height, canvasHeight)} - ${gap * 2}px))`,
    backgroundColor: background,
    color: foreground,
    borderRadius: 1,
    overflow: "hidden",
    // A tick restyles one tile; containment keeps it from re-laying out or repainting its neighbours.
    contain: "strict",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 0,
    cursor: "pointer",
    // The theme's text tone against the page, then a hairline of the page: one
    // of the two stands out on any tile, bright or dim.
    boxShadow: selected ? `inset 0 0 0 2px ${ring.outer}, inset 0 0 0 3px ${ring.inner}` : undefined,
    zIndex: selected ? 1 : undefined,
    ...(motion.glideAnimation
      ? {
        "--heat-glide-x": `${glideRef.current.dx}px`,
        "--heat-glide-y": `${glideRef.current.dy}px`,
        animation: motion.glideAnimation,
      } as CSSProperties
      : {}),
  };
  const overlayStyle: CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
  };
  const lineStyle: CSSProperties = {
    position: "relative",
    display: "block",
    maxWidth: "100%",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textAlign: "center",
    letterSpacing: 0,
    color: foreground,
  };
  return (
    <Box
      data-gloom-role="heat-tile"
      style={style}
      onMouseDown={(event: PreventableMouseEvent) => {
        event.preventDefault();
        events.select(id);
      }}
      onDoubleClick={() => events.activate(id)}
      onMouseOver={(event: PointerEvent) => events.hover(id, event, false)}
      onMouseMove={(event: PointerEvent) => events.hover(id, event, true)}
      onMouseOut={() => events.leave(id)}
    >
      {fade && (
        <Box
          key={`fade:${fade.key}`}
          // Invisible at rest: if animations are off the old colour must not stay on top.
          style={{ ...overlayStyle, backgroundColor: fade.from, opacity: 0, animation: motion.fadeAnimation }}
          onAnimationEnd={() => {
            if (fadeRef.current?.key !== fade.key) return;
            fadeRef.current = null;
            setOverlayVersion((version) => version + 1);
          }}
        />
      )}
      {pulsing && (
        <Box
          key={`pulse:${pulseCount}`}
          style={{ ...overlayStyle, backgroundColor: "#ffffff", opacity: 0, animation: motion.pulseAnimation }}
          onAnimationEnd={() => {
            pulseDoneRef.current = Math.max(pulseDoneRef.current, pulseCount);
            setOverlayVersion((version) => version + 1);
          }}
        />
      )}
      {text.tier !== "none" && (
        <Text style={{ ...lineStyle, fontSize: text.tickerPx, fontWeight: 700, lineHeight: 1.12 }}>{label}</Text>
      )}
      {text.tier === "full" && value && (
        <Text style={{ ...lineStyle, fontSize: text.valuePx, fontWeight: 500, lineHeight: 1.12 }}>{shownValue}</Text>
      )}
    </Box>
  );
});

function headerLabel(header: MetricTreemapHeader): string {
  return header.other ? t("Other") : header.label;
}

function DomHeader({ header, canvasWidth, canvasHeight }: { header: MetricTreemapHeader; canvasWidth: number; canvasHeight: number }) {
  const colors = useThemeColors();
  const sector = header.level === 0 && !header.other;
  return (
    <Box
      data-gloom-role="heat-header"
      style={{
        position: "absolute",
        left: pct(header.rect.x, canvasWidth),
        top: pct(header.rect.y, canvasHeight),
        width: pct(header.rect.width, canvasWidth),
        height: pct(header.rect.height, canvasHeight),
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-start",
        paddingLeft: 2,
        overflow: "hidden",
        pointerEvents: "none",
      }}
    >
      <Text
        style={{
          display: "block",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          fontSize: header.level === 0 ? 10.5 : 9,
          fontWeight: header.level === 0 ? 700 : 600,
          lineHeight: 1,
          color: sector ? colors.textBright : colors.textDim,
        }}
      >
        {headerLabel(header)}
      </Text>
    </Box>
  );
}

interface TooltipState {
  id: string;
  x: number;
  y: number;
  boundsWidth: number;
  boundsHeight: number;
}

const OTHER_ID = "\u0000other";

function DomTooltip<T>({ state, itemsById, otherLines }: {
  state: TooltipState | null;
  itemsById: ReadonlyMap<string, MetricTreemapItem<T>>;
  otherLines: readonly string[] | null;
}) {
  const colors = useThemeColors();
  if (!state) return null;
  const lines = state.id === OTHER_ID
    ? otherLines
    : itemsById.get(state.id)?.tooltip ?? [itemsById.get(state.id)?.label ?? ""];
  if (!lines || lines.length === 0) return null;
  const flipX = state.x > state.boundsWidth * 0.6;
  const flipY = state.y > state.boundsHeight * 0.72;
  return (
    <Box
      data-gloom-role="heat-tooltip"
      style={{
        position: "absolute",
        left: state.x + (flipX ? -12 : 14),
        top: state.y + (flipY ? -10 : 16),
        transform: `translate(${flipX ? "-100%" : "0"}, ${flipY ? "-100%" : "0"})`,
        zIndex: 5,
        pointerEvents: "none",
        backgroundColor: blendHex(colors.bg, colors.panel, 0.5),
        border: `1px solid ${colors.border}`,
        borderRadius: 3,
        padding: "4px 7px",
        boxShadow: `0 4px 14px ${blendHex(colors.bg, "#000000", 0.6)}`,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        maxWidth: 400,
      }}
    >
      {lines.map((line, index) => (
        <Text
          key={index}
          style={{
            display: "block",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            fontSize: 11.5,
            lineHeight: 1.25,
            fontWeight: index === 0 ? 700 : 400,
            color: index === 0 ? colors.textBright : colors.textDim,
          }}
        >
          {line}
        </Text>
      ))}
    </Box>
  );
}

const EMPTY_PULSES: ReadonlyMap<string, number> = new Map();

function DomHeatTreemap<T>({
  scene, items, width, height, selectedId, onSelect, onActivate, otherTooltip, otherSummary: summarizeOther,
}: HeatTreemapSurfaceProps<T>) {
  const reducedMotion = usePrefersReducedMotion();
  const colors = useThemeColors();
  const itemsById = useItemsById(scene, items);
  const chartRef = useRef<{ getBoundingClientRect?: () => { x: number; y: number; width: number; height: number } } | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const onHover = useMemo(() => (id: string | null, event: PointerEvent | undefined) => {
    if (id == null) {
      setTooltip(null);
      return;
    }
    const bounds = chartRef.current?.getBoundingClientRect?.();
    if (!bounds || typeof event?.pixelX !== "number" || typeof event?.pixelY !== "number") return;
    setTooltip({ id, x: event.pixelX - bounds.x, y: event.pixelY - bounds.y, boundsWidth: bounds.width, boundsHeight: bounds.height });
  }, []);
  const events = useSurfaceEvents(itemsById, onSelect, onActivate, onHover);

  const trackerRef = useRef<HeatPulseTracker | null>(null);
  trackerRef.current ??= new HeatPulseTracker();
  const pulses = useMemo(() => {
    if (reducedMotion) return EMPTY_PULSES;
    return trackerRef.current!.update(
      scene.tiles.map((tile) => [tile.item.id, itemsById.get(tile.item.id)?.colorValue ?? null] as const),
      Date.now(),
    );
  }, [itemsById, reducedMotion, scene]);

  // A resize relays out every tile; following the window with a glide would lag it.
  const sizeKey = `${scene.width}x${scene.height}`;
  const lastSizeRef = useRef(sizeKey);
  const glide = lastSizeRef.current === sizeKey;
  useEffect(() => {
    lastSizeRef.current = sizeKey;
  }, [sizeKey]);

  const gap = scene.width < NARROW_CANVAS_PX ? 0.5 : 1;
  const otherLines = useMemo(
    () => (scene.other ? otherTooltip?.(scene.other.items) ?? [`${t("Other")} · ${scene.other.items.length}`] : null),
    [otherTooltip, scene.other],
  );
  const other = scene.other;

  return (
    <Box
      width={width}
      height={height}
      style={{ position: "relative", backgroundColor: colors.bg, overflow: "hidden" }}
    >
      <Box
        ref={chartRef}
        data-gloom-role="heat-treemap"
        style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", contain: "strict" }}
      >
        {scene.headers.map((header) => (
          <DomHeader key={header.id} header={header} canvasWidth={scene.width} canvasHeight={scene.height} />
        ))}
        {other && (
          <Box
            data-gloom-role="heat-other"
            style={{
              position: "absolute",
              left: pct(other.rect.x, scene.width),
              top: pct(other.rect.y, scene.height),
              width: pct(other.rect.width, scene.width),
              height: pct(other.rect.height, scene.height),
              backgroundColor: blendHex(colors.bg, colors.textMuted, 0.1),
              borderRadius: 1,
              overflow: "hidden",
              paddingLeft: 3,
              paddingTop: 2,
            }}
            onMouseOver={(event: PointerEvent) => onHover(OTHER_ID, event)}
            onMouseMove={(event: PointerEvent) => onHover(OTHER_ID, event)}
            onMouseOut={() => onHover(null, undefined)}
          >
            {other.showLabel && (
              <Text style={{ display: "block", fontSize: 10.5, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: colors.textDim, lineHeight: 1.2 }}>
                {t("Other")}
              </Text>
            )}
            {(other.showLabel || (other.rect.width >= 44 && other.rect.height >= 24)) && summarizeOther && (
              <Text style={{ display: "block", fontSize: 10, color: colors.textMuted, lineHeight: 1.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {summarizeOther(other.items)}
              </Text>
            )}
          </Box>
        )}
        {scene.tiles.map((tile) => {
          const item = itemsById.get(tile.item.id) ?? tile.item;
          const tileColors = resolveHeatmapTileColors(item.colorValue, colors);
          return (
            <DomHeatTile
              key={tile.item.id}
              id={tile.item.id}
              rect={tileRect(tile)}
              canvasWidth={scene.width}
              canvasHeight={scene.height}
              gap={gap}
              label={item.label}
              value={item.primaryText ?? null}
              valueSuffix={item.primaryTextSuffix ?? null}
              background={tileColors.background}
              foreground={tileColors.foreground}
              selected={tile.item.id === selectedId}
              reducedMotion={reducedMotion}
              glide={glide}
              pulseCount={pulses.get(tile.item.id) ?? 0}
              events={events}
            />
          );
        })}
        <DomTooltip state={tooltip} itemsById={itemsById} otherLines={otherLines} />
      </Box>
    </Box>
  );
}

const tileRectCache = new WeakMap<object, TreemapRect>();

/** One rect object per tile, so a memoized tile sees the same prop until the layout changes. */
function tileRect(tile: FloatMetricTreemapTile<unknown>): TreemapRect {
  let rect = tileRectCache.get(tile);
  if (!rect) {
    rect = { x: tile.x, y: tile.y, width: tile.width, height: tile.height };
    tileRectCache.set(tile, rect);
  }
  return rect;
}

// ---------------------------------------------------------------------------
// Terminal: whole cells, a one-cell gutter right of and under each tile.

const TerminalHeatTile = memo(function TerminalHeatTile({
  id, x, y, width, height, label, value, valueSuffix, colorValue, selected, events,
}: {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  value: string | null;
  valueSuffix: string | null;
  colorValue: number | null;
  selected: boolean;
  events: SurfaceEvents;
}) {
  // Read here, not passed down: a theme switch reaches every tile even though its props are the same.
  const colors = useThemeColors();
  const { background, foreground } = selected
    ? resolveHeatmapSelectedTileColors(colorValue, colors)
    : resolveHeatmapTileColors(colorValue, colors);
  const renderWidth = Math.max(1, width - (width >= 3 ? 1 : 0));
  const renderHeight = Math.max(1, height - (height >= 2 ? 1 : 0));
  const tier = heatTileLabelCells(renderWidth, renderHeight, label, value);
  const shownValue = heatTileValueWithSuffix(value, valueSuffix, { width: renderWidth });
  const lines = tier === "full" && shownValue ? [label, shownValue] : tier === "none" ? [] : [label];
  const top = Math.max(0, Math.floor((renderHeight - lines.length) / 2));
  return (
    <Box
      position="absolute"
      left={x}
      top={y}
      width={renderWidth}
      height={renderHeight}
      backgroundColor={background}
      onMouseDown={(event: PreventableMouseEvent) => {
        event.preventDefault();
        events.select(id);
      }}
      onMouseMove={(event: PointerEvent) => events.hover(id, event, true)}
      // A held button sends no moves here, only "over" from the press it
      // started; a relayout's "over" has no source.
      onMouseOver={(event: PointerEvent) => {
        if (event.source) events.hover(id, event, true);
      }}
      onDoubleClick={() => events.activate(id)}
    >
      {lines.map((line, index) => (
        <Box key={index} position="absolute" left={0} top={top + index} width={renderWidth} height={1}>
          <Text fg={foreground} attributes={index === 0 ? TextAttributes.BOLD : TextAttributes.NONE}>
            {padTo(line, renderWidth, "center")}
          </Text>
        </Box>
      ))}
    </Box>
  );
});

function TerminalHeatTreemap<T>({
  scene, items, width, height, selectedId, onSelect, onActivate, otherSummary: summarizeOther,
}: HeatTreemapSurfaceProps<T>) {
  const colors = useThemeColors();
  const itemsById = useItemsById(scene, items);
  const events = useSurfaceEvents(itemsById, onSelect, onActivate);
  const other = scene.other;
  const otherSummary = other ? summarizeOther?.(other.items) ?? null : null;
  return (
    <Box width={width} height={height} paddingX={1} backgroundColor={colors.bg}>
      <Box position="relative" width={scene.width} height={scene.height} backgroundColor={colors.bg}>
        {scene.headers.map((header) => (
          <Box key={header.id} position="absolute" left={header.rect.x} top={header.rect.y} width={header.rect.width} height={1}>
            <Text
              fg={header.level === 0 && !header.other ? colors.textBright : colors.textDim}
              attributes={header.level === 0 ? TextAttributes.BOLD : TextAttributes.NONE}
            >
              {clipToDisplayWidth(headerLabel(header).toUpperCase(), Math.max(0, header.rect.width - 1))}
            </Text>
          </Box>
        ))}
        {other && other.rect.width > 0 && other.rect.height > 0 && (
          <Box
            position="absolute"
            left={other.rect.x}
            top={other.rect.y}
            width={Math.max(1, other.rect.width - (other.rect.width >= 3 ? 1 : 0))}
            height={Math.max(1, other.rect.height - (other.rect.height >= 2 ? 1 : 0))}
            backgroundColor={colors.panel}
          >
            {other.showLabel && other.rect.width >= 7 && (
              <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>{clipToDisplayWidth(t("Other").toUpperCase(), other.rect.width - 1)}</Text>
            )}
            {/* A count is whole or absent: "2 nam…" says less than nothing. */}
            {other.rect.height >= (other.showLabel ? 3 : 2) && otherSummary && otherSummary.length <= other.rect.width - 1 && (
              <Text fg={colors.textMuted}>{otherSummary}</Text>
            )}
          </Box>
        )}
        {scene.tiles.map((tile) => {
          const item = itemsById.get(tile.item.id) ?? tile.item;
          return (
            <TerminalHeatTile
              key={tile.item.id}
              id={tile.item.id}
              x={tile.x}
              y={tile.y}
              width={tile.width}
              height={tile.height}
              label={item.label}
              value={item.primaryText ?? null}
              valueSuffix={item.primaryTextSuffix ?? null}
              colorValue={item.colorValue ?? null}
              selected={tile.item.id === selectedId}
              events={events}
            />
          );
        })}
      </Box>
    </Box>
  );
}

/**
 * The heat map look of the treemap: optional sector and industry blocks,
 * calm tiles (ticker, then the move, as space allows), a continuous scale
 * from the theme's down colour to its up colour, and on the desktop a hover
 * tooltip, colour fades, a short pulse on a tile whose move jumps and a glide
 * when sizes change.
 */
export function HeatTreemapSurface<T>(props: HeatTreemapSurfaceProps<T>) {
  const { nativePaneChrome } = useUiCapabilities();
  const colors = useThemeColors();
  if (props.scene.tiles.length === 0) {
    return (
      <Box width={props.width} height={props.height} paddingX={1} paddingY={1}>
        <Text fg={colors.textDim}>{t(props.emptyStateTitle ?? "No chart data")}</Text>
      </Box>
    );
  }
  return nativePaneChrome ? <DomHeatTreemap {...props} /> : <TerminalHeatTreemap {...props} />;
}
