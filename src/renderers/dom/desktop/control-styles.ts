import type { ButtonProps } from "../../../components/ui/button";
import { blendHex, colors, type ThemeColors } from "../../../theme/colors";

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

function activeHalo(palette: ThemeColors): string {
  return `0 0 0 1px ${blendHex(palette.bg, palette.borderFocused, 0.18)}`;
}

export function controlShadow(active = false, palette: ThemeColors = colors): string {
  return active
    ? `${activeHalo(palette)}, inset 0 1px 0 ${blendHex(palette.bg, palette.textBright, 0.06)}`
    : `inset 0 1px 0 ${blendHex(palette.bg, palette.textBright, 0.04)}`;
}

const WHITE = "#ffffff";
const BLACK = "#000000";

function withAlpha(hex: string, alpha: number): string {
  return `${hex}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

/** How far a raised button's tones move from its fill, toward white at the top and black below. */
const SOLID_RELIEF = { light: 0.12, shade: 0.06, edge: 0.18, shadow: 0.3 };
const SURFACE_RELIEF = { light: 0.05, shade: 0.03, edge: 0.08, shadow: 0.14 };

interface ButtonRelief {
  backgroundImage?: string;
  boxShadow: string;
  /** Replaces the border colour, so a solid fill runs to its edge. */
  borderColor?: string;
  /** What the button shows while it is held down. */
  pressedImage?: string;
  pressedShadow?: string;
}

/**
 * Light from above, built from the button's own fill so it reads the same on
 * any surface and in every theme: a little lighter at the top, a little darker
 * toward the bottom, a darker band on the bottom edge and a soft shadow under
 * it. Nothing draws a line along the top edge. Held down, the light flips and
 * the shadow goes, so the button sinks.
 */
function raisedRelief(fill: string, tone: typeof SOLID_RELIEF, ring?: string): ButtonRelief {
  const shade = blendHex(fill, BLACK, tone.shade);
  const edge = blendHex(fill, BLACK, tone.edge);
  const drop = `0 1px 2px ${withAlpha(blendHex(fill, BLACK, 0.75), tone.shadow)}`;
  return {
    backgroundImage: `linear-gradient(${blendHex(fill, WHITE, tone.light)}, ${shade} calc(100% - 1px), ${edge} calc(100% - 1px))`,
    boxShadow: ring ? `${ring}, ${drop}` : drop,
    pressedImage: `linear-gradient(${shade}, ${fill})`,
    pressedShadow: ring ?? "none",
  };
}

/**
 * A button's relief. Primary, danger and a selected button are raised from
 * their fill; a secondary one gets the same light, fainter. Ghost and plain
 * buttons have no fill to light and stay flat, and so does a disabled one.
 */
export function buttonRelief(
  props: Pick<ButtonProps, "variant" | "active" | "disabled" | "tone">,
  palette: ThemeColors = colors,
): ButtonRelief {
  if (props.variant === "plain" || props.variant === "quiet" || props.variant === "ghost" || props.disabled) return { boxShadow: "none" };
  const fill = buttonPalette(props, palette).bg;
  if (props.active) return raisedRelief(fill, SOLID_RELIEF, `0 0 0 1px ${withAlpha(palette.borderFocused, 0.18)}`);
  if (props.variant === "primary" || props.variant === "danger") {
    return { ...raisedRelief(fill, SOLID_RELIEF), borderColor: "transparent" };
  }
  return raisedRelief(fill, SURFACE_RELIEF);
}

export function buttonPalette(
  props: Pick<ButtonProps, "variant" | "active" | "disabled" | "tone">,
  palette: ThemeColors = colors,
) {
  if (props.variant === "quiet") return {
    fg: props.disabled ? palette.textMuted : props.active ? palette.textBright : palette.textDim,
    bg: props.active ? selectedPanelFill(palette) : "transparent",
    border: "transparent",
  };
  if (props.variant === "plain") {
    return {
      fg: props.disabled ? palette.textMuted : props.active ? palette.textBright : palette.textDim,
      bg: "transparent",
      border: "transparent",
    };
  }
  if (props.disabled) {
    return {
      fg: palette.textMuted,
      bg: subtlePanelFill(palette),
      border: panelBorder(palette),
    };
  }
  if (props.tone && props.variant === "primary") return { fg: palette.bg, bg: palette[props.tone], border: props.active ? palette.textBright : palette[props.tone] };
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
