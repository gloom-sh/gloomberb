import { useCallback, type ReactNode } from "react";
import { priceColor } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { Text, TextAttributes, useUiCapabilities } from "../../ui";
import { displayWidth } from "../../utils/format";

/** `value` is a pane's lead figure (a last price); `sub` is the change or detail that rides with it. */
export type FigurePart = "value" | "sub";

const FIGURE_FONT_PX: Record<FigurePart, number> = { value: 22, sub: 13 };
const FIGURE_LINE_HEIGHT: Record<FigurePart, number> = { value: 1.05, sub: 1.1 };

// The desktop sets figures larger and heavier than body text; the terminal has one size, so the value is bold.
const DESKTOP_FIGURE_STYLE: Record<FigurePart, { fontSize: string; lineHeight: number; fontWeight: number }> = {
  value: { fontSize: `${FIGURE_FONT_PX.value}px`, lineHeight: FIGURE_LINE_HEIGHT.value, fontWeight: 700 },
  sub: { fontSize: `${FIGURE_FONT_PX.sub}px`, lineHeight: FIGURE_LINE_HEIGHT.sub, fontWeight: 500 },
};

function figureLinePx(part: FigurePart): number {
  return FIGURE_FONT_PX[part] * FIGURE_LINE_HEIGHT[part];
}

/**
 * Vertical metrics the desktop's monospace faces (SF Mono, Menlo, JetBrains Mono) share
 * closely enough, as fractions of the size: ascent less descent, and cap height.
 */
const MONO_ASCENT_LESS_DESCENT = 0.72;
const MONO_CAP_HEIGHT = 0.73;
/** Desktop body text is set two thirds of a cell tall (12px in an 18px row). */
const BODY_FONT_PER_CELL = 2 / 3;

/** Where the ink of a desktop text line sits, in px from the top of its line box. */
interface LineInk {
  /** Top of the capitals. */
  capTop: number;
  baseline: number;
}

function lineInk(fontPx: number, linePx: number): LineInk {
  const baseline = (linePx + fontPx * MONO_ASCENT_LESS_DESCENT) / 2;
  return { capTop: baseline - fontPx * MONO_CAP_HEIGHT, baseline };
}

/** Ink of a desktop figure line, for whatever is aligned to it (a logo beside a price). */
export function figureLineInk(part: FigurePart = "value"): LineInk {
  return lineInk(FIGURE_FONT_PX[part], figureLinePx(part));
}

/** Ink of a desktop body text row `cellHeightPx` tall. */
export function bodyLineInk(cellHeightPx: number): LineInk {
  return lineInk(cellHeightPx * BODY_FONT_PER_CELL, cellHeightPx);
}

/** Advance of the desktop's monospace face, as a fraction of its size. */
const MONO_ADVANCE = 0.6;

export interface FigureTextProps {
  part?: FigurePart;
  /** Colours the figure by the sign of this change. */
  change?: number | null;
  /** A colour of its own; wins over `change`. */
  fg?: string;
  /** Dims the figure instead of weighting it, as a quote flash does. */
  dim?: boolean;
  /** Extra desktop style, such as a halo over a sparkline. */
  style?: Record<string, string | number | undefined>;
  children: ReactNode;
}

export function FigureText({ part = "value", change, fg, dim = false, style, children }: FigureTextProps) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const color = fg ?? (change != null ? priceColor(change, colors) : part === "value" ? colors.textBright : colors.text);
  const attributes = dim ? TextAttributes.DIM : part === "value" ? TextAttributes.BOLD : TextAttributes.NONE;
  return (
    <Text
      fg={color}
      attributes={attributes}
      style={nativePaneChrome ? { ...DESKTOP_FIGURE_STYLE[part], ...style } : undefined}
    >
      {children}
    </Text>
  );
}

/** Cells a figure covers, for layouts that budget in cells: the desktop draws figures larger than a cell. */
export function useFigureCells(): (text: string, part?: FigurePart) => number {
  const { nativePaneChrome, cellWidthPx = 8 } = useUiCapabilities();
  return useCallback((text: string, part: FigurePart = "value") => (
    nativePaneChrome
      ? Math.ceil(displayWidth(text) * FIGURE_FONT_PX[part] * MONO_ADVANCE / cellWidthPx)
      : displayWidth(text)
  ), [cellWidthPx, nativePaneChrome]);
}
