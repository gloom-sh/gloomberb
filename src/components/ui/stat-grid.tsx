import { t } from "../../i18n";
import type { ThemeColors } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../ui";
import { displayWidth, truncateToDisplayWidth } from "../../utils/format";
import { SplitBar, type SplitBarPart } from "./split-bar";

export type StatTone = "neutral" | "positive" | "negative" | "warning" | "accent" | "muted";

/** A figure's tone as a theme colour; undefined for `neutral`, which keeps the component's own text colour. */
export function statToneColor(tone: StatTone | undefined, colors: ThemeColors): string | undefined {
  switch (tone) {
    case "positive": return colors.positive;
    case "negative": return colors.negative;
    case "warning": return colors.warning;
    case "accent": return colors.borderFocused;
    case "muted": return colors.textDim;
    default: return undefined;
  }
}

/**
 * One read-only figure in a StatGrid: a label, the value, and optional muted
 * context after it (a date, a percentile, a window).
 */
export interface StatItem {
  id?: string;
  label: string;
  value: string;
  detail?: string;
  /**
   * Shorter forms of `detail`, longest first (an empty one shows none). The
   * grid sizes its columns by the shortest, so a detail that grows with the
   * data (a stamp outside regular hours) never takes a column from the band,
   * and shows the longest form that fits the cell.
   */
  detailVariants?: readonly string[];
  tone?: StatTone;
  /** A domain colour (a price change, a series). Wins over `tone`. */
  color?: string;
  /** Takes a whole row, e.g. a figure with a long window description. */
  wide?: boolean;
  /** A whole and its parts (a Buy/Hold/Sell mix), drawn as a bar after the value when the cell has room. */
  split?: readonly SplitBarPart[];
}

export interface StatGridProps {
  items: StatItem[];
  width: number;
  /** Fixed column count; by default as many as the widest item allows, up to 4, balanced over the rows. */
  columns?: number;
  /**
   * A whole-row cell too narrow for its value and detail wraps them under the
   * value (the default). Off, it keeps one line and cuts them, for a band with
   * a single row to spare (`statGridRows` with `wrap: false` counts it).
   */
  wrap?: boolean;
}

const MAX_COLUMNS = 4;
const MAX_LABEL_CHARS = 18;
/** Terminal gap between cells. */
const CELL_GAP = 2;
/** Cells a split bar takes after its value. */
const SPLIT_BAR_CELLS = 12;

function labelChars(items: StatItem[]): number {
  return Math.min(MAX_LABEL_CHARS, Math.max(4, ...items.map((item) => displayWidth(t(item.label)))));
}

/** The form of the detail the columns are sized by: the shortest. */
function sizingDetail(item: StatItem): string | undefined {
  return item.detailVariants?.length ? item.detailVariants[item.detailVariants.length - 1] : item.detail;
}

/** The longest form of a cell's detail that fits `room` cells, else its shortest. */
function fittingStatDetail(item: Pick<StatItem, "detail" | "detailVariants">, room: number): string | undefined {
  if (!item.detail || !item.detailVariants?.length) return item.detail;
  const forms = [item.detail, ...item.detailVariants];
  return forms.find((form) => displayWidth(form) <= room) ?? forms[forms.length - 1];
}

function naturalWidth(item: StatItem, labels: number): number {
  // A split bar takes the room the cell has left and is not counted here.
  const sized = sizingDetail(item);
  const detail = sized ? displayWidth(sized) + 2 : 0;
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

/** What a grid's cells share: the label column, the inner width and one cell's width, in terminal cells. */
function gridGeometry(items: StatItem[], width: number, columns: number, nativePaneChrome: boolean) {
  const labels = labelChars(items);
  const innerWidth = Math.max(1, width - (nativePaneChrome ? 0 : 2));
  const cellWidth = Math.max(8, Math.floor((innerWidth - CELL_GAP * (columns - 1)) / columns));
  const widestValue = Math.max(0, ...items.filter((item) => !item.wide).map((item) => displayWidth(item.value)));
  return { labels, innerWidth, cellWidth, widestValue };
}

/**
 * The label's column in a cell `width` wide: it grows into what the grid's
 * widest value leaves, and never gets less than half the cell, so one long
 * value cannot cut every label in a grid with a fixed column count.
 */
function cellLabelWidth(width: number, labels: number, widestValue: number): number {
  return Math.min(labels + 1, Math.max(4, Math.floor(width * 0.5), width - widestValue - 1));
}

/** Cells a split bar takes after a value that leaves `room` in its column; none when too few to read. */
function splitBarCells(room: number): number {
  return room >= 4 ? Math.min(SPLIT_BAR_CELLS, room) : 0;
}

/**
 * `text` in lines no wider than `width`: its ` · ` parts kept whole where they
 * fit, together on a line while they fit, else broken at spaces; a word wider
 * than the line alone is cut.
 */
function wrapStatText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  const place = (piece: string, joint: string) => {
    const joined = line ? `${line}${joint}${piece}` : piece;
    if (displayWidth(joined) <= width) { line = joined; return; }
    if (line) lines.push(line);
    line = piece;
  };
  for (const part of text.split(" · ")) {
    if (displayWidth(part) <= width) { place(part, " · "); continue; }
    // A part too wide for a line of its own starts one and breaks at its spaces.
    if (line) lines.push(line);
    line = "";
    for (const word of part.split(" ")) place(truncateToDisplayWidth(word, width), " ");
  }
  if (line) lines.push(line);
  return lines;
}

