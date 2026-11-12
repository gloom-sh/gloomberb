import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Text, useShortcutLabel, type BoxRenderable } from "../../../ui";
import { colors as themeColors, hoverBg } from "../../../theme/colors";
import { consumeChartMouseEvent, type ChartMouseEvent } from "../core/pointer";
import { CHART_DRAWING_COLORS, type ChartToolKind } from "./tools";
import { CHART_TOOLS } from "./tool-catalog";

/** The bar's tools, a gap, and the handle that opens it. */
export const CHART_TOOLBAR_WIDTH = CHART_TOOLS.length * 3 + (CHART_TOOLS.length - 1) + 4;

/** How long the bar stays open once the pointer has left it. */
export const CHART_TOOLBAR_FOLD_DELAY_MS = 300;

const SHORTCUT = "Shift+T";
/** The handle's icon and its hint, in px on the desktop: together they fix its width, so it keeps it when the bar opens. */
const HANDLE_ICON_PX = 13;
const HANDLE_HINT_PX = 9;
const HANDLE_WIDTH = `calc(var(--gloom-space-xs) * 2 + ${HANDLE_ICON_PX + HANDLE_HINT_PX}px)`;
/** The hint on the folded handle: the bar opens to its right. */
const OPEN_CHEVRON = {
  glyph: "\u203a",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};
/** The handle of a bar kept open, which folds it. */
const FOLD_CHEVRON = {
  glyph: "\u2039",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

interface PressEventLike {
  key?: string;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

/** One of the chart's icon buttons: the control radius, the icon button's hover fill, a 13px icon. */
function ChartIconButton({
  label,
  active,
  isDesktopWeb,
  onPress,
  role = "composite-chart-tool",
  pressed,
  expanded,
  width,
  onHover,
  children,
}: {
  label: string;
  /** The pointer came onto the button. */
  onHover?: () => void;
  active: boolean;
  isDesktopWeb: boolean;
  onPress: () => void;
  role?: string;
  /** A toggle: pressed while it is the chart's tool. */
  pressed?: boolean;
  /** A disclosure: open while the bar shows its tools. */
  expanded?: boolean;
  /** The desktop button's width when it is not its icon's (CSS length). */
  width?: string;
  /** Terminal cells for a glyph, or the desktop's masks. */
  children: ReactNode;
}) {
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      width={3}
      height={1}
      flexShrink={0}
      backgroundColor={active ? themeColors.selected : undefined}
      hoverBackgroundColor={hoverBg()}
      onMouseDown={(event: ChartMouseEvent) => {
        consumeChartMouseEvent(event);
        onPress();
      }}
      onMouseOver={onHover}
      cursor="pointer"
      data-gloom-interactive="true"
      data-gloom-role={role}
      data-gloom-label={label}
      data-active={active ? "true" : "false"}
      title={isDesktopWeb ? label : undefined}
      role={isDesktopWeb ? "button" : undefined}
      aria-label={isDesktopWeb ? label : undefined}
      aria-pressed={isDesktopWeb ? pressed : undefined}
      aria-expanded={isDesktopWeb ? expanded : undefined}
      // Focusable for assistive technology, which opens the bar with the focus.
      // The keyboard's own way is Shift+T: the window keeps Tab for itself.
      tabIndex={isDesktopWeb ? 0 : undefined}
      onKeyDown={isDesktopWeb
        ? (event: PressEventLike) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault?.();
          event.stopPropagation?.();
          onPress();
        }
        : undefined}
      // Cells size the terminal strip; the desktop chip sizes to its icon.
      // The icon button's look: the control radius, the hover fill.
      style={isDesktopWeb ? { width: width ?? "auto", paddingInline: "var(--gloom-space-xs)", borderRadius: "var(--gloom-radius-md)" } : undefined}
    >
      {children}
    </Box>
  );
}

