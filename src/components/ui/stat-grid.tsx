import { t } from "../../i18n";
import type { ThemeColors } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../ui";
import { clipToDisplayWidth, displayWidth, padTo, truncateToDisplayWidth } from "../../utils/format";
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
   * The most lines the grid takes. A whole-row cell too narrow for its value
   * and detail wraps onto a second line, the detail under the value; with
   * `maxLines` only the leading such cells the lines leave room for do, and
   * the rest keep one line, cut (`statGridRows` counts the same).
   */
  maxLines?: number;
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

const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
/** A date, time or day count in a cell: `2026-10-29`, `18:00`, `Dec 9`, `30 Sep`, `Dec '26`, `2026`, `in 40 days`, `3d ago`. */
const DATED = new RegExp([
  "\\d{4}-\\d{2}",
  "\\b\\d{1,2}:\\d{2}\\b",
  `\\b${MONTH} (?:'\\d{2}|\\d{1,4})\\b`,
  `\\b\\d{1,2} ${MONTH}(?![a-z])`,
  "\\b(?:19|20)\\d{2}\\b",
  "\\bin \\d+ ?(?:d|days?|wks?|weeks?|mo|months?)\\b",
  "\\b\\d+ ?(?:d|h|m|min|days?|hours?) ago\\b",
].join("|"));

/** `text` cut to `room` after its last whole word that fits, behind a `…`; mid-word only when its first word does not fit. */
function clipWords(text: string, room: number): string {
  if (displayWidth(text) <= room) return text;
  const words = text.split(" ");
  for (let count = words.length - 1; count > 0; count--) {
    const kept = `${words.slice(0, count).join(" ")}…`;
    if (displayWidth(kept) <= room) return kept;
  }
  return clipToDisplayWidth(text, room);
}

/**
 * `text` cut to `width` without cutting a date: its ` · ` parts that have none
 * give way first, from the last, cut short at a word and then to a `…` that
 * says something is left out; then the words before a part's date
 * (`1,561,837 shares… 16:02:15.123`). Only dates too wide for the width are
 * cut at their end.
 */
function cutKeepingDates(text: string, width: number): string {
  const parts = text.split(" · ");
  const joined = () => parts.join(" · ");
  const roomFor = (index: number) => width - (displayWidth(joined()) - displayWidth(parts[index]!));
  for (let index = parts.length - 1; index >= 0 && displayWidth(joined()) > width; index--) {
    const part = parts[index]!;
    if (DATED.test(part)) continue;
    const room = roomFor(index);
    if (room >= 4) parts[index] = clipWords(part, room);
    else if (parts[index + 1] !== "…" && part !== "…") parts[index] = "…";
    else parts.splice(index, 1);
  }
  for (let index = parts.length - 1; index >= 0 && displayWidth(joined()) > width; index--) {
    const part = parts[index]!;
    const at = part.search(DATED);
    if (at <= 0) continue;
    const date = part.slice(at);
    const room = roomFor(index) - displayWidth(date) - 1;
    parts[index] = room >= 4 ? `${clipWords(part.slice(0, at).trimEnd(), room)} ${date}` : date;
  }
  return truncateToDisplayWidth(joined(), width);
}

/**
 * `text` on at most two lines no wider than `width`: broken after the ` · `
 * parts that fit the first, else at its last space that does; the second line
 * is cut where it has no date (cutKeepingDates).
 */
function twoLines(text: string, width: number): string[] {
  const parts = text.split(" · ");
  let first = "";
  let taken = 0;
  for (; taken < parts.length; taken++) {
    const next = first ? `${first} · ${parts[taken]}` : parts[taken]!;
    if (displayWidth(next) > width) break;
    first = next;
  }
  let rest = parts.slice(taken).join(" · ");
  if (!first) {
    // The first part alone is wider than a line: it breaks at a space, or is cut.
    const words = parts[0]!.split(" ");
    let count = 0;
    while (count < words.length && displayWidth(words.slice(0, count + 1).join(" ")) <= width) count++;
    first = count ? words.slice(0, count).join(" ") : truncateToDisplayWidth(words[0]!, width);
    rest = [words.slice(Math.max(1, count)).join(" "), ...parts.slice(1)].filter(Boolean).join(" · ");
  }
  return rest ? [first, cutKeepingDates(rest, width)] : [first];
}

