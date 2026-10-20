import type { CSSProperties } from "react";
import { Box, ImageSurface, Text, TextAttributes, useUiCapabilities } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";

/**
 * `row`: beside a label in one row (a table cell's `leading`, a list row).
 * `lead`: the art of a two-line list row, as tall as a cell and a half.
 */
type LogoMarkSize = "row" | "lead";

const TILE: Record<LogoMarkSize, { side: string; radius: string; type: string }> = {
  // A pixel above and below in its row, as a chip.
  row: { side: "calc(var(--cell-h) - 2px)", radius: "var(--gloom-radius-sm)", type: "var(--gloom-type-caption)" },
  lead: { side: "calc(var(--cell-h) * 1.5)", radius: "var(--gloom-radius-md)", type: "var(--gloom-type-ui)" },
};

// Sized by its capital and baseline, so flex centring puts the letter in the
// middle of the tile whatever the font's ascent and descent (as chrome text).
const LETTER_STYLE: Record<LogoMarkSize, CSSProperties> = {
  row: { fontSize: TILE.row.type, lineHeight: 1, textBox: "trim-both cap alphabetic" } as CSSProperties,
  lead: { fontSize: TILE.lead.type, lineHeight: 1, textBox: "trim-both cap alphabetic" } as CSSProperties,
};

export interface LogoMarkProps {
  /** The logo, an image URL; without one, or when it fails to load, the tile shows `name`'s initial. */
  src?: string | null;
  /** What the logo stands for, such as a broker. Only its initial is drawn; the label beside it names it. */
  name: string;
  size?: LogoMarkSize;
}

function initialOf(name: string): string {
  const letter = [...name.trim()].find((character) => /[\p{L}\p{N}]/u.test(character));
  return letter ? letter.toLocaleUpperCase() : "?";
}

/**
 * A logo in a square tile, for lists of brokers and the accounts they hold, on
 * the desktop and the web. Decoration: hidden from assistive technology, so
 * the label beside it stays the name. The terminal draws nothing.
 */
export function LogoMark({ src, name, size = "row" }: LogoMarkProps) {
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const colors = useThemeColors();
  if (!desktop) return null;
  const tile = TILE[size];
  return (
    <ImageSurface
      src={src ?? undefined}
      alt=""
      objectFit="cover"
      aria-hidden="true"
      data-gloom-role="logo-mark"
      style={{ width: tile.side, height: tile.side, flexShrink: 0, borderRadius: tile.radius }}
    >
      <Box width="100%" height="100%" alignItems="center" justifyContent="center" backgroundColor={colors.border}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD} style={LETTER_STYLE[size]}>
          {initialOf(name)}
        </Text>
      </Box>
    </ImageSurface>
  );
}