function MaskIcon({ icon, color, size = HANDLE_ICON_PX, visible = true }: { icon: string; color: string; size?: number; visible?: boolean }) {
  return (
    <Box
      flexShrink={0}
      visible={visible}
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        maskImage: svgMaskUrl(icon),
        WebkitMaskImage: svgMaskUrl(icon),
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskPosition: "center",
        WebkitMaskPosition: "center",
      }}
    />
  );
}

type ChartToolEntry = { label: string; glyph: string; icon: string; shortcut?: string; hint?: string };

/** A tool's name with its key: "Trend line (T)". */
function useToolName(): (tool: ChartToolEntry) => string {
  const keyLabel = useShortcutLabel();
  return (tool) => tool.shortcut ? `${tool.label} (${keyLabel(tool.shortcut)})` : tool.label;
}

function ChartToolButton({
  tool,
  active,
  isDesktopWeb,
  onPress,
  onHover,
}: {
  tool: ChartToolEntry;
  active: boolean;
  isDesktopWeb: boolean;
  onPress: () => void;
  onHover?: () => void;
}) {
  const named = useToolName()(tool);
  const label = tool.hint ? `${named}. ${tool.hint}` : named;
  const color = active ? themeColors.text : themeColors.textDim;
  return (
    <ChartIconButton label={label} active={active} pressed={active} isDesktopWeb={isDesktopWeb} onPress={onPress} onHover={onHover}>
      {isDesktopWeb ? <MaskIcon icon={tool.icon} color={color} /> : <Text fg={color}>{tool.glyph}</Text>}
    </ChartIconButton>
  );
}

/**
 * The bar's one fixed button, first in it so the pointer that opened the bar
 * is still on it. Folded, it shows the tool in hand, with a hint that it
 * opens; open, only the chevron, which keeps the bar open or lets it fold.
 */
function ChartToolbarHandle({
  tool,
  armed,
  expanded,
  pinned,
  isDesktopWeb,
  onPress,
}: {
  tool: { label: string; glyph: string; icon: string };
  /** A tool is in hand, not the resting pan. */
  armed: boolean;
  expanded: boolean;
  pinned: boolean;
  isDesktopWeb: boolean;
  onPress: () => void;
}) {
  const keyLabel = useShortcutLabel();
  const keys = keyLabel(SHORTCUT);
  const label = expanded
    ? pinned ? `Hide drawing tools (${keys})` : `Keep drawing tools open (${keys})`
    : `${tool.label}. Show drawing tools (${keys})`;
  const color = armed ? themeColors.text : themeColors.textDim;
  const chevron = pinned ? FOLD_CHEVRON : OPEN_CHEVRON;
  return (
    <ChartIconButton
      label={label}
      active={armed && !expanded}
      expanded={expanded}
      width={HANDLE_WIDTH}
      isDesktopWeb={isDesktopWeb}
      onPress={onPress}
      role="composite-chart-toolbar-toggle"
    >
      {isDesktopWeb ? (
        <>
          {/* Hidden, not removed, once the bar is open: the pointer that opened it is on this icon, and a press that lands as the bar opens still reaches the button.
              The button keeps its width, so a pointer that came in at its edge is still on it. */}
          <MaskIcon icon={tool.icon} color={color} visible={!expanded} />
          <MaskIcon icon={chevron.icon} color={themeColors.textDim} size={expanded ? HANDLE_ICON_PX : HANDLE_HINT_PX} />
        </>
      ) : (
        <Text fg={color}>{expanded ? chevron.glyph : `${tool.glyph}${chevron.glyph}`}</Text>
      )}
    </ChartIconButton>
  );
}

