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
}

const NATIVE_STRETCH_STYLE = { minWidth: 0 };
const NATIVE_TEXT_STYLE = { display: "block" };

/** Figures set in bold, the rest in the given colour. */
function styledRuns(
  text: string,
  color: string,
  figureColor: string | null,
  attributes = 0,
): StyledText {
  if (!figureColor) return new StyledText([{ text, fg: color, attributes }]);
  return new StyledText(
    splitFigures(text).map((run) => ({
      text: run.text,
      fg: run.figure ? figureColor : color,
      attributes: run.figure ? attributes | TextAttributes.BOLD : attributes,
    })),
  );
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
}: ProseProps) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const foreground = color ?? colors.text;
  const figureColor = figures ? colors.textBright : null;
  const prefixForeground = prefixColor ?? colors.textDim;
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
          content={styledRuns(text, foreground, figureColor, attributes)}
        />
      </Box>
    );
  }
  const indent = " ".repeat(prefix.length);
  return wrapTextLines(text, Math.max(8, width - prefix.length)).map(
    (line, index) => (
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
        <Text content={styledRuns(line, foreground, figureColor, attributes)} />
      </Box>
    ),
  );
}
