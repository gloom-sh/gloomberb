import { Box, Text } from "../../../ui";
import { colors as themeColors, hoverBg } from "../../../theme/colors";
import { consumeChartMouseEvent, type ChartMouseEvent } from "../core/pointer";
import { CHART_DRAWING_COLORS, type ChartToolKind } from "./tools";
import { CHART_TOOLS } from "./tool-catalog";

/** Icon cells plus the gap between chips. */
export const CHART_TOOLBAR_WIDTH = CHART_TOOLS.length * 3 + (CHART_TOOLS.length - 1);

function ChartToolChip({
  tool,
  active,
  isDesktopWeb,
  onPress,
}: {
  tool: (typeof CHART_TOOLS)[number];
  active: boolean;
  isDesktopWeb: boolean;
  onPress: () => void;
}) {
  const label = `${tool.label} (${tool.shortcut}). ${tool.hint}`;
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
      data-gloom-role="composite-chart-tool"
      data-gloom-label={label}
      data-active={active ? "true" : "false"}
      title={isDesktopWeb ? label : undefined}
      // Cells size the terminal strip; the desktop chip sizes to its icon.
      style={isDesktopWeb ? { width: "auto", paddingInline: 4, borderRadius: 4 } : undefined}
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
          borderRadius: 999,
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
          gap: 3,
          padding: 3,
          borderRadius: 7,
          backgroundColor: `color-mix(in srgb, ${themeColors.bg} 78%, transparent)`,
          backdropFilter: "blur(6px)",
          width: "auto",
          height: "auto",
        }
        : undefined}
      data-gloom-role="composite-chart-toolbar"
    >
      {CHART_TOOLS.filter((tool) => levelTool || tool.kind !== "level").map((tool) => (
        <ChartToolChip
          key={tool.kind ?? "pan"}
          tool={tool}
          active={armedTool === tool.kind}
          isDesktopWeb={isDesktopWeb}
          onPress={() => onArmTool(tool.kind)}
        />
      ))}
      {/* Colours only take space while something can use them. */}
      {showColors ? CHART_DRAWING_COLORS.map((color) => (
        <ChartColorSwatch
          key={color}
          color={color}
          active={color === drawColor}
          isDesktopWeb={isDesktopWeb}
          onPress={() => onPickColor(color)}
        />
      )) : null}
    </Box>
  );
}
