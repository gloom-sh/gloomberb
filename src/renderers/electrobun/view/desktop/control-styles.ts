import type { ButtonProps } from "../../../../components/ui/button";
import { blendHex, colors, type ThemeColors } from "../../../../theme/colors";

export const CONTROL_RADIUS = 6;

export function panelBorder(palette: ThemeColors = colors): string {
  return blendHex(palette.border, palette.borderFocused, 0.18);
}

export function panelFill(palette: ThemeColors = colors): string {
  return blendHex(palette.panel, palette.bg, 0.22);
}

export function subtlePanelFill(palette: ThemeColors = colors): string {
  return blendHex(palette.panel, palette.bg, 0.42);
}

export function selectedPanelFill(palette: ThemeColors = colors): string {
  return blendHex(palette.selected, palette.bg, 0.42);
}

export function controlBorderColor(focused = false, active = false, palette: ThemeColors = colors): string {
  if (active) return palette.borderFocused;
  if (focused) return blendHex(palette.borderFocused, palette.textBright, 0.24);
  return panelBorder(palette);
}

export function controlShadow(active = false, palette: ThemeColors = colors): string {
  return active
    ? `0 0 0 1px ${blendHex(palette.bg, palette.borderFocused, 0.18)}, inset 0 1px 0 ${blendHex(palette.bg, palette.textBright, 0.06)}`
    : `inset 0 1px 0 ${blendHex(palette.bg, palette.textBright, 0.04)}`;
}

export function buttonPalette(
  props: Pick<ButtonProps, "variant" | "active" | "disabled">,
  palette: ThemeColors = colors,
) {
  if (props.disabled) {
    return {
      fg: palette.textMuted,
      bg: subtlePanelFill(palette),
      border: panelBorder(palette),
    };
  }
  if (props.active) {
    return {
      fg: palette.selectedText,
      bg: palette.selected,
      border: palette.borderFocused,
    };
  }

  switch (props.variant) {
    case "primary":
      return {
        fg: palette.bg,
        bg: palette.borderFocused,
        border: palette.borderFocused,
      };
    case "danger":
      return {
        fg: palette.bg,
        bg: palette.negative,
        border: palette.negative,
      };
    case "ghost":
      return {
        fg: palette.textDim,
        bg: "transparent",
        border: panelBorder(palette),
      };
    case "secondary":
    default:
      return {
        fg: palette.text,
        bg: panelFill(palette),
        border: panelBorder(palette),
      };
  }
}
