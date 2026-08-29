import { createElement, type SVGProps } from "react";
import { Box } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import {
  compactSegmentLabel,
  formatGaugeValue,
  valueToDegrees,
  type SpeedometerGaugeProps,
} from "./model";

const DESKTOP_VIEWBOX_WIDTH = 520;
const DESKTOP_VIEWBOX_HEIGHT = 232;
const DESKTOP_COMPACT_VIEWBOX_HEIGHT = 214;
const DESKTOP_CENTER_X = 260;
const DESKTOP_CENTER_Y = 182;
const DESKTOP_ARC_RADIUS = 138;
const DESKTOP_NEEDLE_RADIUS = 104;

function SvgText(props: SVGProps<SVGTextElement>) {
  return createElement("text", props);
}

function polarToCartesian(centerX: number, centerY: number, radius: number, angleDegrees: number) {
  const angleRadians = (angleDegrees - 90) * Math.PI / 180;
  return {
    x: centerX + radius * Math.cos(angleRadians),
    y: centerY + radius * Math.sin(angleRadians),
  };
}

function describeArc(centerX: number, centerY: number, radius: number, startAngle: number, endAngle: number): string {
  const start = polarToCartesian(centerX, centerY, radius, endAngle);
  const end = polarToCartesian(centerX, centerY, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

export function DesktopSpeedometerGauge({
  value,
  valueLabel,
  width,
  segments,
  min,
  max,
  currentLabel,
  minWidth,
  maxWidth,
  compact,
}: Required<SpeedometerGaugeProps>) {
  const colors = useThemeColors();
  const gaugeWidth = Math.min(Math.max(width - 2, minWidth), maxWidth);
  const gaugeHeight = compact ? 9 : 12;
  const viewBoxHeight = compact ? DESKTOP_COMPACT_VIEWBOX_HEIGHT : DESKTOP_VIEWBOX_HEIGHT;
  const needleAngle = valueToDegrees(value, min, max);
  const needleEnd = polarToCartesian(DESKTOP_CENTER_X, DESKTOP_CENTER_Y, DESKTOP_NEEDLE_RADIUS, needleAngle);

  return (
    <Box
      width={gaugeWidth}
      height={gaugeHeight}
      marginTop={compact ? 0 : 1}
      overflow="hidden"
      style={{ alignSelf: "center", maxWidth: 420 }}
    >
      <svg
        viewBox={`0 0 ${DESKTOP_VIEWBOX_WIDTH} ${viewBoxHeight}`}
        width="100%"
        height="100%"
        role="img"
        aria-label={`${currentLabel} ${formatGaugeValue(value)} ${valueLabel}`}
        style={{ display: "block" }}
      >
        {segments.map((segment) => (
          <path
            key={segment.label}
            d={describeArc(
              DESKTOP_CENTER_X,
              DESKTOP_CENTER_Y,
              DESKTOP_ARC_RADIUS,
              valueToDegrees(segment.from, min, max),
              valueToDegrees(segment.to, min, max),
            )}
            fill="none"
            stroke={segment.color}
            strokeWidth="22"
            strokeLinecap="butt"
            opacity={value >= segment.from && value <= segment.to ? 0.96 : 0.42}
          />
        ))}
        {segments.map((segment) => {
          const midpoint = (valueToDegrees(segment.from, min, max) + valueToDegrees(segment.to, min, max)) / 2;
          const point = polarToCartesian(DESKTOP_CENTER_X, DESKTOP_CENTER_Y, DESKTOP_ARC_RADIUS + 36, midpoint);
          return (
            <SvgText
              key={`label:${segment.label}`}
              x={point.x}
              y={point.y}
              fill={segment.color}
              textAnchor="middle"
              dominantBaseline="middle"
              fontFamily="inherit"
              fontSize="14"
              fontWeight="700"
            >
              {compactSegmentLabel(segment)}
            </SvgText>
          );
        })}
        {[min, min + (max - min) * 0.25, min + (max - min) * 0.5, min + (max - min) * 0.75, max].map((tick) => {
          const angle = valueToDegrees(tick, min, max);
          const outer = polarToCartesian(DESKTOP_CENTER_X, DESKTOP_CENTER_Y, DESKTOP_ARC_RADIUS + 16, angle);
          const inner = polarToCartesian(DESKTOP_CENTER_X, DESKTOP_CENTER_Y, DESKTOP_ARC_RADIUS - 10, angle);
          return (
            <line key={tick} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} stroke={colors.textDim} strokeWidth="2" />
          );
        })}
        <line
          x1={DESKTOP_CENTER_X}
          y1={DESKTOP_CENTER_Y}
          x2={needleEnd.x}
          y2={needleEnd.y}
          stroke={colors.textBright}
          strokeWidth="7"
          strokeLinecap="round"
        />
        <circle cx={DESKTOP_CENTER_X} cy={DESKTOP_CENTER_Y} r="27" fill={colors.bg} />
        <SvgText
          x={DESKTOP_CENTER_X}
          y={DESKTOP_CENTER_Y + 2}
          fill={colors.textBright}
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="inherit"
          fontSize="31"
          fontWeight="800"
        >
          {formatGaugeValue(value)}
        </SvgText>
      </svg>
    </Box>
  );
}
