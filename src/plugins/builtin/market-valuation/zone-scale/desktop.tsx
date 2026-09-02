import { createElement, type SVGProps } from "react";
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

function SvgText(props: SVGProps<SVGTextElement>) {
  return createElement("text", props);
}

export function DesktopZoneColorScale({ indicator, value, width, markerColor }: ZoneScaleProps) {
  const colors = useThemeColors();
  const geometry = zoneScaleGeometry(indicator, value, Math.max(48, width));
  const markerX = geometry.markerFraction * VIEWBOX_WIDTH;
  const barMiddle = BAR_TOP + BAR_HEIGHT / 2;

  return (
    <Box width={width} height={3} overflow="hidden">
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
            <g key={`tick:${tick.label}`}>
              <line
                x1={x}
                y1={BAR_TOP + BAR_HEIGHT + 2}
                x2={x}
                y2={BAR_TOP + BAR_HEIGHT + 8}
                stroke={colors.textDim}
                strokeWidth="2"
              />
              <SvgText
                // Half a label's width of inset, so the end ticks are not clipped.
                x={Math.min(VIEWBOX_WIDTH - TICK_LABEL_INSET, Math.max(TICK_LABEL_INSET, x))}
                y={VIEWBOX_HEIGHT - 4}
                fill={colors.textDim}
                textAnchor="middle"
                fontFamily="inherit"
                fontSize="15"
              >
                {tick.label}
              </SvgText>
            </g>
          );
        })}

        {geometry.underLabel ? (
          <SvgText x={0} y={16} fill={colors.textDim} textAnchor="start" fontFamily="inherit" fontSize="15">
            {geometry.underLabel}
          </SvgText>
        ) : null}
        {geometry.fairLabel ? (
          <SvgText
            x={VIEWBOX_WIDTH / 2}
            y={16}
            fill={colors.textDim}
            textAnchor="middle"
            fontFamily="inherit"
            fontSize="15"
          >
            {geometry.fairLabel}
          </SvgText>
        ) : null}
        {geometry.overLabel ? (
          <SvgText
            x={VIEWBOX_WIDTH}
            y={16}
            fill={colors.textDim}
            textAnchor="end"
            fontFamily="inherit"
            fontSize="15"
          >
            {geometry.overLabel}
          </SvgText>
        ) : null}

        <circle
          cx={Math.min(VIEWBOX_WIDTH - 6, Math.max(6, markerX))}
          cy={barMiddle}
          r="9"
          fill={markerColor}
          stroke={colors.bg}
          strokeWidth="3"
        />
      </svg>
    </Box>
  );
}
