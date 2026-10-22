import { Box, Text } from "../../../ui";
import { colors as themeColors, hoverBg } from "../../../theme/colors";
import { consumeChartMouseEvent, type ChartMouseEvent } from "../core/pointer";
import { CHART_DRAWING_COLORS, type ChartToolKind } from "./tools";
import { CHART_TOOLS } from "./tool-catalog";

/** Icon cells plus the gap between chips. */
export const CHART_TOOLBAR_WIDTH = CHART_TOOLS.length * 3 + (CHART_TOOLS.length - 1);

/** The bar's own button that folds it away, and the one it folds to. */
const FOLD_BUTTON = {
  label: "Hide drawing tools (Shift+T)",
  glyph: "\u2039",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};
const UNFOLD_BUTTON = {
  label: "Show drawing tools (Shift+T)",
  glyph: "\u203a",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

function ChartToolButton({
  tool,
  active,
  isDesktopWeb,
  onPress,
  role = "composite-chart-tool",
  reveal,
}: {
  tool: { label: string; glyph: string; icon: string; shortcut?: string; hint?: string };
  active: boolean;
  isDesktopWeb: boolean;
  onPress: () => void;
  role?: string;
  /** Drawn only while the pointer is over the bar (desktop and web). */
  reveal?: boolean;
}) {
  const label = tool.shortcut ? `${tool.label} (${tool.shortcut}). ${tool.hint}` : tool.label;
  const color = active ? themeColors.text : themeColors.textDim;
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
      cursor="pointer"
      data-gloom-interactive="true"
      data-gloom-role={role}
      data-gloom-label={label}
      data-gloom-reveal={reveal ? "hover" : undefined}
      data-active={active ? "true" : "false"}
      title={isDesktopWeb ? label : undefined}
      // A tool is a toggle button: the icon button family, pressed while it is the chart's tool.
      role={isDesktopWeb ? "button" : undefined}
      aria-label={isDesktopWeb ? label : undefined}
      aria-pressed={isDesktopWeb ? active : undefined}
      // Cells size the terminal strip; the desktop chip sizes to its icon.
      // The icon button's look: the control radius, the hover fill.
      style={isDesktopWeb ? { width: "auto", paddingInline: "var(--gloom-space-xs)", borderRadius: "var(--gloom-radius-md)" } : undefined}
    >
      {isDesktopWeb ? (
        <Box
          flexShrink={0}
          style={{
            width: 13,
            height: 13,
            backgroundColor: color,
            maskImage: svgMaskUrl(tool.icon),
            WebkitMaskImage: svgMaskUrl(tool.icon),
            maskSize: "contain",
            WebkitMaskSize: "contain",
            maskRepeat: "no-repeat",
            WebkitMaskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskPosition: "center",
          }}
        />
      ) : (
        <Text fg={color}>{tool.glyph}</Text>
      )}
    </Box>
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
  folded,
  onToggleFolded,
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
  /** Hidden by the user: the bar is the one button that brings it back. */
  folded: boolean;
  /** Folds the bar away, from the button it shows under the pointer, or opens it again. */
  onToggleFolded: () => void;
  onArmTool: (tool: ChartToolKind | null) => void;
  onPickColor: (color: string) => void;
}) {
  return (
    <Box
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
      data-gloom-reveal-scope="true"
      data-folded={folded ? "true" : undefined}
    >
      {folded ? (
        <ChartToolButton
          tool={UNFOLD_BUTTON}
          active={false}
          isDesktopWeb={isDesktopWeb}
          onPress={onToggleFolded}
          role="composite-chart-toolbar-toggle"
        />
      ) : null}
      {folded ? null : CHART_TOOLS.filter((tool) => levelTool || tool.kind !== "level").map((tool) => (
        <ChartToolButton
          key={tool.kind ?? "pan"}
          tool={tool}
          active={armedTool === tool.kind}
          isDesktopWeb={isDesktopWeb}
          onPress={() => onArmTool(tool.kind)}
        />
      ))}
      {/* Colours only take space while something can use them. */}
      {!folded && showColors ? CHART_DRAWING_COLORS.map((color) => (
        <ChartColorSwatch
          key={color}
          color={color}
          active={color === drawColor}
          isDesktopWeb={isDesktopWeb}
          onPress={() => onPickColor(color)}
        />
      )) : null}
      {/* The way to fold the bar shows under the pointer, so a chart at rest
          draws the bar as it always has; the terminal has Shift+T and the menu. */}
      {!folded && isDesktopWeb ? (
        <ChartToolButton
          tool={FOLD_BUTTON}
          active={false}
          isDesktopWeb={isDesktopWeb}
          onPress={onToggleFolded}
          role="composite-chart-toolbar-toggle"
          reveal
        />
      ) : null}
    </Box>
  );
}
