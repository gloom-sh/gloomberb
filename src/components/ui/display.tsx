import type { ReactNode } from "react";
import { t } from "../../i18n";
import { useThemeStyle, useThemeTokens } from "../../theme/theme-context";
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
  const tokens = useThemeTokens();
  // The style owns bold vs caps vs underline through the `heading` role, so
  // this only has to say what the text is.
  const label = t(title);
  return (
    <Box height={wrap ? undefined : 1} marginTop={marginTop} width={width} overflow="hidden" data-gloom-ui="section-heading">
      <Text fg={tokens.text.dim} typeRole="heading" wrapText={wrap}>
        {wrap || width === undefined ? label : truncateToDisplayWidth(label, width)}
      </Text>
    </Box>
  );
}

export interface SectionProps extends SectionHeadingProps {
  children: ReactNode;
}

export function Section({ title, children, width, marginTop, wrap }: SectionProps) {
  const { spacing } = useThemeTokens();
  // Density is the gap between sections: a whitespace style separates with air
  // where a ruled one can rely on the heading to do the work.
  const gap = marginTop ?? spacing.sectionGap;
  return (
    <Box flexDirection="column" width={width} marginTop={gap} data-gloom-ui="section">
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
  const tokens = useThemeTokens();
  const rowHeight = tokens.spacing.rowHeight;
  const rowWidth = width === undefined ? undefined : Math.max(0, Math.floor(width));
  const preferredLabelWidth = Math.max(0, labelWidth ?? (rowWidth === undefined ? 14 : Math.min(12, Math.max(8, Math.floor(rowWidth * 0.32)))));
  const labelColumns = rowWidth === undefined ? preferredLabelWidth : Math.min(preferredLabelWidth, Math.max(0, rowWidth - 1));
  const availableWidth = rowWidth === undefined ? undefined : rowWidth - labelColumns;
  const valueWidth = availableWidth === undefined ? undefined : detail
    ? Math.min(availableWidth, Math.max(8, Math.floor(rowWidth! * 0.42)))
    : availableWidth;
  const detailWidth = availableWidth === undefined ? undefined : availableWidth - valueWidth!;
  return (
    <Box height={rowHeight} width={rowWidth} flexDirection="row" overflow="hidden" data-gloom-ui="key-value-row">
      <Box width={labelColumns} flexShrink={0} overflow="hidden">
        <Text fg={tokens.text.dim} typeRole="label">{t(label)}</Text>
      </Box>
      <Box width={valueWidth} flexShrink={0} overflow="hidden">
        <Text fg={color ?? tokens.text.primary} typeRole={emphasis ? "value" : "numeric"}>
          {valueWidth === undefined ? value : truncateToDisplayWidth(value, valueWidth)}
        </Text>
      </Box>
      {detail && (detailWidth === undefined || detailWidth > 0) && (
        <Text fg={tokens.text.dim} typeRole="caption">
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
  const tokens = useThemeTokens();
  const fill = tokens.badge[variant === "solid" ? "solid" : "subtle"][tone];
  // A caller-supplied hue is a domain scale, not a tone, so it overrides the
  // token pair while keeping the variant's contrast relationship.
  const bg = color ? (variant === "solid" ? color : tokens.badge.subtle[tone].bg) : fill.bg;
  const fg = color ? (variant === "solid" ? tokens.surface.app : color) : fill.fg;
  return (
    <Box height={1} paddingX={1} backgroundColor={bg} data-gloom-ui="badge" data-tone={tone}>
      <Text fg={fg} typeRole="label" attributes={TextAttributes.BOLD}>{t(label)}</Text>
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
  const tokens = useThemeTokens();
  const vertical = orientation === "vertical";
  // A whitespace style keeps the cell so the layout does not shift, and simply
  // leaves it empty: the gap is the separator.
  const ruled = tokens.pane.chrome.separators === "lines";
  const color = ruled ? tokens.table.border : "transparent";
  return (
    <Box
      width={width ?? (vertical ? 1 : "100%")}
      height={height ?? (vertical ? "100%" : 1)}
      flexShrink={0}
      border={ruled ? (vertical ? ["left"] : ["top"]) : undefined}
      borderColor={color}
      style={{ border: 0, [vertical ? "borderLeft" : "borderTop"]: ruled ? `1px solid ${color}` : "none" }}
      role="separator"
      data-gloom-ui="divider"
      data-gloom-separators={tokens.pane.chrome.separators}
    />
  );
}
