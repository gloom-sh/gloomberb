import { colors } from "./colors";
import { blendHex, contrastRatio } from "./color-utils";

const HEATMAP_BASE_BLEND = 0.35;
const HEATMAP_TEXT_MIN_CONTRAST = 4.5;
const HEATMAP_MUTED_MIN_CONTRAST = 3.6;
const HEATMAP_TINT_STEPS = [0.56, 0.5, 0.44, 0.38, 0.32, 0.28, 0.24, 0.2, 0.16, 0.12] as const;

export interface HeatCellColors {
  background: string;
  foreground: string;
}

function highestContrast(candidates: readonly string[], background: string): string {
  return candidates.reduce((best, candidate) => (
    contrastRatio(candidate, background) > contrastRatio(best, background) ? candidate : best
  ));
}

function textCandidates(): string[] {
  return [
    colors.text,
    colors.textDim,
    colors.textBright,
    colors.textMuted,
    colors.selectedText,
    colors.headerText,
    colors.bg,
    colors.panel,
    colors.header,
    colors.commandBg,
  ];
}

function heatmapBaseBackground(): string {
  return blendHex(colors.panel, colors.bg, HEATMAP_BASE_BLEND);
}

// Diverging: red below zero, green above, and no tint at zero. A yellow
// midpoint made every moderate positive the same olive, so 0.45 and 0.64
// could not be told apart.
function heatmapSemanticColor(value: number): string {
  return value < 0 ? colors.negative : colors.positive;
}

/** How far a cell leans toward its hue: none at zero, strongest at +/-1. */
function heatmapTargetStrength(value: number): number {
  return 0.06 + Math.abs(value) * 0.56;
}

function heatmapTintSteps(targetStrength: number): number[] {
  const steps = HEATMAP_TINT_STEPS.filter((step) => step <= targetStrength);
  return steps[0] === targetStrength ? steps : [targetStrength, ...steps];
}

function readableForeground(background: string): string {
  return highestContrast(textCandidates(), background);
}

/**
 * A diverging heat cell for a value scaled to -1..1 (a correlation as is, a
 * return divided by the move that should read as full strength).
 */
export function resolveHeatCellColors(
  value: number | null,
  options: { quiet?: boolean } = {},
): HeatCellColors {
  const baseBackground = heatmapBaseBackground();

  // A quiet cell says nothing (a series against itself), so the eye goes elsewhere.
  if (value === null || options.quiet) {
    const muted = colors.textMuted;
    return {
      background: baseBackground,
      foreground: contrastRatio(muted, baseBackground) >= HEATMAP_MUTED_MIN_CONTRAST
        ? muted
        : readableForeground(baseBackground),
    };
  }

  const clamped = Math.max(-1, Math.min(1, value));
  const semanticColor = heatmapSemanticColor(clamped);
  const targetStrength = heatmapTargetStrength(clamped);
  let fallback: HeatCellColors | null = null;

  for (const tintStrength of heatmapTintSteps(targetStrength)) {
    const background = blendHex(baseBackground, semanticColor, tintStrength);
    const foreground = readableForeground(background);
    const cellColors = { background, foreground };
    fallback = cellColors;
    if (contrastRatio(foreground, background) >= HEATMAP_TEXT_MIN_CONTRAST) {
      return cellColors;
    }
  }

  return fallback ?? {
    background: baseBackground,
    foreground: readableForeground(baseBackground),
  };
}
