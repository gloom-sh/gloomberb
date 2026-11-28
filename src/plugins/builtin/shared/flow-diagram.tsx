import type { RefObject } from "react";
import { Box, Text, TextAttributes } from "../../../ui";
import { BADGE_TINT, ClippedText, NATIVE_BADGE_STYLE } from "../../../components/ui/display";
import { cardSurfaceStyle } from "../../../components/ui/card";
import { useThemeColors } from "../../../theme/theme-context";
import { blendHex } from "../../../theme/colors";
import { useShortcut } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";
import { ribbonY } from "../supply-chain/flow-layout";

export interface BrailleRibbonSpec {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  thickness: number | null;
  from: string;
  to: string;
  lit: boolean;
  dashed?: boolean;
}

export interface BrailleSpan {
  text: string;
  color: string;
}

const BRAILLE_BITS = [[1, 8], [2, 16], [4, 32], [64, 128]] as const;

/** Terminal-only Braille Bezier ribbon rasterizer shared by flow diagram panes. */
export function rasterizeBrailleRibbons(
  ribbons: readonly BrailleRibbonSpec[],
  width: number,
  height: number,
  colors: { bg: string; textDim: string },
  dashVisible?: (t: number) => boolean,
): BrailleSpan[][] {
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ mask: 0, color: colors.textDim })));
  for (const ribbon of ribbons) {
    for (let dx = Math.ceil(ribbon.x0 * 2); dx < Math.floor(ribbon.x1 * 2); dx++) {
      const x = (dx + 0.5) / 2;
      const t = (x - ribbon.x0) / Math.max(1e-6, ribbon.x1 - ribbon.x0);
      if (ribbon.dashed && dashVisible && !dashVisible(t)) continue;
      const y = ribbonY(ribbon, x);
      const half = ribbon.thickness === null ? 0 : ribbon.thickness / 2;
      const color = blendHex(ribbon.from, ribbon.to, t);
      const startDy = Math.round((y - half) * 4 - 0.5);
      const endDy = ribbon.thickness === null ? startDy : Math.round((y + half) * 4 - 0.5);
      for (let dy = startDy; dy <= endDy; dy++) {
        const cell = grid[Math.floor(dy / 4)]?.[Math.floor(dx / 2)];
        if (!cell || dy < 0) continue;
        cell.mask |= BRAILLE_BITS[dy % 4]![dx % 2]!;
        cell.color = ribbon.thickness === null && !ribbon.lit ? blendHex(colors.bg, color, 0.75) : color;
      }
    }
  }
  return grid.map((line) => {
    const spans: BrailleSpan[] = [];
    for (const cell of line) {
      const char = cell.mask ? String.fromCharCode(0x2800 + cell.mask) : " ";
      if (spans.at(-1)?.color === cell.color) spans.at(-1)!.text += char;
      else spans.push({ text: char, color: cell.color });
    }
    return spans;
  });
}

export function hitTestFlowRibbons(
  event: { preciseX?: number; preciseY?: number; x: number; y: number },
  surfaceRef: RefObject<{ x: number; y: number; absoluteX?: number; absoluteY?: number } | null>,
  ribbons: ReadonlyArray<{ id: string; x0: number; y0: number; x1: number; y1: number; thickness?: number | null }>,
  threshold: number,
): string | null | undefined {
  const origin = surfaceRef.current;
  if (!origin) return undefined;
  const x = (event.preciseX ?? event.x) - (origin.absoluteX ?? origin.x);
  const y = (event.preciseY ?? event.y) - (origin.absoluteY ?? origin.y);
  let best: { id: string; distance: number } | null = null;
  for (const ribbon of ribbons) {
    if (x < ribbon.x0 || x > ribbon.x1) continue;
    const distance = Math.abs(ribbonY(ribbon, x) - y) - (ribbon.thickness ?? 0) / 2;
    if (distance < threshold && (!best || distance < best.distance)) best = { id: ribbon.id, distance };
  }
  return best?.id ?? null;
}

export function useFlowListShortcut<T>({
  focused,
  items,
  selectedIndex,
  onSelect,
  onActivate,
}: {
  focused: boolean;
  items: readonly T[];
  selectedIndex: number;
  onSelect: (item: T) => void;
  onActivate: (item: T) => void;
}): void {
  useShortcut((event) => {
    if (!focused || event.defaultPrevented || items.length === 0) return;
    if (isPlainKey(event, "j", "down") || isPlainKey(event, "k", "up")) {
      const step = isPlainKey(event, "j", "down") ? 1 : -1;
      onSelect(items[(selectedIndex + step + items.length) % items.length]!);
    } else if (isPlainKey(event, "return", "enter")) {
      onActivate(items[selectedIndex]!);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  });
}

export function FlowFocusCard({
  label,
  name,
  x,
  y,
  width,
  height,
  desktop,
}: {
  label: string;
  name: string | null | undefined;
  x: number;
  y: number;
  width: number;
  height: number;
  desktop: boolean;
}) {
  const colors = useThemeColors();
  // The terminal's border takes two rows; the name shows only when the symbol keeps its own.
  const showName = !!name && name.toUpperCase() !== label.toUpperCase() && height >= (desktop ? 3 : 4);
  return (
    <Box
      position="absolute"
      left={x}
      top={y}
      width={width}
      height={height}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      border={!desktop}
      borderStyle="rounded"
      borderColor={colors.textMuted}
      style={desktop ? cardSurfaceStyle({ padding: "0" }) : undefined}
    >
      <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{label}</Text>
      {showName ? <ClippedText fg={colors.textDim} text={name} width={width - 4} /> : null}
    </Box>
  );
}

export function FlowPillChip({
  x,
  y,
  width,
  label,
  accent,
  more,
  desktop,
  active,
  role,
  ariaLabel,
  onPress,
  onHover,
}: {
  x: number;
  y: number;
  width: number;
  label: string;
  accent: string;
  more: boolean;
  desktop: boolean;
  active: boolean;
  role?: string;
  ariaLabel: string;
  onPress: () => void;
  onHover?: (on: boolean) => void;
}) {
  const colors = useThemeColors();
  const background = desktop
    ? active ? accent : more ? undefined : blendHex(colors.bg, accent, BADGE_TINT)
    : active ? blendHex(colors.bg, accent, 0.45) : more ? undefined : blendHex(colors.bg, accent, 0.14);
  const text = (
    <ClippedText
      fg={more ? colors.textDim : active ? desktop ? colors.bg : colors.textBright : accent}
      text={label}
      width={width - 2}
    />
  );
  return (
    <Box
      position="absolute"
      left={x}
      top={y}
      width={width}
      height={1}
      justifyContent={desktop ? "center" : undefined}
      onMouseDown={onPress}
      onMouseOver={onHover ? () => onHover(true) : undefined}
      onMouseOut={onHover ? () => onHover(false) : undefined}
      data-gloom-role={role}
      role="button"
      aria-label={ariaLabel}
    >
      {desktop
        ? <Box paddingX={1} minWidth={0} backgroundColor={background} justifyContent="center" style={{ ...NATIVE_BADGE_STYLE, cursor: more && !onHover ? undefined : "pointer" }}>{text}</Box>
        : <Box paddingX={1} height={1} backgroundColor={background}>{text}</Box>}
    </Box>
  );
}
