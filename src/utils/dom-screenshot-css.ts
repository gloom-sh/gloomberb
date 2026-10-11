/**
 * Parsing for the CSS the pane capture paints by hand: box shadows, linear
 * gradients and where a background or mask image sits in its box. Inputs are
 * computed values, so colours are already resolved and lengths are in px.
 */

/** Splits on `separator` where it is outside parentheses: `rgb(1, 2, 3) 0px 1px, ...`. */
export function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === separator && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const LENGTH = /^-?(\d+\.?\d*|\.\d+)(px)?$/;

interface BoxShadow {
  color: string;
  x: number;
  y: number;
  blur: number;
  spread: number;
  inset: boolean;
}

/** A computed `box-shadow`, colour first (Chrome) or last. */
export function parseBoxShadows(value: string): BoxShadow[] {
  if (!value || value === "none") return [];
  return splitTopLevel(value, ",").flatMap((layer) => {
    let inset = false;
    let color = "";
    const lengths: number[] = [];
    for (const token of splitTopLevel(layer, " ")) {
      if (token === "inset") inset = true;
      else if (LENGTH.test(token)) lengths.push(Number.parseFloat(token));
      else color = token;
    }
    const [x, y, blur = 0, spread = 0] = lengths;
    if (x === undefined || y === undefined || !color) return [];
    return [{ color, x, y, blur, spread, inset }];
  });
}

