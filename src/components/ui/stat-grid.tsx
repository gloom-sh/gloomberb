import { t } from "../../i18n";
import { useThemeColors } from "../../theme/theme-context";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../ui";
import { displayWidth, truncateToDisplayWidth } from "../../utils/format";

/**
 * One read-only figure in a StatGrid: a label, the value, and optional muted
 * context after it (a date, a percentile, a window).
 */
export interface StatItem {
  id?: string;
  label: string;
  value: string;
  detail?: string;
  tone?: "neutral" | "positive" | "negative" | "warning" | "accent" | "muted";
  /** A domain colour (a price change, a series). Wins over `tone`. */
  color?: string;
  /** Takes a whole row, e.g. a figure with a long window description. */
  wide?: boolean;
}

export interface StatGridProps {
  items: StatItem[];
  width: number;
  /** Fixed column count; by default as many as the widest item allows, up to 4, balanced over the rows. */
  columns?: number;
}

const MAX_COLUMNS = 4;
const MAX_LABEL_CHARS = 18;
/** Terminal gap between cells. */
const CELL_GAP = 2;

function labelChars(items: StatItem[]): number {
  return Math.min(MAX_LABEL_CHARS, Math.max(4, ...items.map((item) => displayWidth(t(item.label)))));
}

function naturalWidth(item: StatItem, labels: number): number {
  const detail = item.detail ? displayWidth(item.detail) + 2 : 0;
  return labels + 1 + displayWidth(item.value) + detail + CELL_GAP;
}

/** Columns a StatGrid uses at this width: as many as fit whole, spread evenly over the rows. */
export function statGridColumns(items: StatItem[], width: number): number {
  const cells = items.filter((item) => !item.wide);
  if (cells.length === 0) return 1;
  const labels = labelChars(items);
  const widest = Math.max(...cells.map((item) => naturalWidth(item, labels)));
  const fit = Math.max(1, Math.min(MAX_COLUMNS, cells.length, Math.floor((width - 2) / widest)));
  const rows = Math.ceil(cells.length / fit);
  return Math.ceil(cells.length / rows);
}

function layoutRows(items: StatItem[], columns: number): StatItem[][] {
  const rows: StatItem[][] = [];
  for (const item of items) {
    const last = rows[rows.length - 1];
    if (item.wide || !last || last.length >= columns || last[0]?.wide) rows.push([item]);
    else last.push(item);
  }
  return rows;
}

/** Rows a StatGrid takes, so panes can size what sits below it. */
export function statGridRows(items: StatItem[], width: number, columns?: number): number {
  return layoutRows(items, Math.max(1, columns ?? statGridColumns(items, width))).length;
}

/**
 * The figures that summarise a pane (a spread, a percentile, a range) as one
 * aligned sheet under the query bar: label, value and muted context per cell.
 * It is the read-only sibling of FieldGrid. The desktop draws the same band of
 * hairline-split cells, so the top of the pane reads as one piece of chrome;
 * the terminal draws aligned text columns.
 */
export function StatGrid({ items, width, columns: columnsProp }: StatGridProps) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  if (items.length === 0) return null;
  const columns = Math.max(1, columnsProp ?? statGridColumns(items, width));
  const rows = layoutRows(items, columns);
  const labels = labelChars(items);
  const innerWidth = Math.max(1, width - (nativePaneChrome ? 0 : 2));
  const cellWidth = Math.max(8, Math.floor((innerWidth - CELL_GAP * (columns - 1)) / columns));

  const toneColor = (item: StatItem): string => {
    if (item.color) return item.color;
    switch (item.tone) {
      case "positive": return colors.positive;
      case "negative": return colors.negative;
      case "warning": return colors.warning;
      case "accent": return colors.borderFocused;
      case "muted": return colors.textDim;
      default: return nativePaneChrome ? colors.textBright : colors.text;
    }
  };

  return (
    <Box
      flexDirection="column"
      paddingX={nativePaneChrome ? 0 : 1}
      height={rows.length}
      flexShrink={0}
      data-gloom-role="stat-grid"
      style={nativePaneChrome ? { "--stat-label-w": `${labels}ch`, "--stat-columns": String(columns) } : undefined}
    >
      {rows.map((row, rowIndex) => (
        <Box key={rowIndex} height={1} flexDirection="row" gap={nativePaneChrome ? 0 : CELL_GAP} data-gloom-role="stat-grid-row">
          {row.map((item, index) => {
            const label = t(item.label);
            const width = item.wide ? innerWidth : cellWidth;
            const labelWidth = Math.min(labels + 1, Math.max(4, Math.floor(width * 0.5)));
            const valueWidth = Math.max(1, width - labelWidth);
            const value = nativePaneChrome ? item.value : truncateToDisplayWidth(item.value, valueWidth);
            const detailWidth = valueWidth - displayWidth(value) - 2;
            const detail = !item.detail
              ? ""
              : nativePaneChrome ? item.detail : detailWidth > 1 ? truncateToDisplayWidth(item.detail, detailWidth) : "";
            return (
              <Box
                key={item.id ?? `${rowIndex}:${index}`}
                width={nativePaneChrome ? undefined : width}
                height={1}
                flexDirection="row"
                overflow="hidden"
                data-gloom-role="stat-grid-cell"
                data-wide={item.wide ? "true" : undefined}
                data-gloom-stat-id={item.id}
                // The last cell of a short row takes the columns left over, so the
                // band never ends in an empty cell.
                style={nativePaneChrome && !item.wide && index === row.length - 1 && row.length < columns
                  ? { gridColumn: `span ${columns - row.length + 1}` }
                  : undefined}
              >
                <Text fg={colors.textDim} data-gloom-role="stat-grid-label">
                  {nativePaneChrome ? label : truncateToDisplayWidth(label, labelWidth - 1).padEnd(labelWidth)}
                </Text>
                <Text fg={toneColor(item)} attributes={TextAttributes.BOLD} data-gloom-role="stat-grid-value">{value}</Text>
                {detail ? (
                  <Text fg={colors.textDim} data-gloom-role="stat-grid-detail">{nativePaneChrome ? detail : `  ${detail}`}</Text>
                ) : null}
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