/** A whole-row cell on its two lines (wrapStatCell). */
interface WrappedStatCell {
  /** The value: one line, or both when it is wider than its column and the detail gives way. */
  value: string[];
  /** Cells of the split bar after the value on the first line; 0 for none. */
  bar: number;
  /** The detail on the second line, or null. */
  detail: string | null;
}

/** Lines a wrapped cell takes: its value, then its detail. */
const WRAPPED_CELL_LINES = 2;

/**
 * A whole-row cell (a `wide` item, or any cell of a one-column grid) that does
 * not fit one line, on two: the value and its split bar on the first, and the
 * detail on the second, in the longest form that fits, else cut where it has
 * no date. A value wider than its column takes both lines, its bar after the
 * first where it has room, when the detail can go (there is none, the pane
 * offers an empty form, or it has no date); with a dated detail the value is
 * cut instead, as a date is never what gives way.
 * Null when the cell fits one line as it is, with the detail form that fits
 * beside the value (an empty form counts: the pane chose to show none). Worked
 * out in terminal cells for both renderers, so the grid's rows are the same
 * count on each.
 */
function wrapStatCell(item: StatItem, width: number, labelWidth: number): WrappedStatCell | null {
  const valueWidth = Math.max(1, width - labelWidth);
  const valueCells = displayWidth(item.value);
  const forms = item.detail ? [item.detail, ...(item.detailVariants ?? [])] : [];
  const shown = forms.filter(Boolean);
  const detailLine = () => shown.find((form) => displayWidth(form) <= valueWidth) ?? cutKeepingDates(shown.at(-1)!, valueWidth);
  if (valueCells <= valueWidth) {
    const bar = item.split ? splitBarCells(valueWidth - valueCells - 1) : 0;
    const detailRoom = valueWidth - valueCells - (bar ? bar + 1 : 0) - 2;
    const shortest = sizingDetail(item);
    if (!shortest || (detailRoom > 1 && displayWidth(shortest) <= detailRoom)) return null;
    return { value: [item.value], bar, detail: detailLine() };
  }
  const detailCanGo = shown.length === 0 || shown.length < forms.length || !shown.some((form) => DATED.test(form));
  if (detailCanGo) {
    const value = twoLines(item.value, valueWidth);
    return { value, bar: item.split ? splitBarCells(valueWidth - displayWidth(value[0]!) - 1) : 0, detail: null };
  }
  return { value: [cutKeepingDates(item.value, valueWidth)], bar: 0, detail: detailLine() };
}

/** A laid-out row's one cell, wrapped, when it spans the row and does not fit one line (wrapStatCell). */
function wrappedRow(row: StatItem[], columns: number, geometry: ReturnType<typeof gridGeometry>): WrappedStatCell | null {
  const item = row[0];
  if (!item || row.length > 1 || (!item.wide && columns > 1)) return null;
  const width = item.wide ? geometry.innerWidth : geometry.cellWidth;
  return wrapStatCell(item, width, cellLabelWidth(width, geometry.labels, geometry.widestValue));
}

/**
 * The grid's rows and which of them wrap: every whole-row cell too narrow for
 * one line, in order, while the grid stays within `maxLines`; past that a cell
 * keeps its one line, cut. Decided in terminal cells on both renderers, so a
 * pane sizes the same rows on each.
 */
function planStatGrid(items: StatItem[], width: number, columns: number, maxLines = Number.POSITIVE_INFINITY) {
  const rows = layoutRows(items, columns);
  const geometry = gridGeometry(items, width, columns, false);
  let spare = maxLines - rows.length;
  const wrapped = rows.map((row) => {
    if (spare < WRAPPED_CELL_LINES - 1) return null;
    const cell = wrappedRow(row, columns, geometry);
    if (cell) spare -= WRAPPED_CELL_LINES - 1;
    return cell;
  });
  const lines = rows.length + wrapped.filter(Boolean).length * (WRAPPED_CELL_LINES - 1);
  return { rows, wrapped, lines };
}