function svgMaskUrl(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function ChartColorSwatch({
  color,
  active,
  isDesktopWeb,
  onPress,
}: {
  color: string;
  active: boolean;
  isDesktopWeb: boolean;
  onPress: () => void;
}) {
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      width={2}
      height={1}
      flexShrink={0}
      backgroundColor={active ? themeColors.selected : undefined}
      hoverBackgroundColor={hoverBg()}
      onMouseDown={(event: ChartMouseEvent) => {
        consumeChartMouseEvent(event);
        onPress();
      }}
      cursor="pointer"
      data-gloom-interactive="true"
      data-gloom-role="composite-chart-color"
      data-gloom-label={`Drawing colour ${color}`}
      data-active={active ? "true" : "false"}
      style={isDesktopWeb
        ? {
          width: 14,
          height: 14,
          borderRadius: "var(--gloom-radius-full)",
          backgroundColor: color,
          border: `1.5px solid ${active ? themeColors.text : "transparent"}`,
        }
        : undefined}
    >
      {isDesktopWeb ? null : <Text fg={color}>{active ? "\u25c9" : "\u25cf"}</Text>}
    </Box>
  );
}

export function ChartToolbar({
  armedTool,
  isDesktopWeb,
  left,
  top,
  drawColor,
  showColors,
  levelTool,
  pinned,
  onTogglePinned,
  onArmTool,
  onPickColor,
}: {
  armedTool: ChartToolKind | null;
  isDesktopWeb: boolean;
  left: number;
  top: number;
  drawColor: string;
  showColors: boolean;
  /** The chart's levels can be edited here. */
  levelTool: boolean;
  /** Kept open by the user. Otherwise the bar is folded to the tool in hand and opens under the pointer. */
  pinned: boolean;
  /** Keeps the bar open, or lets it fold again. */
  onTogglePinned: () => void;
  onArmTool: (tool: ChartToolKind | null) => void;
  onPickColor: (color: string) => void;
}) {
  const barRef = useRef<BoxRenderable | null>(null);
  const { open, onHover, onLeave, onFocus, onBlur, fold } = useToolbarOpening(barRef);
  const expanded = pinned || open;
  const tool = CHART_TOOLS.find((entry) => entry.kind === armedTool) ?? CHART_TOOLS[0]!;
  const toolName = useToolName();
  // The terminal has no tooltip, so the open bar names the tool under the
  // pointer, else the one in hand, after its glyphs (review, 12 Nov 2026:
  // `✥ ↔ ⊞ ╱ ∿` read as nothing).
  const [hoveredTool, setHoveredTool] = useState<(typeof CHART_TOOLS)[number] | null>(null);
  const captionTool = hoveredTool ?? tool;
  return (
    <Box
      ref={barRef}
      position="absolute"
      left={left}
      top={top}
      height={1}
      flexDirection="row"
      gap={1}
      zIndex={30}
      backgroundColor={themeColors.bg}
      style={isDesktopWeb
        ? {
          gap: "var(--gloom-space-xs)",
          padding: "var(--gloom-space-xs)",
          borderRadius: "var(--gloom-radius-lg)",
          backgroundColor: `color-mix(in srgb, ${themeColors.bg} 78%, transparent)`,
          backdropFilter: "blur(6px)",
          width: "auto",
          height: "auto",
        }
        : undefined}
      data-gloom-role="composite-chart-toolbar"
      data-folded={expanded ? undefined : "true"}
      data-pinned={pinned ? "true" : undefined}
      onMouseOver={onHover}
      onMouseOut={(event: ChartMouseEvent) => {
        onLeave(event);
        if (!pointerOnBar(barRef.current, event)) setHoveredTool(null);
      }}
      onFocus={isDesktopWeb ? onFocus : undefined}
      onBlur={isDesktopWeb ? onBlur : undefined}
    >
      <ChartToolbarHandle
        tool={tool}
        armed={armedTool !== null}
        expanded={expanded}
        pinned={pinned}
        isDesktopWeb={isDesktopWeb}
        onPress={() => {
          // Pressed while the bar is open only for the pointer or the focus,
          // it stays open; pressed while kept open, it folds now.
          if (pinned) fold();
          onTogglePinned();
        }}
      />
      {expanded ? CHART_TOOLS.filter((entry) => levelTool || entry.kind !== "level").map((entry) => (
        <ChartToolButton
          key={entry.kind ?? "pan"}
          tool={entry}
          active={armedTool === entry.kind}
          isDesktopWeb={isDesktopWeb}
          onPress={() => onArmTool(entry.kind)}
          onHover={isDesktopWeb ? undefined : () => setHoveredTool(entry)}
        />
      )) : null}
      {/* Colours only take space while something can use them. */}
      {expanded && showColors ? CHART_DRAWING_COLORS.map((color) => (
        <ChartColorSwatch
          key={color}
          color={color}
          active={color === drawColor}
          isDesktopWeb={isDesktopWeb}
          onPress={() => onPickColor(color)}
        />
      )) : null}
      {expanded && !isDesktopWeb ? (
        <Text fg={themeColors.textDim} data-gloom-role="composite-chart-tool-name">{toolName(captionTool)}</Text>
      ) : null}
    </Box>
  );
}

