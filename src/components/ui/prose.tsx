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
 * years. Ordinals and fiscal labels (Q2, FY26, 2Q) are left alone.
 */
const FIGURE_PATTERN =
  /[$€£¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:trillion|billion|million|thousand|bn|mn|k|m|b)\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent(?:age points?)?|bps|basis points|x\b|trillion|billion|million|thousand)|\b\d[\d,]*(?:\.\d+)?\b/gi;

const YEAR_PATTERN = /^(?:19|20)\d{2}$/;

export function splitFigures(text: string): ProseRun[] {
  const runs: ProseRun[] = [];
  let last = 0;
  for (const match of text.matchAll(FIGURE_PATTERN)) {
    const start = match.index ?? 0;
    const value = match[0];
    if (YEAR_PATTERN.test(value)) continue;
    if (start > last) runs.push({ text: text.slice(last, start), figure: false });
    runs.push({ text: value, figure: true });
    last = start + value.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), figure: false });
  return runs;
}

export interface ProseProps {
  text: string;
  width: number;
  color?: string;
  /** Put before the first line; later lines are indented by its width. */
  prefix?: string;
  prefixColor?: string;
}

const NATIVE_STRETCH_STYLE = { minWidth: 0 };
const NATIVE_TEXT_STYLE = { display: "block" };

/** Figures set in bold, the rest in the given colour. */
function styledRuns(text: string, color: string, figureColor: string, attributes = 0): StyledText {
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
  prefix = "",
  prefixColor,
}: ProseProps) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const foreground = color ?? colors.text;
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
          content={styledRuns(text, foreground, colors.textBright)}
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
        <Text content={styledRuns(line, foreground, colors.textBright)} />
      </Box>
    ),
  );
}