/** The `url()` a computed image layer points at, or null for a gradient or `none`. */
export function cssUrl(layer: string): string | null {
  const match = /^url\(\s*(["']?)(.*)\1\s*\)$/s.exec(layer.trim());
  return match ? match[2]!.replace(/\\(["'\\])/g, "$1") : null;
}

interface GradientStop {
  /** 0..1 along the gradient line. */
  offset: number;
  color: string;
}

interface LinearGradient {
  /** The gradient line in the box's coordinates. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  stops: GradientStop[];
}

const SIDE_ANGLES: Record<string, number> = {
  "to top": 0,
  "to right": 90,
  "to bottom": 180,
  "to left": 270,
  "to top right": 45,
  "to right top": 45,
  "to bottom right": 135,
  "to right bottom": 135,
  "to bottom left": 225,
  "to left bottom": 225,
  "to top left": 315,
  "to left top": 315,
};

function angleDegrees(token: string): number | null {
  if (token in SIDE_ANGLES) return SIDE_ANGLES[token]!;
  const match = /^(-?[\d.]+)(deg|grad|rad|turn)$/.exec(token);
  if (!match) return null;
  const value = Number.parseFloat(match[1]!);
  switch (match[2]) {
    case "grad": return value * 0.9;
    case "rad": return (value * 180) / Math.PI;
    case "turn": return value * 360;
    default: return value;
  }
}

function stopPosition(token: string, length: number): number | null {
  if (token.endsWith("%")) return (Number.parseFloat(token) / 100) * length;
  return LENGTH.test(token) ? Number.parseFloat(token) : null;
}

/**
 * A computed `linear-gradient()` or `repeating-linear-gradient()` over a box
 * of `width` x `height`, as a canvas gradient line with stops in order. Null
 * for anything else (radial and conic gradients, or values it cannot read).
 */
export function parseLinearGradient(value: string, width: number, height: number): LinearGradient | null {
  const match = /^(repeating-)?linear-gradient\((.*)\)$/s.exec(value.trim());
  if (!match) return null;
  const repeating = !!match[1];
  const args = splitTopLevel(match[2]!, ",");
  const first = args[0] ?? "";
  const angle = angleDegrees(first);
  const stopArgs = angle === null ? args : args.slice(1);
  const degrees = angle ?? 180;

  // The CSS gradient line: through the centre, long enough to reach the corners.
  const radians = (degrees * Math.PI) / 180;
  const dx = Math.sin(radians);
  const dy = -Math.cos(radians);
  const length = Math.abs(width * dx) + Math.abs(height * dy);
  if (!(length > 0)) return null;

  // Each stop is a colour with zero, one or two positions.
  const raw: { color: string; position: number | null }[] = [];
  for (const stop of stopArgs) {
    const tokens = splitTopLevel(stop, " ");
    const positions = tokens.map((token) => stopPosition(token, length));
    const color = tokens.filter((_, index) => positions[index] === null).join(" ");
    const given = positions.filter((position): position is number => position !== null);
    if (!color) continue; // A bare interpolation hint: interpolate linearly instead.
    if (given.length === 0) raw.push({ color, position: null });
    for (const position of given.slice(0, 2)) raw.push({ color, position });
  }
  if (raw.length < 2) return null;

  // Unpositioned ends sit at 0 and 100%; others share the gap between their neighbours.
  if (raw[0]!.position === null) raw[0]!.position = 0;
  if (raw.at(-1)!.position === null) raw.at(-1)!.position = length;
  for (let index = 1; index < raw.length; index += 1) {
    if (raw[index]!.position !== null) continue;
    let next = index;
    while (raw[next]!.position === null) next += 1;
    const from = raw[index - 1]!.position!;
    const to = raw[next]!.position!;
    for (let fill = index; fill < next; fill += 1) {
      raw[fill]!.position = from + ((to - from) * (fill - index + 1)) / (next - index + 1);
    }
  }
  // A stop never sits before the one ahead of it.
  let floor = -Infinity;
  const stops = raw.map(({ color, position }) => {
    floor = Math.max(floor, position!);
    return { color, position: floor };
  });

  let positioned = stops;
  if (repeating) {
    const start = stops[0]!.position;
    const period = stops.at(-1)!.position - start;
    if (!(period > 0)) return null;
    positioned = [];
    // Enough copies to cover the line, capped so a hairline period cannot run away.
    const firstCopy = Math.floor(-start / period) - 1;
    const copies = Math.min(Math.ceil(length / period) + 2, 2_000);
    for (let copy = firstCopy; copy < firstCopy + copies; copy += 1) {
      for (const stop of stops) positioned.push({ color: stop.color, position: stop.position + copy * period });
    }
  }

  const clamped = clampStops(positioned, length);
  if (clamped.length < 2) return null;
  const centerX = width / 2;
  const centerY = height / 2;
  return {
    x0: centerX - (dx * length) / 2,
    y0: centerY - (dy * length) / 2,
    x1: centerX + (dx * length) / 2,
    y1: centerY + (dy * length) / 2,
    stops: clamped,
  };
}

/** Stops cut to the 0..length line; a stop off either end keeps its colour at the end. */
function clampStops(stops: { color: string; position: number }[], length: number): GradientStop[] {
  const inside = stops.filter((stop) => stop.position >= 0 && stop.position <= length);
  const before = stops.filter((stop) => stop.position < 0).at(-1);
  const after = stops.find((stop) => stop.position > length);
  const result = [
    ...(before ? [{ color: before.color, position: 0 }] : []),
    ...inside,
    ...(after ? [{ color: after.color, position: length }] : []),
  ];
  return result.map((stop) => ({ color: stop.color, offset: stop.position / length }));
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function sizeComponent(token: string | undefined, available: number): number | null {
  if (!token || token === "auto") return null;
  if (token.endsWith("%")) return (Number.parseFloat(token) / 100) * available;
  return LENGTH.test(token) ? Number.parseFloat(token) : null;
}

/**
 * Where one image of `natural` size lands in `area` under computed
 * `background-size` and `background-position` (the same for masks).
 */
export function imageLayerRect(
  area: Box,
  natural: { width: number; height: number },
  size: string,
  position: string,
): Box {
  const ratio = natural.width > 0 && natural.height > 0 ? natural.width / natural.height : 1;
  let width: number;
  let height: number;
  if (size === "contain" || size === "cover") {
    const fit = size === "contain"
      ? Math.min(area.width / natural.width, area.height / natural.height)
      : Math.max(area.width / natural.width, area.height / natural.height);
    width = natural.width * fit;
    height = natural.height * fit;
  } else {
    const [w, h] = splitTopLevel(size || "auto", " ");
    const givenWidth = sizeComponent(w, area.width);
    const givenHeight = sizeComponent(h, area.height);
    width = givenWidth ?? (givenHeight !== null ? givenHeight * ratio : natural.width);
    height = givenHeight ?? (givenWidth !== null ? givenWidth / ratio : natural.height);
  }
  const [px = "0%", py = "0%"] = splitTopLevel(position || "0% 0%", " ");
  const offset = (token: string, free: number) => (token.endsWith("%")
    ? (Number.parseFloat(token) / 100) * free
    : Number.parseFloat(token) || 0);
  return {
    x: area.x + offset(px, area.width - width),
    y: area.y + offset(py, area.height - height),
    width,
    height,
  };
}

/** Where an image of `natural` size lands in `box` under `object-fit`, centred as the default `object-position` does. */
export function objectFitRect(fit: string, box: Box, natural: { width: number; height: number }): Box {
  if (fit === "fill" || natural.width <= 0 || natural.height <= 0) return box;
  const contain = Math.min(box.width / natural.width, box.height / natural.height);
  const scale = fit === "contain" ? contain
    : fit === "cover" ? Math.max(box.width / natural.width, box.height / natural.height)
    : fit === "scale-down" ? Math.min(1, contain)
    : 1;
  const width = natural.width * scale;
  const height = natural.height * scale;
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}