const TOOLBAR_SELECTOR = "[data-gloom-role=composite-chart-toolbar]";

/**
 * Whether a pointer event lies on the bar. A mouseout between two of its icons
 * does, and is no leaving. The desktop reads the bar's own box in px; the
 * terminal compares its cells.
 */
function pointerOnBar(bar: BoxRenderable | null, event: ChartMouseEvent): boolean {
  const element = event.target?.closest?.(TOOLBAR_SELECTOR) as { getBoundingClientRect?: () => DOMRect } | null | undefined;
  if (element?.getBoundingClientRect && typeof event.pixelX === "number" && typeof event.pixelY === "number") {
    const box = element.getBoundingClientRect();
    return event.pixelX >= box.left && event.pixelX < box.right && event.pixelY >= box.top && event.pixelY < box.bottom;
  }
  if (!bar || typeof event.x !== "number" || typeof event.y !== "number") return false;
  const x = Number(bar.x);
  const y = Number(bar.y);
  return event.x >= x && event.x < x + Number(bar.width) && event.y >= y && event.y < y + Number(bar.height);
}

/**
 * Whether the pointer or assistive focus has the bar open: the pointer opens it
 * at once and keeps it open for a moment after it leaves the bar.
 */
function useToolbarOpening(bar: { current: BoxRenderable | null }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insideRef = useRef(false);
  // Folded by a press under the pointer: it stays folded until the pointer has left the bar.
  const foldedUnderPointerRef = useRef(false);
  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  useEffect(() => clearTimer, [clearTimer]);
  const onHover = useCallback(() => {
    clearTimer();
    insideRef.current = true;
    if (!foldedUnderPointerRef.current) setHovered(true);
  }, [clearTimer]);
  const onLeave = useCallback((event: ChartMouseEvent) => {
    // From one icon to the next, or into the gap between: still on the bar.
    if (pointerOnBar(bar.current, event)) return;
    clearTimer();
    insideRef.current = false;
    // Back within the delay, it opens: the press that folded it is over.
    foldedUnderPointerRef.current = false;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setHovered(false);
    }, CHART_TOOLBAR_FOLD_DELAY_MS);
  }, [bar, clearTimer]);
  const fold = useCallback(() => {
    foldedUnderPointerRef.current = insideRef.current;
    setHovered(false);
    setFocused(false);
  }, []);
  // A press focuses a button too; only focus that shows its ring (assistive technology's) opens the bar.
  const onFocus = useCallback((event: { target?: unknown }) => {
    const target = event.target as { matches?: (selector: string) => boolean } | null;
    if (target?.matches?.(":focus-visible") === true) setFocused(true);
  }, []);
  const onBlur = useCallback((event: { currentTarget?: unknown; relatedTarget?: unknown }) => {
    const root = event.currentTarget as { contains?: (node: unknown) => boolean } | null;
    if (event.relatedTarget && root?.contains?.(event.relatedTarget)) return;
    setFocused(false);
  }, []);
  return { open: hovered || focused, onHover, onLeave, onFocus, onBlur, fold };
}