/** A cell that spans its row and wraps rather than cut its value or its detail. */
interface WrappedStatCell {
  value: string[];
  /** The detail's own lines under the value. */
  detail: string[];
}

/**
 * A whole-row cell (a `wide` item, or any cell of a one-column grid) whose
 * value or detail would be cut on one line: the value on its line, broken
 * where it is wider than its column, and the detail under it, in the longest
 * form that fits a line or else wrapped, so a date in it is never what gives
 * way. Null when the cell fits one line as it is, with the detail form that
 * fits beside the value (an empty form counts: the pane chose to show none).
 * Worked out in terminal cells for both renderers, so the grid's rows are the
 * same count on each.
 */
function wrapStatCell(item: StatItem, width: number, labelWidth: number): WrappedStatCell | null {
  const valueWidth = Math.max(1, width - labelWidth);
  const valueFits = displayWidth(item.value) <= valueWidth;
  if (valueFits) {
    const barCells = item.split ? splitBarCells(valueWidth - displayWidth(item.value) - 1) : 0;
    const detailRoom = valueWidth - displayWidth(item.value) - (barCells ? barCells + 1 : 0) - 2;
    const shortest = sizingDetail(item);
    if (!shortest || (detailRoom > 1 && displayWidth(shortest) <= detailRoom)) return null;
  }
  const value = valueFits ? [item.value] : wrapStatText(item.value, valueWidth);
  const forms = item.detail ? [item.detail, ...(item.detailVariants ?? [])].filter(Boolean) : [];
  const whole = forms.find((form) => displayWidth(form) <= valueWidth);
  const detail = whole ? [whole] : forms.length ? wrapStatText(forms[forms.length - 1]!, valueWidth) : [];
  return { value, detail };
}

/** A laid-out row's one cell, wrapped, when it spans the row and does not fit one line (wrapStatCell). */
function wrappedRow(row: StatItem[], columns: number, geometry: ReturnType<typeof gridGeometry>): WrappedStatCell | null {
  const item = row[0];
  if (!item || row.length > 1 || (!item.wide && columns > 1)) return null;
  const width = item.wide ? geometry.innerWidth : geometry.cellWidth;
  return wrapStatCell(item, width, cellLabelWidth(width, geometry.labels, geometry.widestValue));
}

function wrappedLines(wrapped: WrappedStatCell | null): number {
  return wrapped ? wrapped.value.length + wrapped.detail.length : 1;
}

/**
 * Rows a StatGrid takes, so panes can size what sits below it: a whole-row
 * cell that wraps counts each of its lines. `wrap: false` counts the grid
 * drawn with `wrap={false}`, a line a row.
 */
export function statGridRows(items: StatItem[], width: number, columns?: number, { wrap = true }: { wrap?: boolean } = {}): number {
  const resolved = Math.max(1, columns ?? statGridColumns(items, width));
  if (!wrap) return layoutRows(items, resolved).length;
  // Terminal cells on both renderers, so a pane sizes the same rows on each.
  const geometry = gridGeometry(items, width, resolved, false);
  return layoutRows(items, resolved).reduce((total, row) => total + wrappedLines(wrappedRow(row, resolved, geometry)), 0);
}

/**
 * The figures that summarise a pane (a spread, a percentile, a range) as one
 * aligned sheet under the query bar: label, value and muted context per cell.
 * It is the read-only sibling of FieldGrid. The desktop draws the same band of
 * hairline-split cells, so the top of the pane reads as one piece of chrome;
 * the terminal draws aligned text columns.
 */
