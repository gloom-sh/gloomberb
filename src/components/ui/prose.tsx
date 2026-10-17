import { useThemeColors } from "../../theme/theme-context";
import { Box, StyledText, Text, TextAttributes, useUiCapabilities } from "../../ui";
import { wrapTextLines } from "../../utils/text-wrap";

export interface ProseRun {
  text: string;
  /** A number the eye should land on: money, percentages, quantities. */
  figure: boolean;
}

/**
 * Money, percentages and quantities with a unit, plus bare numbers except
 * years, each with its sign. Ordinals and fiscal labels (Q2, FY26, 2Q) are
 * left alone.
 */
const FIGURE_PATTERN =
  /[+\-\u2212]?(?:[$€£¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:trillion|billion|million|thousand|bn|mn|k|m|b)\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent(?:age points?)?|bps|basis points|x\b|trillion|billion|million|thousand)|\b\d[\d,]*(?:\.\d+)?\b)/gi;

const YEAR_PATTERN = /^(?:19|20)\d{2}$/;

/** "Sep 01", "Feb 24, 2026", "Sep 01, 26": the day and year are not figures. */
const MONTH_DATE_PATTERN =
  /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b(?:,\s*\d{2}(?:\d{2})?\b)?/g;

const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);
const isJoiner = (char: string | undefined) => char === "-" || char === "/";

/**
 * Digits joined to a word by a hyphen or slash are part of a code or a date
 * (2025-10-31, 10-K, 8-K/A, 0000320193-24-000123), not a figure. So is a
 * zero-padded number, an id rather than a quantity.
 */
function isCodeDigits(text: string, start: number, end: number, digits: string): boolean {
  return /^0\d/.test(digits)
    || (isJoiner(text[start - 1]) && isWordChar(text[start - 2]))
    || (/\d$/.test(digits) && isJoiner(text[end]) && isWordChar(text[end + 1]));
}

export function splitFigures(text: string): ProseRun[] {
  const runs: ProseRun[] = [];
  const dates = [...text.matchAll(MONTH_DATE_PATTERN)]
    .map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length] as const);
  let last = 0;
  for (const match of text.matchAll(FIGURE_PATTERN)) {
    const start = match.index ?? 0;
    const value = match[0];
    const end = start + value.length;
    const signed = /^[+\-\u2212]/.test(value);
    const unsigned = signed ? value.slice(1) : value;
    // A sign glued to the word before it is a hyphen or a range: 10-15, A-1.
    if (signed && (isWordChar(text[start - 1]) || isJoiner(text[start - 1]))) continue;
    if (YEAR_PATTERN.test(unsigned)) continue;
    if (dates.some(([dateStart, dateEnd]) => start < dateEnd && end > dateStart)) continue;
    // A currency amount keeps its own prefix (US$5); only plain digits can be codes.
    if (/^\d/.test(unsigned) && isCodeDigits(text, start, end, unsigned)) continue;
    if (start > last) runs.push({ text: text.slice(last, start), figure: false });
    runs.push({ text: value, figure: true });
    last = end;
  }
  if (last < text.length) runs.push({ text: text.slice(last), figure: false });
  return runs;
}

export interface ProseProps {
  text: string;
  width: number;
  color?: string;
  /**
   * Numbers set in bold and brightened. Turn it off for text that carries its
   * own meaning in its colour, such as an error, where a brightened figure
   * would read as a separate thing.
   */
  figures?: boolean;
  /** Applied to the whole paragraph, e.g. bold for a question. */
  attributes?: number;
  /** Put before the first line; later lines are indented by its width. */
  prefix?: string;
  prefixColor?: string;
  /** What a find in the text matched, set apart where it occurs. */
  marks?: ProseMarks;
}

interface ProseMarks {
  /** Matched without regard to case. */
  query: string;
  /** The occurrence the find is on, counted from 0 in this paragraph: drawn solid, the rest in colour alone. */
  active?: number | null;
}

interface MarkRange {
  start: number;
  end: number;
  active: boolean;
}

const NATIVE_STRETCH_STYLE = { minWidth: 0 };
const NATIVE_TEXT_STYLE = { display: "block" };

/** A find marks from this many characters: one letter would mark thousands of spans. */
const MIN_MARK_LENGTH = 2;

/** Where `marks.query` occurs in `text`, in order and without overlap. */
function proseMarkRanges(text: string, marks: ProseMarks | undefined): MarkRange[] {
  const needle = marks?.query.trim().toLowerCase() ?? "";
  if (needle.length < MIN_MARK_LENGTH) return [];
  const haystack = text.toLowerCase();
  const ranges: MarkRange[] = [];
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
    ranges.push({ start: at, end: at + needle.length, active: ranges.length === marks?.active });
  }
  return ranges;
}

/** The ranges that fall in `[start, start + length)`, against that slice. */
function rangesIn(ranges: readonly MarkRange[], start: number, length: number): MarkRange[] {
  return ranges
    .filter((range) => range.end > start && range.start < start + length)
    .map((range) => ({ start: Math.max(0, range.start - start), end: Math.min(length, range.end - start), active: range.active }));
}

