import { colors, type ThemeColors } from "./colors";
import { blendHex, contrastRatio, higherContrast, relativeLuminance } from "./color-utils";

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
 * Heat map tiles take their colours from the selected theme. Losses run from
 * a muted middle to the theme's negative colour and gains to its positive, so
 * the strongest tiles are the app's own down and up colours. The middle is
 * the theme's neutral tone, lifted off a dark page or set into a light one
 * just far enough to read as a tile. Colour builds in OKLab, hue ahead of
 * lightness so a small move already leans to its side, and is full at 3%.
 * Each tile takes whichever of the theme's light or dark text reads better
 * on it, or white or black where neither reaches 4.5:1.
 */
const HEATMAP_TILE_FULL_SCALE_PERCENT = 3;
/** How fast colour builds from flat: below 1 a small move already leans to its side. */
const HEATMAP_TILE_EASING = 0.8;
/** Hue arrives ahead of lightness, so a mid-size move is a clear colour, not a grey. */
const HEATMAP_TILE_HUE_LEAD = 0.4;
const HEATMAP_TILE_TEXT_MIN_CONTRAST = 4.5;
/** How far the flat middle stands off the page, as contrast against the background. */
const HEATMAP_FLAT_CONTRAST = { dark: 2.1, light: 1.4 } as const;
/** A missing move sits between the page and the flat middle: there, but saying nothing. */
const HEATMAP_MISSING_CONTRAST = { dark: 1.35, light: 1.16 } as const;
/** The middle keeps a hint of the theme's neutral tint, never a colour of its own. */
const HEATMAP_FLAT_MAX_CHROMA = 0.025;
const HEATMAP_MISSING_MAX_CHROMA = 0.008;
/** Light text tokens with more colour than this (a phosphor green, amber) are left off the tiles. */
const HEATMAP_INK_MAX_CHROMA = 0.06;
/** Luminance a token needs to count as the theme's light text, and may not exceed to count as its dark text. */
const HEATMAP_INK_LUMINANCE = { light: 0.6, dark: 0.05 } as const;
/** Below this an end has no hue to carry the scale. */
const HEATMAP_END_MIN_CHROMA = 0.05;
/** The full-strength end must stand this far from the flat middle... */
const HEATMAP_END_MIN_FROM_FLAT = 0.12;
/** ...and the two ends this far from each other. */
const HEATMAP_ENDS_MIN_APART = 0.15;
/**
 * Only for a palette whose own up and down colours cannot carry the scale: an
 * end too close to the page keeps its hue at this lightness, and an end with
 * no hue, or two ends too alike, take the usual red and green.
 */
const HEATMAP_FALLBACK = {
  lightness: { dark: 0.7, light: 0.52 },
  chroma: 0.15,
  lossHue: 25,
  gainHue: 150,
} as const;
/** How far a selected tile is pulled away from the page, further for a tile already near the end of the range. */
const HEATMAP_SELECTED_LIFT = { start: 0.45, step: 0.05, max: 0.8 } as const;
const HEATMAP_SELECTED_MIN_DISTANCE = 0.1;
const HEATMAP_STEPS = 64;
const HEATMAP_SCALE_CACHE_LIMIT = 32;

export interface HeatmapTileColors {
  background: string;
  foreground: string;
}

