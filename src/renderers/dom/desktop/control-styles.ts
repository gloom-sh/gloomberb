import type { ButtonProps } from "../../../components/ui/button";
import { blendHex, colors, type ThemeColors } from "../../../theme/colors";
import { RADIUS, controlBorderColour } from "../../../theme/ui-tokens";

/** Buttons, fields, selects and list cards (docs/pane-conventions.md, "Tokens"). */
export const CONTROL_RADIUS = RADIUS.md;

/** The border of a control and of a floating surface: `--gloom-control-border`. */
export function panelBorder(palette: ThemeColors = colors): string {
  return controlBorderColour(palette);
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

/** A control's border: the accent while it has focus or is chosen, the control border otherwise. */
export function controlBorderColor(focused = false, active = false, palette: ThemeColors = colors): string {
  if (active || focused) return palette.borderFocused;
  return controlBorderColour(palette);
}

/**
 * The four buttons. Primary (and danger, its negative twin) is filled and
 * bold; secondary is a 1px border; ghost (and plain) is text that takes the
 * hover fill; a chosen (`active`) button is the selection fill. None of them
 * casts a shadow. The icon button is `.gloom-icon-button` in styles.css.
 */
export function buttonPalette(
  props: Pick<ButtonProps, "variant" | "active" | "disabled">,
  palette: ThemeColors = colors,
) {
  if (props.variant === "plain" || props.variant === "ghost") {
    return {
      fg: props.disabled ? palette.textMuted : props.active ? palette.textBright : palette.textDim,
      bg: "transparent",
      border: "transparent",
    };
  }
  if (props.disabled) {
    return {
      fg: palette.textMuted,
      bg: "transparent",
      border: controlBorderColour(palette),
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
    case "secondary":
    default:
      return {
        fg: palette.text,
        bg: "transparent",
        border: controlBorderColour(palette),
      };
  }
}