export function StatGrid({ items, width, columns: columnsProp, wrap = true }: StatGridProps) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  if (items.length === 0) return null;
  const columns = Math.max(1, columnsProp ?? statGridColumns(items, width));
  const rows = layoutRows(items, columns);
  const { labels, innerWidth, cellWidth, widestValue } = gridGeometry(items, width, columns, !!nativePaneChrome);
  // Whether a whole-row cell wraps is decided in terminal cells on both renderers (statGridRows).
  const terminal = gridGeometry(items, width, columns, false);
  const wrapping = rows.map((row) => wrap ? wrappedRow(row, columns, terminal) : null);
  const lineCount = wrapping.reduce((total, wrapped) => total + wrappedLines(wrapped), 0);

  const toneColor = (item: StatItem): string =>
    item.color || (statToneColor(item.tone, colors) ?? (nativePaneChrome ? colors.textBright : colors.text));

  return (
    <Box
      flexDirection="column"
      paddingX={nativePaneChrome ? 0 : 1}
      height={lineCount}
      flexShrink={0}
      data-gloom-role="stat-grid"
      style={nativePaneChrome ? { "--stat-label-w": `${labels}ch`, "--stat-columns": String(columns) } : undefined}
    >
      {rows.map((row, rowIndex) => {
        const wrapped = wrapping[rowIndex];
        if (wrapped) {
          const item = row[0]!;
          const label = t(item.label);
          const width = item.wide ? innerWidth : cellWidth;
          const labelWidth = cellLabelWidth(width, labels, widestValue);
          const lines = wrappedLines(wrapped);
          return (
            <Box key={rowIndex} height={lines} flexDirection="row" data-gloom-role="stat-grid-row">
              <Box
                key={item.id ?? `${rowIndex}:0`}
                width={nativePaneChrome ? undefined : width}
                height={lines}
                flexDirection="row"
                overflow="hidden"
                data-gloom-role="stat-grid-cell"
                data-wide={item.wide ? "true" : undefined}
                data-wrapped="true"
                data-gloom-stat-id={item.id}
              >
                <Text fg={colors.textDim} data-gloom-role="stat-grid-label">
                  {nativePaneChrome ? label : truncateToDisplayWidth(label, labelWidth - 1).padEnd(labelWidth)}
                </Text>
                <Box flexDirection="column" flexGrow={1} minWidth={0}>
                  {wrapped.value.map((line, index) => (
                    <Text key={`value:${index}`} fg={toneColor(item)} attributes={TextAttributes.BOLD} data-gloom-role="stat-grid-value">{line}</Text>
                  ))}
                  {wrapped.detail.map((line, index) => (
                    <Text key={`detail:${index}`} fg={colors.textDim} data-gloom-role="stat-grid-detail">{line}</Text>
                  ))}
                </Box>
              </Box>
            </Box>
          );
        }
        return (
        <Box key={rowIndex} height={1} flexDirection="row" gap={nativePaneChrome ? 0 : CELL_GAP} data-gloom-role="stat-grid-row">
          {row.map((item, index) => {
            const label = t(item.label);
            const width = item.wide ? innerWidth : cellWidth;
            const labelWidth = cellLabelWidth(width, labels, widestValue);
            const valueWidth = Math.max(1, width - labelWidth);
            const value = nativePaneChrome ? item.value : truncateToDisplayWidth(item.value, valueWidth);
            // The bar shows only whole enough to read; the value never gives way to it.
            const barRoom = valueWidth - displayWidth(value) - 1;
            const barCells = !item.split ? 0 : nativePaneChrome ? SPLIT_BAR_CELLS : splitBarCells(barRoom);
            const detailWidth = valueWidth - displayWidth(value) - (barCells ? barCells + 1 : 0) - 2;
            // The desktop cell has no gap between cells: its label column, inset and gaps take the room
            // (measured short, as a cell is wider than a character, so a form that fits is never clipped).
            const shownDetail = fittingStatDetail(item, nativePaneChrome
              ? width + (item.wide ? 0 : CELL_GAP) - labels - displayWidth(value) - (barCells ? barCells + 1 : 0) - 4
              : detailWidth);
            const detail = !shownDetail
              ? ""
              : nativePaneChrome ? shownDetail : detailWidth > 1 ? truncateToDisplayWidth(shownDetail, detailWidth) : "";
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
                {item.split && barCells ? (
                  <Box marginLeft={nativePaneChrome ? 0 : 1} flexShrink={nativePaneChrome ? 1 : 0} style={nativePaneChrome ? { minWidth: 0 } : undefined}>
                    <SplitBar parts={item.split} width={barCells} />
                  </Box>
                ) : null}
                {detail ? (
                  <Text fg={colors.textDim} data-gloom-role="stat-grid-detail">{nativePaneChrome ? detail : `  ${detail}`}</Text>
                ) : null}
              </Box>
            );
          })}
        </Box>
        );
      })}
    </Box>
  );
}
