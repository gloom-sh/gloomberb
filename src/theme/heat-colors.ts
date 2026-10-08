import { colors } from "./colors";
import { blendHex, contrastRatio, relativeLuminance } from "./color-utils";

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

/**
 * Heat map tiles: one fixed diverging hue scale for every theme, so a move
 * reads the same in Amber as in GitHub Light. Losses run to hot pink, a flat
 * session sits on muted indigo and gains run to teal; pink against teal also
 * separates for red-green colour blindness, where red against green does not.
 * The ends keep white text at 4.5:1. A light theme lifts the flat end to a
 * pale lavender so the page is not a dark block; the ends stay the same.
 */
const HEATMAP_TILE_FULL_SCALE_PERCENT = 3;
/** How fast colour builds from flat: below 1 a small move already leans to its hue. */
const HEATMAP_TILE_EASING = 0.7;
const HEATMAP_TILE_TEXT_MIN_CONTRAST = 4.5;
const HEATMAP_LOSS = { l: 0.588, c: 0.215, h: 356 } as const;
const HEATMAP_GAIN = { l: 0.545, c: 0.104, h: 186 } as const;
const HEATMAP_FLAT_DARK = { l: 0.43, c: 0.1, h: 290 } as const;
const HEATMAP_FLAT_LIGHT = { l: 0.9, c: 0.035, h: 290 } as const;
const HEATMAP_MISSING_DARK = "#3a3a40";
const HEATMAP_MISSING_LIGHT = "#cfcfd6";
const HEATMAP_TEXT_LIGHT = "#ffffff";
const HEATMAP_TEXT_DARK = "#0b0b12";
const HEATMAP_STEPS = 64;

export interface HeatmapTileColors {
  background: string;
  foreground: string;
}

type Oklab = readonly [number, number, number];

function srgbToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  const value = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, value)) * 255);
}

/** OKLab, so equal steps of the scale look like equal steps of colour. */
export function hexToOklab(hex: string): Oklab {
  const h = hex.replace("#", "");
  const r = srgbToLinear(parseInt(h.slice(0, 2), 16));
  const g = srgbToLinear(parseInt(h.slice(2, 4), 16));
  const b = srgbToLinear(parseInt(h.slice(4, 6), 16));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToHex([lightness, a, b]: Oklab): string {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const blue = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return `#${[r, g, blue].map((channel) => linearToSrgb(channel).toString(16).padStart(2, "0")).join("")}`;
}

function lch({ l, c, h }: Lch): Oklab {
  const radians = h * Math.PI / 180;
  return [l, c * Math.cos(radians), c * Math.sin(radians)];
}

type Lch = { readonly l: number; readonly c: number; readonly h: number };

/** Around the hue wheel the short way, so the scale passes through magenta and blue instead of grey. */
function mixLch(from: Lch, to: Lch, ratio: number): Lch {
  const turn = ((to.h - from.h + 540) % 360) - 180;
  return {
    l: from.l + (to.l - from.l) * ratio,
    c: from.c + (to.c - from.c) * ratio,
    h: from.h + turn * ratio,
  };
}

function heatmapTextColor(background: string): string {
  if (contrastRatio(HEATMAP_TEXT_LIGHT, background) >= HEATMAP_TILE_TEXT_MIN_CONTRAST) return HEATMAP_TEXT_LIGHT;
  return highestContrast([HEATMAP_TEXT_LIGHT, HEATMAP_TEXT_DARK], background);
}

const heatmapScaleCache = new Map<string, HeatmapTileColors[]>();

/** 2 * HEATMAP_STEPS + 1 colours from full loss to full gain, built once per light or dark page. */
function heatmapScale(light: boolean): HeatmapTileColors[] {
  const key = light ? "light" : "dark";
  const cached = heatmapScaleCache.get(key);
  if (cached) return cached;
  const flat = light ? HEATMAP_FLAT_LIGHT : HEATMAP_FLAT_DARK;
  const scale: HeatmapTileColors[] = [];
  for (let step = -HEATMAP_STEPS; step <= HEATMAP_STEPS; step += 1) {
    const strength = (Math.abs(step) / HEATMAP_STEPS) ** HEATMAP_TILE_EASING;
    const background = oklabToHex(lch(mixLch(flat, step < 0 ? HEATMAP_LOSS : HEATMAP_GAIN, strength)));
    scale.push({ background, foreground: heatmapTextColor(background) });
  }
  heatmapScaleCache.set(key, scale);
  return scale;
}

function isLightPage(): boolean {
  return relativeLuminance(colors.bg) > 0.4;
}

/**
 * The tile colours for a day's move in percent. Full strength at +/-3%; a
 * missing move is neutral grey, never the flat colour, so it cannot pass for
 * an unchanged price.
 */
export function resolveHeatmapTileColors(changePercent: number | null | undefined): HeatmapTileColors {
  const light = isLightPage();
  if (changePercent == null || !Number.isFinite(changePercent)) {
    const background = light ? HEATMAP_MISSING_LIGHT : HEATMAP_MISSING_DARK;
    return { background, foreground: heatmapTextColor(background) };
  }
  const ratio = Math.max(-1, Math.min(1, changePercent / HEATMAP_TILE_FULL_SCALE_PERCENT));
  return heatmapScale(light)[Math.round(ratio * HEATMAP_STEPS) + HEATMAP_STEPS]!;
}

const HEATMAP_SELECTED_LIFT = 0.45;

/**
 * The selected tile on a cell grid, which cannot draw an outline: the same
 * hue lifted toward white, so the selection still says which way it moved.
 */
export function resolveHeatmapSelectedTileColors(changePercent: number | null | undefined): HeatmapTileColors {
  const background = blendHex(resolveHeatmapTileColors(changePercent).background, "#ffffff", HEATMAP_SELECTED_LIFT);
  return { background, foreground: heatmapTextColor(background) };
}

const oklabCache = new Map<string, Oklab>();

/** Perceptual distance between two tile colours; about 0.02 is the smallest step the eye notices. */
export function heatmapColorDistance(left: string, right: string): number {
  if (left === right) return 0;
  const read = (hex: string) => {
    let value = oklabCache.get(hex);
    if (!value) {
      value = hexToOklab(hex);
      if (oklabCache.size > 2048) oklabCache.clear();
      oklabCache.set(hex, value);
    }
    return value;
  };
  const [l1, a1, b1] = read(left);
  const [l2, a2, b2] = read(right);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
