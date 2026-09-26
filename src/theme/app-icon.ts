import { blendHex, relativeLuminance } from "./color-utils";
import type { Theme } from "./themes";

// The Gloom mark: a lit dot with two soft halos of the same color on a tile.
// The official icon is mint on graphite; the desktop Dock icon repaints it in
// the active theme's accent.
export const APP_ICON_ACCENT = "#6de7b6";
export const APP_ICON_BACKGROUND = "#252628";

const CANVAS = 1024;
const CENTER = CANVAS / 2;
// Apple's icon grid: an 824px tile centered on the 1024px canvas.
export const MACOS_ICON_TILE = 824;

// Dot radius as a share of the tile; the halos are multiples of it.
const DOT_RADIUS = 0.2924;
const HALOS = [
  { radius: 1.6, opacity: 0.06 },
  { radius: 1.3, opacity: 0.14 },
] as const;

export interface AppIconColors {
  accent: string;
  background: string;
}

export function appIconColors(theme: Theme): AppIconColors {
  return {
    accent: theme.borderFocused,
    // A pure black tile reads as a hole in the Dock, so black themes get graphite.
    background: theme.bg === "#000000" ? APP_ICON_BACKGROUND : theme.bg,
  };
}

const round = (value: number) => Math.round(value * 10) / 10;

// Darkens through HSL lightness so the dot's shaded side keeps its saturation;
// blending toward black turns mint and amber muddy.
function darken(hex: string, amount: number): string {
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const chroma = max - min;
  const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
  const hue = chroma === 0 ? 0
    : max === r ? ((g - b) / chroma + 6) % 6
    : max === g ? (b - r) / chroma + 2
    : (r - g) / chroma + 4;
  const nextLightness = Math.max(0, lightness - amount);
  const nextChroma = (1 - Math.abs(2 * nextLightness - 1)) * saturation;
  const x = nextChroma * (1 - Math.abs((hue % 2) - 1));
  const m = nextLightness - nextChroma / 2;
  const [r1, g1, b1] = hue < 1 ? [nextChroma, x, 0]
    : hue < 2 ? [x, nextChroma, 0]
    : hue < 3 ? [0, nextChroma, x]
    : hue < 4 ? [0, x, nextChroma]
    : hue < 5 ? [x, 0, nextChroma]
    : [nextChroma, 0, x];
  return `#${[r1, g1, b1].map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function squircle(size: number): string {
  const radius = size / 2;
  const points: string[] = [];
  for (let step = 0; step < 240; step++) {
    const angle = (step / 240) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = CENTER + radius * Math.sign(cos) * Math.abs(cos) ** 0.4;
    const y = CENTER + radius * Math.sign(sin) * Math.abs(sin) ** 0.4;
    points.push(`${round(x)} ${round(y)}`);
  }
  return `M${points.join("L")}Z`;
}

const stops = (colors: readonly string[]) =>
  colors.map((color, index) => `<stop offset="${round(index / (colors.length - 1))}" stop-color="${color}"/>`).join("");

// Shadows are stacked translucent shapes rather than SVG filters: macOS draws
// the Dock icon from this SVG and ignores filters.
export function appIconSvg({
  accent = APP_ICON_ACCENT,
  background = APP_ICON_BACKGROUND,
}: Partial<AppIconColors> = {}): string {
  const tile = MACOS_ICON_TILE;
  const light = relativeLuminance(background) > 0.5;
  const shade = light ? 0.55 : 1;
  const body = squircle(tile);
  const tileTop = blendHex(background, "#ffffff", light ? 0.5 : 0.05);
  const tileBottom = blendHex(background, "#000000", light ? 0.06 : 0.2);
  const dot = [blendHex(accent, "#ffffff", 0.35), accent, darken(accent, 0.18)];
  const dotRadius = tile * DOT_RADIUS;
  const tileShadow = [
    { grow: 12, drop: 14, opacity: 0.04 },
    { grow: 6, drop: 9, opacity: 0.06 },
    { grow: 0, drop: 5, opacity: 0.12 },
  ];
  const dotShadow = [
    { grow: 1.08, opacity: 0.05 },
    { grow: 1.04, opacity: 0.08 },
    { grow: 1, opacity: 0.14 },
  ];

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}">`,
    "<defs>",
    `<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">${stops([tileTop, tileBottom])}</linearGradient>`,
    `<linearGradient id="dot" x1="0.2" y1="0.05" x2="0.8" y2="0.95">${stops(dot)}</linearGradient>`,
    `<clipPath id="body"><path d="${body}"/></clipPath>`,
    "</defs>",
    ...tileShadow.map(({ grow, drop, opacity }) => {
      const scale = round((tile + grow) / tile * 1000) / 1000;
      return `<path d="${body}" fill="#000000" opacity="${round(opacity * shade * 100) / 100}" transform="translate(0 ${drop}) translate(${CENTER} ${CENTER}) scale(${scale}) translate(-${CENTER} -${CENTER})"/>`;
    }),
    `<path d="${body}" fill="url(#tile)"/>`,
    `<g clip-path="url(#body)">`,
    `<path d="${body}" fill="none" stroke="#ffffff" stroke-opacity="${light ? 0.5 : 0.07}" stroke-width="6"/>`,
    ...HALOS.map(({ radius, opacity }) =>
      `<circle cx="${CENTER}" cy="${CENTER}" r="${round(dotRadius * radius)}" fill="${accent}" opacity="${opacity}"/>`),
    ...dotShadow.map(({ grow, opacity }) =>
      `<circle cx="${round(CENTER + tile * 0.012)}" cy="${round(CENTER + tile * 0.024)}" r="${round(dotRadius * grow)}" fill="#000000" opacity="${round(opacity * shade * 100) / 100}"/>`),
    `<circle cx="${CENTER}" cy="${CENTER}" r="${round(dotRadius)}" fill="url(#dot)"/>`,
    "</g>",
    "</svg>",
  ].join("");
}