/** Figures set in bold, the rest in the given colour, and a find's matches set apart. */
function styledRuns(
  text: string,
  color: string,
  figureColor: string | null,
  attributes = 0,
  marked: readonly MarkRange[] = [],
  palette?: { mark: string; activeFg: string },
): StyledText {
  const runs = figureColor ? splitFigures(text) : [{ text, figure: false }];
  const chunks: Array<{ text: string; fg: string; bg?: string; attributes: number }> = [];
  let offset = 0;
  for (const run of runs) {
    const runStart = offset;
    offset += run.text.length;
    const base = {
      fg: run.figure && figureColor ? figureColor : color,
      attributes: run.figure && figureColor ? attributes | TextAttributes.BOLD : attributes,
    };
    const inRun = palette ? rangesIn(marked, runStart, run.text.length) : [];
    if (inRun.length === 0) {
      chunks.push({ text: run.text, ...base });
      continue;
    }
    let at = 0;
    for (const range of inRun) {
      if (range.start > at) chunks.push({ text: run.text.slice(at, range.start), ...base });
      chunks.push({
        text: run.text.slice(range.start, range.end),
        fg: range.active ? palette!.activeFg : palette!.mark,
        ...(range.active ? { bg: palette!.mark } : {}),
        attributes: base.attributes,
      });
      at = range.end;
    }
    if (at < run.text.length) chunks.push({ text: run.text.slice(at), ...base });
  }
  return new StyledText(chunks);
}

/**
 * A paragraph with figures in bold. The terminal renderer does not wrap on
 * its own, so lines are pre-wrapped and styled one at a time; desktop
 * chrome wraps the styled paragraph itself. `indent` is applied to every
 * line after the first, for bullets.
 */
export function Prose({
  text,
  width,
  color,
  figures = true,
  attributes = 0,
  prefix = "",
  prefixColor,
  marks,
}: ProseProps) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const foreground = color ?? colors.text;
  const figureColor = figures ? colors.textBright : null;
  const prefixForeground = prefixColor ?? colors.textDim;
  const marked = proseMarkRanges(text, marks);
  // A match is marked in the warning colour, as search matches are elsewhere;
  // the one a find is on is set solid in it.
  const palette = marked.length > 0 ? { mark: colors.warning, activeFg: colors.bg } : undefined;
  if (!text.trim()) return null;
  if (nativePaneChrome) {
    return (
      <Box flexDirection="row" width="100%" style={NATIVE_STRETCH_STYLE} data-gloom-ui="prose">
        {prefix ? (
          <Text fg={prefixForeground} attributes={TextAttributes.BOLD}>
            {prefix}
          </Text>
        ) : null}
        <Text
          wrapText
          width="100%"
          style={NATIVE_TEXT_STYLE}
          content={styledRuns(text, foreground, figureColor, attributes, marked, palette)}
        />
      </Box>
    );
  }
  const indent = " ".repeat(prefix.length);
  const lines = wrapTextLines(text, Math.max(8, width - prefix.length));
  const row = (line: string, index: number, ranges: readonly MarkRange[]) => (
    <Box key={index} height={1} flexDirection="row" data-gloom-ui="prose">
      {prefix ? (
        <Text
          fg={prefixForeground}
          attributes={TextAttributes.BOLD}
          flexShrink={0}
        >
          {index === 0 ? prefix : indent}
        </Text>
      ) : null}
      <Text content={styledRuns(line, foreground, figureColor, attributes, ranges, palette)} />
    </Box>
  );
  if (marked.length === 0) return lines.map((line, index) => row(line, index, marked));
  // Where each wrapped line sits in the text, so a match is marked on its line.
  let cursor = 0;
  return lines.map((line, index) => {
    const start = Math.max(cursor, text.indexOf(line, cursor));
    cursor = start + line.length;
    return row(line, index, rangesIn(marked, start, line.length));
  });
}

/**
 * The widest a paragraph runs. On a wide pane a full-width line is over two
 * hundred characters, which the eye loses on the way back.
 */
export const READING_WIDTH = 100;

export interface BulletListProps {
  items: string[];
  width: number;
  color?: string;
}

/** One bulleted paragraph per item, later lines indented under the text. */
export function BulletList({ items, width, color }: BulletListProps) {
  return items.map((item, index) => (
    <Prose key={`${index}-${item}`} text={item} width={width} color={color} prefix="• " />
  ));
}

export interface FigureListItem {
  value: string;
  label: string;
  note?: string;
}

export interface FigureListProps {
  figures: FigureListItem[];
  width: number;
  /** The value column is as wide as the longest value, within these bounds. */
  minValueWidth?: number;
  maxValueWidth?: number;
}

/** Figures one per line, value first, so the column of numbers is what the eye reads. */
export function FigureList({ figures, width, minValueWidth = 0, maxValueWidth = 18 }: FigureListProps) {
  const colors = useThemeColors();
  const valueWidth = Math.min(
    maxValueWidth,
    Math.max(minValueWidth, ...figures.map((figure) => figure.value.length)),
  );
  return figures.map((figure) => (
    <Prose
      key={`${figure.label}-${figure.value}`}
      text={[figure.label, figure.note].filter(Boolean).join(", ")}
      width={width}
      color={colors.textDim}
      prefix={`${figure.value.padEnd(valueWidth)}  `}
      prefixColor={colors.textBright}
    />
  ));
}
