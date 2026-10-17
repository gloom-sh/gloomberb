import { createElement, type CSSProperties } from "react";
import { Box } from "../../../../ui";
import { useThemeColors } from "../../../../theme/theme-context";
import { zoneScaleGeometry, type ZoneScaleProps } from "./model";

const VIEWBOX_WIDTH = 1000;
const VIEWBOX_HEIGHT = 78;
const BAR_TOP = 26;
const BAR_HEIGHT = 14;
const BAR_RADIUS = 7;
const GAP = 3;
const TICK_LABEL_INSET = 34;

export function DesktopZoneColorScale({ indicator, value, width, markerColor }: ZoneScaleProps) {
  const colors = useThemeColors();
  const geometry = zoneScaleGeometry(indicator, value, Math.max(48, width));
  const markerX = geometry.markerFraction * VIEWBOX_WIDTH;
  const barMiddle = BAR_TOP + BAR_HEIGHT / 2;

  // The labels are the page's own text at the app's size, laid over the
  // scale: inside the stretched viewBox they would be drawn squashed.
  return (
    <Box width={width} height={3} overflow="hidden" style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
        width="100%"
        height="100%"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${indicator.label} ${indicator.formatValue(value)} on the valuation scale`}
        style={{ display: "block" }}
      >
        {geometry.bands.map((band, index) => {
          const x = band.startFraction * VIEWBOX_WIDTH;
          const barWidth = (band.endFraction - band.startFraction) * VIEWBOX_WIDTH - GAP;
          const active = value >= band.from && value < band.to;
          const first = index === 0;
          const last = index === geometry.bands.length - 1;
          return (
            <rect
              key={band.id}
              x={x + (first ? 0 : GAP / 2)}
              y={BAR_TOP}
              width={Math.max(1, barWidth)}
              height={BAR_HEIGHT}
              rx={first || last ? BAR_RADIUS : 2}
              fill={band.color}
              opacity={active ? 1 : 0.4}
            />
          );
        })}

        {geometry.ticks.map((tick) => {
          const x = tick.fraction * VIEWBOX_WIDTH;
          return (
            <line
              key={`tick:${tick.label}`}
              x1={x}
              y1={BAR_TOP + BAR_HEIGHT + 2}
              x2={x}
              y2={BAR_TOP + BAR_HEIGHT + 8}
              stroke={colors.textDim}
              strokeWidth="2"
            />
          );
        })}

        <circle
          cx={Math.min(VIEWBOX_WIDTH - 6, Math.max(6, markerX))}
          cy={barMiddle}
          r="9"
          fill={markerColor}
          stroke={colors.bg}
          strokeWidth="3"
        />
      </svg>
      {geometry.leftLabel ? label(geometry.leftLabel, { top: 0, left: 0 }, colors.textDim) : null}
      {geometry.fairLabel ? label(geometry.fairLabel, { top: 0, left: "50%", transform: "translateX(-50%)" }, colors.textDim) : null}
      {geometry.rightLabel ? label(geometry.rightLabel, { top: 0, right: 0 }, colors.textDim) : null}
      {geometry.ticks.map((tick) => label(tick.label, { bottom: 0, ...tickLabelPosition(tick.fraction) }, colors.textDim, `tick:${tick.label}`))}
    </Box>
  );
}

function label(text: string, at: CSSProperties, color: string, key?: string) {
  return createElement("span", { key, style: { ...LABEL_STYLE, ...at, color } }, text);
}

/** A chart's labels: the app's type over the scale. */
const LABEL_STYLE = { position: "absolute", fontSize: "var(--gloom-type-ui)", lineHeight: "14px", whiteSpace: "nowrap", pointerEvents: "none" } as const;

/** Centred under its tick, but held inside the scale at its ends. */
function tickLabelPosition(fraction: number) {
  if (fraction * VIEWBOX_WIDTH < TICK_LABEL_INSET) return { left: 0 };
  if (fraction * VIEWBOX_WIDTH > VIEWBOX_WIDTH - TICK_LABEL_INSET) return { right: 0 };
  return { left: `${fraction * 100}%`, transform: "translateX(-50%)" };
}