/**
 * Rows a StatGrid takes, so panes can size what sits below it: a whole-row
 * cell that wraps counts both its lines. With `maxLines`, the grid drawn with
 * the same `maxLines`.
 */
export function statGridRows(items: StatItem[], width: number, columns?: number, { maxLines }: { maxLines?: number } = {}): number {
  return planStatGrid(items, width, Math.max(1, columns ?? statGridColumns(items, width)), maxLines).lines;
}

/**
 * The leading items that fit a band of `maxLines`, in whole rows: as many rows
 * as there are lines, and the rows they leave for a whole-row cell to wrap
 * into (`maxLines` on the grid, which `lines` counts).
 */
export function statGridWithin(items: StatItem[], width: number, maxLines: number, columns?: number): { items: StatItem[]; lines: number } {
  if (maxLines < 1 || items.length === 0) return { items: [], lines: 0 };
  const resolved = Math.max(1, columns ?? statGridColumns(items, width));
  const shown = layoutRows(items, resolved).slice(0, maxLines).flat();
  return { items: shown, lines: statGridRows(shown, width, resolved, { maxLines }) };
}

/** A label in its column, cut and padded by terminal cells, so a wide character keeps the values aligned. */
function labelText(label: string, labelWidth: number): string {
  return padTo(truncateToDisplayWidth(label, labelWidth - 1), labelWidth);
}

/**
 * The figures that summarise a pane (a spread, a percentile, a range) as one
 * aligned sheet under the query bar: label, value and muted context per cell.
 * It is the read-only sibling of FieldGrid. The desktop draws the same band of
 * hairline-split cells, so the top of the pane reads as one piece of chrome;
 * the terminal draws aligned text columns.
 */
export function StatGrid({ items, width, columns: columnsProp, maxLines }: StatGridProps) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  if (items.length === 0) return null;
  const columns = Math.max(1, columnsProp ?? statGridColumns(items, width));
  const { rows, wrapped: wrapping, lines: lineCount } = planStatGrid(items, width, columns, maxLines);
  const { labels, innerWidth, cellWidth, widestValue } = gridGeometry(items, width, columns, !!nativePaneChrome);

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
          const [firstValue, ...moreValue] = wrapped.value;
          return (
            <Box key={rowIndex} height={WRAPPED_CELL_LINES} flexDirection="row" data-gloom-role="stat-grid-row">
              <Box
                key={item.id ?? `${rowIndex}:0`}
                width={nativePaneChrome ? undefined : width}
                height={WRAPPED_CELL_LINES}
                flexDirection="row"
                overflow="hidden"
                data-gloom-role="stat-grid-cell"
                data-wide={item.wide ? "true" : undefined}
                data-wrapped="true"
                data-gloom-stat-id={item.id}
              >
                <Text fg={colors.textDim} data-gloom-role="stat-grid-label">
                  {nativePaneChrome ? label : labelText(label, labelWidth)}
                </Text>
                <Box flexDirection="column" flexGrow={1} minWidth={0}>
                  <Box height={1} flexDirection="row">
                    <Text fg={toneColor(item)} attributes={TextAttributes.BOLD} data-gloom-role="stat-grid-value">{firstValue}</Text>
                    {item.split && wrapped.bar ? (
                      <Box marginLeft={nativePaneChrome ? 0 : 1} flexShrink={nativePaneChrome ? 1 : 0} style={nativePaneChrome ? { minWidth: 0 } : undefined}>
                        <SplitBar parts={item.split} width={nativePaneChrome ? SPLIT_BAR_CELLS : wrapped.bar} />
                      </Box>
                    ) : null}
                  </Box>
                  {moreValue.map((line, index) => (
                    <Text key={`value:${index}`} fg={toneColor(item)} attributes={TextAttributes.BOLD} data-gloom-role="stat-grid-value">{line}</Text>
                  ))}
                  {wrapped.detail != null ? (
                    <Text fg={colors.textDim} data-gloom-role="stat-grid-detail">{wrapped.detail}</Text>
                  ) : null}
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
                  {nativePaneChrome ? label : labelText(label, labelWidth)}
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