/** A selected tile's outline on the desktop and the web: a ring, then a hairline of the page. */
export interface HeatmapSelectionRing {
  outer: string;
  inner: string;
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

function oklabToLinear([lightness, a, b]: Oklab): [number, number, number] {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut(color: Oklab): boolean {
  return oklabToLinear(color).every((channel) => channel >= -0.0005 && channel <= 1.0005);
}

/** Into sRGB by giving up chroma, never lightness or hue, so a clipped colour cannot drift toward another. */
function toGamut(color: Oklab): Oklab {
  if (inGamut(color)) return color;
  const [lightness, a, b] = color;
  let low = 0;
  let high = 1;
  for (let index = 0; index < 20; index += 1) {
    const mid = (low + high) / 2;
    if (inGamut([lightness, a * mid, b * mid])) low = mid;
    else high = mid;
  }
  return [lightness, a * low, b * low];
}

function oklabToHex(color: Oklab): string {
  return `#${oklabToLinear(toGamut(color)).map((channel) => linearToSrgb(channel).toString(16).padStart(2, "0")).join("")}`;
}

function chromaOf(color: Oklab): number {
  return Math.hypot(color[1], color[2]);
}

function oklabDistance(left: Oklab, right: Oklab): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

/** The colour's hue at most `maxChroma` strong. */
function tint(color: Oklab, maxChroma: number): [number, number] {
  const chroma = chromaOf(color);
  const scale = chroma > maxChroma ? maxChroma / chroma : 1;
  return [color[1] * scale, color[2] * scale];
}

/**
 * The lightness at which a tile of this tint stands `contrast` off the page:
 * above a dark page, below a light one.
 */
function standOffPage(page: string, [a, b]: readonly [number, number], contrast: number, dark: boolean): Oklab {
  const pageLightness = hexToOklab(page)[0];
  let low = dark ? pageLightness : 0;
  let high = dark ? 1 : pageLightness;
  for (let index = 0; index < 24; index += 1) {
    const mid = (low + high) / 2;
    const reaches = contrastRatio(oklabToHex([mid, a, b]), page) >= contrast;
    if (dark === reaches) high = mid;
    else low = mid;
  }
  return toGamut([dark ? high : low, a, b]);
}

interface HeatmapInks {
  light: string;
  dark: string;
}

/**
 * The theme's own text for tiles: its lightest near-neutral tone and its
 * darkest, with white and black where the theme has none.
 */
function heatmapInks(palette: ThemeColors): HeatmapInks {
  const tokens = [palette.textBright, palette.text, palette.selectedText, palette.headerText, palette.bg, palette.panel];
  const lights = tokens.filter((token) => relativeLuminance(token) >= HEATMAP_INK_LUMINANCE.light && chromaOf(hexToOklab(token)) <= HEATMAP_INK_MAX_CHROMA);
  const darks = tokens.filter((token) => relativeLuminance(token) <= HEATMAP_INK_LUMINANCE.dark);
  return {
    light: lights.reduce((best, token) => (relativeLuminance(token) > relativeLuminance(best) ? token : best), lights[0] ?? "#ffffff"),
    dark: darks.reduce((best, token) => (relativeLuminance(token) < relativeLuminance(best) ? token : best), darks[0] ?? "#000000"),
  };
}

function heatmapTextColor(background: string, inks: HeatmapInks): string {
  const best = higherContrast(inks.light, inks.dark, background);
  if (contrastRatio(best, background) >= HEATMAP_TILE_TEXT_MIN_CONTRAST) return best;
  return higherContrast("#ffffff", "#000000", background);
}

interface HeatmapEnd {
  color: Oklab;
  /** The theme's own token when it carries the scale as is. */
  hex: string;
}

function fallbackEnd(hue: number, dark: boolean): HeatmapEnd {
  const radians = hue * Math.PI / 180;
  const color = toGamut([
    dark ? HEATMAP_FALLBACK.lightness.dark : HEATMAP_FALLBACK.lightness.light,
    HEATMAP_FALLBACK.chroma * Math.cos(radians),
    HEATMAP_FALLBACK.chroma * Math.sin(radians),
  ]);
  return { color, hex: oklabToHex(color) };
}

/**
 * The theme's up or down colour as the end of the scale. One that sits too
 * close to the page keeps its hue at a lightness that stands clear; one with
 * no hue to speak of gives way to the fallback.
 */
function heatmapEnd(token: string, fallbackHue: number, flat: Oklab, page: Oklab, dark: boolean): HeatmapEnd {
  const color = hexToOklab(token);
  const chroma = chromaOf(color);
  if (chroma < HEATMAP_END_MIN_CHROMA) return fallbackEnd(fallbackHue, dark);
  if (oklabDistance(color, flat) >= HEATMAP_END_MIN_FROM_FLAT && oklabDistance(color, page) >= oklabDistance(flat, page)) {
    return { color, hex: token };
  }
  const scale = Math.max(chroma, HEATMAP_FALLBACK.chroma) / chroma;
  const lifted = toGamut([
    dark ? HEATMAP_FALLBACK.lightness.dark : HEATMAP_FALLBACK.lightness.light,
    color[1] * scale,
    color[2] * scale,
  ]);
  return { color: lifted, hex: oklabToHex(lifted) };
}

interface HeatmapScale {
  /** 2 * HEATMAP_STEPS + 1 tiles from full loss to full gain. */
  tiles: HeatmapTileColors[];
  selected: HeatmapTileColors[];
  missing: HeatmapTileColors;
  missingSelected: HeatmapTileColors;
  ring: HeatmapSelectionRing;
}

function buildHeatmapScale(palette: ThemeColors): HeatmapScale {
  // Dark is defined as the theme defines it: text lighter than the page.
  const dark = relativeLuminance(palette.text) > relativeLuminance(palette.bg);
  const inks = heatmapInks(palette);
  const page = hexToOklab(palette.bg);
  // Halfway between the page's tint and the neutral's, so a warm page gets a warm grey and a black one the neutral's.
  const neutral = hexToOklab(palette.neutral);
  const grey: Oklab = [neutral[0], (page[1] + neutral[1]) / 2, (page[2] + neutral[2]) / 2];
  const flat = standOffPage(palette.bg, tint(grey, HEATMAP_FLAT_MAX_CHROMA), dark ? HEATMAP_FLAT_CONTRAST.dark : HEATMAP_FLAT_CONTRAST.light, dark);
  let loss = heatmapEnd(palette.negative, HEATMAP_FALLBACK.lossHue, flat, page, dark);
  let gain = heatmapEnd(palette.positive, HEATMAP_FALLBACK.gainHue, flat, page, dark);
  if (oklabDistance(loss.color, gain.color) < HEATMAP_ENDS_MIN_APART) {
    loss = fallbackEnd(HEATMAP_FALLBACK.lossHue, dark);
    gain = fallbackEnd(HEATMAP_FALLBACK.gainHue, dark);
  }

  const lift = dark ? inks.light : inks.dark;
  const tile = (background: string): HeatmapTileColors => ({ background, foreground: heatmapTextColor(background, inks) });
  const selectedTile = (background: string) => {
    let ratio: number = HEATMAP_SELECTED_LIFT.start;
    while (ratio < HEATMAP_SELECTED_LIFT.max && oklabDistance(hexToOklab(blendHex(background, lift, ratio)), hexToOklab(background)) < HEATMAP_SELECTED_MIN_DISTANCE) {
      ratio += HEATMAP_SELECTED_LIFT.step;
    }
    return tile(blendHex(background, lift, Math.min(ratio, HEATMAP_SELECTED_LIFT.max)));
  };
  const tiles: HeatmapTileColors[] = [];
  for (let step = -HEATMAP_STEPS; step <= HEATMAP_STEPS; step += 1) {
    const end = step < 0 ? loss : gain;
    if (Math.abs(step) === HEATMAP_STEPS) {
      tiles.push(tile(end.hex));
      continue;
    }
    const strength = (Math.abs(step) / HEATMAP_STEPS) ** HEATMAP_TILE_EASING;
    const hue = strength ** HEATMAP_TILE_HUE_LEAD;
    tiles.push(tile(oklabToHex([
      flat[0] + (end.color[0] - flat[0]) * strength,
      flat[1] + (end.color[1] - flat[1]) * hue,
      flat[2] + (end.color[2] - flat[2]) * hue,
    ])));
  }
  const missing = tile(oklabToHex(standOffPage(
    palette.bg,
    tint(grey, HEATMAP_MISSING_MAX_CHROMA),
    dark ? HEATMAP_MISSING_CONTRAST.dark : HEATMAP_MISSING_CONTRAST.light,
    dark,
  )));
  return {
    tiles,
    selected: tiles.map(({ background }) => selectedTile(background)),
    missing,
    missingSelected: selectedTile(missing.background),
    ring: { outer: lift, inner: palette.bg },
  };
}

const heatmapScaleCache = new Map<string, HeatmapScale>();

/**
 * Built once per palette and keyed by its colours, never by its name or a
 * light or dark flag, so a theme switch or an edited palette recolours the
 * map at once.
 */
function heatmapScale(palette: ThemeColors): HeatmapScale {
  const key = `${palette.bg}|${palette.panel}|${palette.text}|${palette.textBright}|${palette.selectedText}|${palette.headerText}|${palette.neutral}|${palette.positive}|${palette.negative}`;
  let scale = heatmapScaleCache.get(key);
  if (!scale) {
    scale = buildHeatmapScale(palette);
    if (heatmapScaleCache.size >= HEATMAP_SCALE_CACHE_LIMIT) heatmapScaleCache.clear();
    heatmapScaleCache.set(key, scale);
  }
  return scale;
}

function heatmapStep(changePercent: number): number {
  const ratio = Math.max(-1, Math.min(1, changePercent / HEATMAP_TILE_FULL_SCALE_PERCENT));
  return Math.round(ratio * HEATMAP_STEPS) + HEATMAP_STEPS;
}

function hasMove(changePercent: number | null | undefined): changePercent is number {
  return changePercent != null && Number.isFinite(changePercent);
}

/**
 * The tile colours for a day's move in percent. Full strength at +/-3%; a
 * missing move is the theme's grey, never the flat colour, so it cannot pass
 * for an unchanged price.
 */
export function resolveHeatmapTileColors(
  changePercent: number | null | undefined,
  palette: ThemeColors = colors,
): HeatmapTileColors {
  const scale = heatmapScale(palette);
  return hasMove(changePercent) ? scale.tiles[heatmapStep(changePercent)]! : scale.missing;
}

/**
 * The selected tile on a cell grid, which cannot draw an outline: the same
 * hue pulled away from the page, lighter on a dark theme and deeper on a
 * light one, so the selection still says which way it moved.
 */
export function resolveHeatmapSelectedTileColors(
  changePercent: number | null | undefined,
  palette: ThemeColors = colors,
): HeatmapTileColors {
  const scale = heatmapScale(palette);
  return hasMove(changePercent) ? scale.selected[heatmapStep(changePercent)]! : scale.missingSelected;
}

/** The selected tile's outline where one can be drawn: the theme's text tone against the page, then a hairline of the page. */
export function resolveHeatmapSelectionRing(palette: ThemeColors = colors): HeatmapSelectionRing {
  return heatmapScale(palette).ring;
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
  return oklabDistance(read(left), read(right));
}
