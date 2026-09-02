import { blendHex, commandBarPanelBg, type ThemeColors } from "../../../theme/colors";

/**
 * Desktop metrics for the command surface, which is one control in two boxes:
 * the header input on top, the sheet hanging under it. They share a radius, a
 * shadow and a border so the pair reads as one rounded rectangle that grew
 * downward, rather than an input with a panel parked below it. The input keeps
 * the top corners, the sheet the bottom ones, and neither draws the edge they
 * meet on.
 */
export const NATIVE_COMMAND_SURFACE = {
  paddingXPx: 14,
  paddingYPx: 14,
  radiusPx: 8,
  shadow: "0 10px 18px color-mix(in srgb, var(--gloom-bg) 34%, transparent)",
} as const;

/**
 * Hairline around the surface. Lifted off the panel fill rather than the
 * header, which is the one thing the two halves do not have in common.
 */
export function nativeCommandSurfaceBorder(palette: ThemeColors): string {
  return blendHex(commandBarPanelBg(palette), palette.textBright, 0.16);
}
