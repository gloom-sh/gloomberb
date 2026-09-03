
export function blendHex(a: string, b: string, ratio: number): string {
  const parse = (hex: string) => {
    const h = hex.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] as const;
  };
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const mix = (x: number, y: number) => Math.round(x + (y - x) * ratio).toString(16).padStart(2, "0");
  return `#${mix(ar, br)}${mix(ag, bg)}${mix(ab, bb)}`;
}

export function relativeLuminance(hex: string): number {
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
}

export function contrastRatio(a: string, b: string): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

const CONTRAST_BLEND_STEPS = [0, 0.08, 0.14, 0.2, 0.28, 0.36, 0.48, 0.62, 0.78, 1] as const;

export function blendForContrast(base: string, against: string, fallback: string, minContrast: number): string {
  let candidate = base;

  for (const ratio of CONTRAST_BLEND_STEPS) {
    candidate = ratio === 0 ? base : blendHex(base, fallback, ratio);
    if (contrastRatio(candidate, against) >= minContrast) {
      return candidate;
    }
  }

  return candidate;
}

export function blendForContrastOnSurfaces(
  base: string,
  surfaces: readonly string[],
  fallback: string,
  minContrast: number,
): string {
  let candidate = base;

  for (const ratio of CONTRAST_BLEND_STEPS) {
    candidate = ratio === 0 ? base : blendHex(base, fallback, ratio);
    if (surfaces.every((surface) => contrastRatio(candidate, surface) >= minContrast)) {
      return candidate;
    }
  }

  return candidate;
}

export function higherContrast(a: string, b: string, against: string): string {
  return contrastRatio(a, against) >= contrastRatio(b, against) ? a : b;
}
