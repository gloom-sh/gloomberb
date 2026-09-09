import type { ReactNode } from "react";
import { t } from "../../i18n";
import { blendHex } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { Box, Text, TextAttributes } from "../../ui";
import { truncateToDisplayWidth } from "../../utils/format";

export { Prose } from "./prose";
export type { ProseProps } from "./prose";

export interface SectionHeadingProps {
  title: string;
  marginTop?: number;
  width?: number;
  wrap?: boolean;
}

export function SectionHeading({ title, marginTop = 0, width, wrap = false }: SectionHeadingProps) {
  const colors = useThemeColors();
  return (
    <Box height={wrap ? undefined : 1} marginTop={marginTop} width={width} overflow="hidden" data-gloom-ui="section-heading">
      <Text fg={colors.textDim} attributes={TextAttributes.BOLD} wrapText={wrap}>
        {wrap || width === undefined ? t(title) : truncateToDisplayWidth(t(title), width)}
      </Text>
    </Box>
  );
}

export interface SectionProps extends SectionHeadingProps {
  children: ReactNode;
}

export function Section({ title, children, width, marginTop = 1, wrap }: SectionProps) {
  return (
    <Box flexDirection="column" width={width} marginTop={marginTop} data-gloom-ui="section">
      <SectionHeading title={title} width={width} wrap={wrap} />
      {children}
    </Box>
  );
}

export interface KeyValueRowProps {
  label: string;
  value: string;
  detail?: string;
  color?: string;
  width?: number;
  labelWidth?: number;
  emphasis?: boolean;
}

/** Aligned labels and values; a bounded row reserves room for an optional detail. */
export function KeyValueRow({ label, value, detail, color, width, labelWidth, emphasis = true }: KeyValueRowProps) {
  const colors = useThemeColors();
  const rowWidth = width === undefined ? undefined : Math.max(0, Math.floor(width));
  const preferredLabelWidth = Math.max(0, labelWidth ?? (rowWidth === undefined ? 14 : Math.min(12, Math.max(8, Math.floor(rowWidth * 0.32)))));
  const labelColumns = rowWidth === undefined ? preferredLabelWidth : Math.min(preferredLabelWidth, Math.max(0, rowWidth - 1));
  const availableWidth = rowWidth === undefined ? undefined : rowWidth - labelColumns;
  const valueWidth = availableWidth === undefined ? undefined : detail
    ? Math.min(availableWidth, Math.max(8, Math.floor(rowWidth! * 0.42)))
    : availableWidth;
  const detailWidth = availableWidth === undefined ? undefined : availableWidth - valueWidth!;
  return (
    <Box height={1} width={rowWidth} flexDirection="row" overflow="hidden" data-gloom-ui="key-value-row">
      <Box width={labelColumns} flexShrink={0} overflow="hidden">
        <Text fg={colors.textDim}>{t(label)}</Text>
      </Box>
      <Box width={valueWidth} flexShrink={0} overflow="hidden">
        <Text fg={color ?? colors.text} attributes={emphasis ? TextAttributes.BOLD : undefined}>
          {valueWidth === undefined ? value : truncateToDisplayWidth(value, valueWidth)}
        </Text>
      </Box>
      {detail && (detailWidth === undefined || detailWidth > 0) && (
        <Text fg={colors.textDim}>
          {detailWidth === undefined ? `  ${detail}` : truncateToDisplayWidth(detail, detailWidth)}
        </Text>
      )}
    </Box>
  );
}

export interface BadgeProps {
  label: string;
  tone?: "neutral" | "accent" | "positive" | "negative" | "warning";
  /** For a domain scale, such as a sentiment score or chart series. */
  color?: string;
  variant?: "subtle" | "solid";
}

export function Badge({ label, tone = "neutral", color, variant = "subtle" }: BadgeProps) {
  const colors = useThemeColors();
  const accent = color ?? (tone === "neutral" ? colors.textDim : tone === "accent" ? colors.borderFocused : colors[tone]);
  const solid = variant === "solid";
  const neutral = solid && tone === "neutral" && !color;
  return (
    <Box height={1} paddingX={1} backgroundColor={neutral ? colors.selected : solid ? accent : blendHex(colors.bg, accent, 0.28)} data-gloom-ui="badge">
      <Text fg={neutral ? colors.selectedText : solid ? colors.bg : accent} attributes={TextAttributes.BOLD}>{t(label)}</Text>
    </Box>
  );
}

export interface DividerProps {
  width?: number | `${number}%`;
  height?: number | `${number}%`;
  orientation?: "horizontal" | "vertical";
}

/** Host borders draw terminal rules and real CSS borders without text glyphs in the DOM. */
export function Divider({ width, height, orientation = "horizontal" }: DividerProps) {
  const colors = useThemeColors();
  const vertical = orientation === "vertical";
  return (
    <Box
      width={width ?? (vertical ? 1 : "100%")}
      height={height ?? (vertical ? "100%" : 1)}
      flexShrink={0}
      border={vertical ? ["left"] : ["top"]}
      borderColor={colors.border}
      style={{ border: 0, [vertical ? "borderLeft" : "borderTop"]: `1px solid ${colors.border}` }}
      role="separator"
      data-gloom-ui="divider"
    />
  );
}
