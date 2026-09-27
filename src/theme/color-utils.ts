// These run per row and per badge on every render of any list, and the
// inputs come from a palette of a few dozen colours. Each function keeps its
// results by argument so the gamma math and hex parsing happen once per
// distinct input rather than thousands of times per frame. The caches are
// bounded so an unexpected stream of one-off colours cannot grow them.
const CACHE_LIMIT = 4096;

function remember<T>(cache: Map<string, T>, key: string, compute: () => T): T {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = compute();
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

const blendCache = new Map<string, string>();
const luminanceCache = new Map<string, number>();
const contrastBlendCache = new Map<string, string>();
const separationBlendCache = new Map<string, string>();

/** The 0-255 channels of a six-digit `#rrggbb` colour. */
export function parseHex(hex: string): readonly [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] as const;
}

export function blendHex(a: string, b: string, ratio: number): string {
  return remember(blendCache, `${a}|${b}|${ratio}`, () => {
    const [ar, ag, ab] = parseHex(a);
    const [br, bg, bb] = parseHex(b);
    const mix = (x: number, y: number) => Math.round(x + (y - x) * ratio).toString(16).padStart(2, "0");
    return `#${mix(ar, br)}${mix(ag, bg)}${mix(ab, bb)}`;
  });
}

export function relativeLuminance(hex: string): number {
  return remember(luminanceCache, hex, () => {
    const h = hex.replace("#", "");
    const toLinear = (value: string) => {
      const normalized = parseInt(value, 16) / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : Math.pow((normalized + 0.055) / 1.055, 2.4);
    };
    const r = toLinear(h.slice(0, 2));
    const g = toLinear(h.slice(2, 4));
    const b = toLinear(h.slice(4, 6));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  });
}

export function contrastRatio(a: string, b: string): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

const CONTRAST_BLEND_STEPS = [0, 0.08, 0.14, 0.2, 0.28, 0.36, 0.48, 0.62, 0.78, 1] as const;
// Fine enough that a tint stops as soon as it is legible rather than
// overshooting to the next coarse step and reading as a block of colour.
const SEPARATION_BLEND_STEP = 0.02;

export function blendForContrast(base: string, against: string, fallback: string, minContrast: number): string {
  return remember(contrastBlendCache, `${base}|${against}|${fallback}|${minContrast}`, () => {
    let candidate = base;

    for (const ratio of CONTRAST_BLEND_STEPS) {
      candidate = ratio === 0 ? base : blendHex(base, fallback, ratio);
      if (contrastRatio(candidate, against) >= minContrast) {
        return candidate;
      }
    }

    return candidate;
  });
}

/**
 * A surface tint that carries the same weight in every palette. A fixed blend
 * ratio cannot: how far it moves the eye depends entirely on where the accent
 * sits relative to the background, so the same code reads as a clear band in
 * one theme and as nothing at all in another. This walks `base` toward `tint`
 * only as far as it takes to separate from `against`, and never past
 * `maxRatio`, so a palette whose accent shares the background's luminance
 * ends up tinted rather than flooded.
 */
export function blendForSeparation(
  base: string,
  tint: string,
  against: string,
  minContrast: number,
  maxRatio: number,
): string {
  return remember(separationBlendCache, `${base}|${tint}|${against}|${minContrast}|${maxRatio}`, () => {
    for (let ratio = SEPARATION_BLEND_STEP; ratio < maxRatio; ratio += SEPARATION_BLEND_STEP) {
      const candidate = blendHex(base, tint, ratio);
      if (contrastRatio(candidate, against) >= minContrast) return candidate;
    }
    return blendHex(base, tint, maxRatio);
  });
}

export function blendForContrastOnSurfaces(
  base: string,
  surfaces: readonly string[],
  fallback: string,
  minContrast: number,
): string {
  return remember(contrastBlendCache, `${base}|${surfaces.join(",")}|${fallback}|${minContrast}`, () => {
    let candidate = base;

    for (const ratio of CONTRAST_BLEND_STEPS) {
      candidate = ratio === 0 ? base : blendHex(base, fallback, ratio);
      if (surfaces.every((surface) => contrastRatio(candidate, surface) >= minContrast)) {
        return candidate;
      }
    }

    return candidate;
  });
}

export function higherContrast(a: string, b: string, against: string): string {
  return contrastRatio(a, against) >= contrastRatio(b, against) ? a : b;
}
