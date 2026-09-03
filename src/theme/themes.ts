import {
  blendForContrast,
  blendForContrastOnSurfaces,
  blendHex,
  contrastRatio,
  higherContrast,
  relativeLuminance,
} from "./color-utils";

export interface Theme {
  name: string;
  description: string;

  bg: string;
  panel: string;
  border: string;
  borderFocused: string;

  text: string;
  textDim: string;
  textBright: string;
  textMuted: string;

  positive: string;
  negative: string;
  neutral: string;
  warning: string;

  header: string;
  headerText: string;

  selected: string;
  selectedText: string;

  commandBg: string;
  commandBorder: string;
}

const BODY_TEXT_MIN = 4.5;
const SUBTLE_TEXT_MIN = 3.6;
const SELECTED_SURFACE_MIN = 1.75;

function highestMinimumContrast(surfaces: readonly string[], candidates: readonly string[]): string {
  return candidates.reduce((best, candidate) => {
    const bestScore = Math.min(...surfaces.map((surface) => contrastRatio(best, surface)));
    const candidateScore = Math.min(...surfaces.map((surface) => contrastRatio(candidate, surface)));
    return candidateScore > bestScore ? candidate : best;
  });
}

function normalizeTheme(theme: Theme): Theme {
  const bodySurfaces = [theme.bg, theme.panel] as const;
  const bodyContrastExtreme = highestMinimumContrast(bodySurfaces, ["#ffffff", "#000000"]);
  const text = blendForContrastOnSurfaces(
    theme.text,
    bodySurfaces,
    highestMinimumContrast(bodySurfaces, [theme.textBright, theme.headerText, "#f2f2f2"]),
    BODY_TEXT_MIN,
  );
  const textDim = blendForContrastOnSurfaces(
    theme.textDim,
    bodySurfaces,
    highestMinimumContrast(bodySurfaces, [text, theme.textBright, "#d0d7de"]),
    BODY_TEXT_MIN,
  );
  const textMuted = blendForContrastOnSurfaces(
    theme.textMuted,
    bodySurfaces,
    highestMinimumContrast(bodySurfaces, [textDim, text, "#c0c7d1"]),
    SUBTLE_TEXT_MIN,
  );
  const positive = blendForContrastOnSurfaces(
    theme.positive,
    bodySurfaces,
    blendHex(theme.positive, theme.textBright, 0.5),
    SUBTLE_TEXT_MIN,
  );
  const negative = blendForContrastOnSurfaces(
    theme.negative,
    bodySurfaces,
    blendHex(theme.negative, theme.textBright, 0.45),
    SUBTLE_TEXT_MIN,
  );
  const neutral = blendForContrastOnSurfaces(
    theme.neutral,
    bodySurfaces,
    highestMinimumContrast(bodySurfaces, [textDim, text, "#c0c7d1"]),
    SUBTLE_TEXT_MIN,
  );
  const warning = blendForContrastOnSurfaces(
    theme.warning,
    bodySurfaces,
    blendHex(theme.warning, theme.textBright, 0.5),
    SUBTLE_TEXT_MIN,
  );
  const selected = blendForContrastOnSurfaces(
    theme.selected,
    bodySurfaces,
    blendHex(theme.selected, bodyContrastExtreme, 0.62),
    SELECTED_SURFACE_MIN,
  );
  const headerText = blendForContrast(
    theme.headerText,
    theme.header,
    higherContrast(text, theme.textBright, theme.header),
    BODY_TEXT_MIN,
  );
  const selectedText = blendForContrast(
    theme.selectedText,
    selected,
    highestMinimumContrast([selected], [text, theme.textBright, "#f2f2f2"]),
    BODY_TEXT_MIN,
  );

  return {
    ...theme,
    text,
    textDim,
    textMuted,
    positive,
    negative,
    neutral,
    warning,
    headerText,
    selected,
    selectedText,
  };
}

const rawThemes: Record<string, Theme> = {
  amber: {
    name: "Amber",
    description: "Classic amber-on-black terminal",
    bg: "#000000",
    panel: "#0a0a14",
    border: "#1a3a5c",
    borderFocused: "#ff8800",
    text: "#ff8800",
    textDim: "#886622",
    textBright: "#ffaa00",
    textMuted: "#555555",
    positive: "#00cc66",
    negative: "#ff3333",
    neutral: "#888888",
    warning: "#ffaa00",
    header: "#0044aa",
    headerText: "#ffffff",
    selected: "#1a3a5c",
    selectedText: "#ffaa00",
    commandBg: "#111122",
    commandBorder: "#ff8800",
  },

  green: {
    name: "Green Phosphor",
    description: "Retro green CRT monitor",
    bg: "#000000",
    panel: "#001100",
    border: "#004400",
    borderFocused: "#00ff00",
    text: "#00cc00",
    textDim: "#006600",
    textBright: "#00ff00",
    textMuted: "#444444",
    positive: "#00ff66",
    negative: "#ff4444",
    neutral: "#666666",
    warning: "#cccc00",
    header: "#003300",
    headerText: "#00ff00",
    selected: "#003300",
    selectedText: "#00ff00",
    commandBg: "#001100",
    commandBorder: "#00cc00",
  },

  cyan: {
    name: "Cyan",
    description: "Cool cyan-on-black terminal",
    bg: "#000000",
    panel: "#000a0a",
    border: "#003333",
    borderFocused: "#00dddd",
    text: "#00bbbb",
    textDim: "#006666",
    textBright: "#00ffff",
    textMuted: "#444444",
    positive: "#00ff88",
    negative: "#ff4444",
    neutral: "#666666",
    warning: "#ddcc00",
    header: "#002222",
    headerText: "#00ffff",
    selected: "#002a2a",
    selectedText: "#00ffff",
    commandBg: "#000a0a",
    commandBorder: "#00bbbb",
  },

  red: {
    name: "Red Phosphor",
    description: "Crimson red-on-black terminal",
    bg: "#000000",
    panel: "#0a0000",
    border: "#330000",
    borderFocused: "#ff2222",
    text: "#cc2222",
    textDim: "#661111",
    textBright: "#ff4444",
    textMuted: "#444444",
    positive: "#44cc44",
    negative: "#ff6666",
    neutral: "#666666",
    warning: "#ddaa00",
    header: "#220000",
    headerText: "#ff3333",
    selected: "#2a0000",
    selectedText: "#ff4444",
    commandBg: "#0a0000",
    commandBorder: "#cc2222",
  },

  blue: {
    name: "Blue Phosphor",
    description: "Electric blue-on-black terminal",
    bg: "#000000",
    panel: "#00000a",
    border: "#000044",
    borderFocused: "#4488ff",
    text: "#3377ee",
    textDim: "#1a3a77",
    textBright: "#66aaff",
    textMuted: "#444444",
    positive: "#00cc66",
    negative: "#ff4444",
    neutral: "#666666",
    warning: "#ddaa00",
    header: "#000033",
    headerText: "#4488ff",
    selected: "#001144",
    selectedText: "#66aaff",
    commandBg: "#00000a",
    commandBorder: "#3377ee",
  },

  purple: {
    name: "Purple Phosphor",
    description: "Violet purple-on-black terminal",
    bg: "#000000",
    panel: "#080008",
    border: "#220033",
    borderFocused: "#bb55ff",
    text: "#9944dd",
    textDim: "#552288",
    textBright: "#cc77ff",
    textMuted: "#444444",
    positive: "#44dd66",
    negative: "#ff4444",
    neutral: "#666666",
    warning: "#ddaa00",
    header: "#1a0028",
    headerText: "#bb55ff",
    selected: "#220033",
    selectedText: "#cc77ff",
    commandBg: "#080008",
    commandBorder: "#9944dd",
  },

  pink: {
    name: "Hot Pink",
    description: "Neon pink-on-black terminal",
    bg: "#000000",
    panel: "#0a0006",
    border: "#33001a",
    borderFocused: "#ff44aa",
    text: "#dd3399",
    textDim: "#771155",
    textBright: "#ff66bb",
    textMuted: "#444444",
    positive: "#44dd66",
    negative: "#ff5555",
    neutral: "#666666",
    warning: "#ddaa00",
    header: "#22000f",
    headerText: "#ff44aa",
    selected: "#2a0018",
    selectedText: "#ff66bb",
    commandBg: "#0a0006",
    commandBorder: "#dd3399",
  },

  white: {
    name: "White Phosphor",
    description: "Clean white-on-black terminal",
    bg: "#000000",
    panel: "#0a0a0a",
    border: "#333333",
    borderFocused: "#ffffff",
    text: "#cccccc",
    textDim: "#666666",
    textBright: "#ffffff",
    textMuted: "#444444",
    positive: "#00cc66",
    negative: "#ff3333",
    neutral: "#888888",
    warning: "#ddaa00",
    header: "#1a1a1a",
    headerText: "#ffffff",
    selected: "#222222",
    selectedText: "#ffffff",
    commandBg: "#0a0a0a",
    commandBorder: "#cccccc",
  },

  paper: {
    name: "Paper",
    description: "Warm light terminal palette",
    bg: "#f7f3e8",
    panel: "#fffaf0",
    border: "#d8cdb7",
    borderFocused: "#a05a2c",
    text: "#2f2a23",
    textDim: "#5f5548",
    textBright: "#17130f",
    textMuted: "#776b5d",
    positive: "#2f7d4a",
    negative: "#b33630",
    neutral: "#6e6256",
    warning: "#946200",
    header: "#eadcc4",
    headerText: "#7a3f1f",
    selected: "#ead1ab",
    selectedText: "#211810",
    commandBg: "#fff7e8",
    commandBorder: "#a05a2c",
  },

  "github-light": {
    name: "GitHub Light",
    description: "Clean light code palette",
    bg: "#ffffff",
    panel: "#f6f8fa",
    border: "#d0d7de",
    borderFocused: "#0969da",
    text: "#24292f",
    textDim: "#57606a",
    textBright: "#0b1220",
    textMuted: "#6e7781",
    positive: "#1a7f37",
    negative: "#cf222e",
    neutral: "#57606a",
    warning: "#9a6700",
    header: "#eaeef2",
    headerText: "#0969da",
    selected: "#ddf4ff",
    selectedText: "#0b1220",
    commandBg: "#f6f8fa",
    commandBorder: "#0969da",
  },

  "solarized-light": {
    name: "Solarized Light",
    description: "Ethan Schoonover's light palette",
    bg: "#fdf6e3",
    panel: "#eee8d5",
    border: "#93a1a1",
    borderFocused: "#b58900",
    text: "#586e75",
    textDim: "#657b83",
    textBright: "#073642",
    textMuted: "#7c8a8a",
    positive: "#859900",
    negative: "#dc322f",
    neutral: "#657b83",
    warning: "#b58900",
    header: "#e6dfc9",
    headerText: "#268bd2",
    selected: "#dce6d6",
    selectedText: "#073642",
    commandBg: "#eee8d5",
    commandBorder: "#b58900",
  },

  "gruvbox-light": {
    name: "Gruvbox Light",
    description: "Retro earthy light palette",
    bg: "#fbf1c7",
    panel: "#f2e5bc",
    border: "#d5c4a1",
    borderFocused: "#af3a03",
    text: "#3c3836",
    textDim: "#665c54",
    textBright: "#282828",
    textMuted: "#7c6f64",
    positive: "#79740e",
    negative: "#9d0006",
    neutral: "#665c54",
    warning: "#b57614",
    header: "#ebdbb2",
    headerText: "#af3a03",
    selected: "#d5c4a1",
    selectedText: "#282828",
    commandBg: "#f2e5bc",
    commandBorder: "#af3a03",
  },

  "nord-light": {
    name: "Nord Light",
    description: "Soft arctic light palette",
    bg: "#eceff4",
    panel: "#e5e9f0",
    border: "#d8dee9",
    borderFocused: "#5e81ac",
    text: "#2e3440",
    textDim: "#4c566a",
    textBright: "#1f2530",
    textMuted: "#687286",
    positive: "#4b7f36",
    negative: "#bf616a",
    neutral: "#4c566a",
    warning: "#9a7500",
    header: "#d8dee9",
    headerText: "#5e81ac",
    selected: "#c8d5e8",
    selectedText: "#1f2530",
    commandBg: "#e5e9f0",
    commandBorder: "#5e81ac",
  },

  tokyo: {
    name: "Tokyo Night",
    description: "Cool blue-purple palette",
    bg: "#1a1b26",
    panel: "#16161e",
    border: "#3b4261",
    borderFocused: "#7aa2f7",
    text: "#c0caf5",
    textDim: "#565f89",
    textBright: "#ffffff",
    textMuted: "#444b6a",
    positive: "#9ece6a",
    negative: "#f7768e",
    neutral: "#565f89",
    warning: "#e0af68",
    header: "#24283b",
    headerText: "#7aa2f7",
    selected: "#283457",
    selectedText: "#c0caf5",
    commandBg: "#16161e",
    commandBorder: "#7aa2f7",
  },

  solarized: {
    name: "Solarized Dark",
    description: "Ethan Schoonover's classic palette",
    bg: "#002b36",
    panel: "#073642",
    border: "#586e75",
    borderFocused: "#b58900",
    text: "#839496",
    textDim: "#586e75",
    textBright: "#fdf6e3",
    textMuted: "#657b83",
    positive: "#859900",
    negative: "#dc322f",
    neutral: "#657b83",
    warning: "#b58900",
    header: "#073642",
    headerText: "#268bd2",
    selected: "#0a4a5c",
    selectedText: "#b58900",
    commandBg: "#002b36",
    commandBorder: "#268bd2",
  },

  dracula: {
    name: "Dracula",
    description: "Popular dark theme with vivid colors",
    bg: "#282a36",
    panel: "#21222c",
    border: "#44475a",
    borderFocused: "#bd93f9",
    text: "#f8f8f2",
    textDim: "#6272a4",
    textBright: "#ffffff",
    textMuted: "#6272a4",
    positive: "#50fa7b",
    negative: "#ff5555",
    neutral: "#6272a4",
    warning: "#f1fa8c",
    header: "#44475a",
    headerText: "#bd93f9",
    selected: "#44475a",
    selectedText: "#f8f8f2",
    commandBg: "#21222c",
    commandBorder: "#bd93f9",
  },

  nord: {
    name: "Nord",
    description: "Arctic, north-bluish palette",
    bg: "#2e3440",
    panel: "#3b4252",
    border: "#4c566a",
    borderFocused: "#88c0d0",
    text: "#d8dee9",
    textDim: "#4c566a",
    textBright: "#eceff4",
    textMuted: "#4c566a",
    positive: "#a3be8c",
    negative: "#bf616a",
    neutral: "#4c566a",
    warning: "#ebcb8b",
    header: "#3b4252",
    headerText: "#88c0d0",
    selected: "#4c566a",
    selectedText: "#eceff4",
    commandBg: "#2e3440",
    commandBorder: "#88c0d0",
  },

  monokai: {
    name: "Monokai",
    description: "Warm, high-contrast classic",
    bg: "#272822",
    panel: "#1e1f1c",
    border: "#49483e",
    borderFocused: "#f92672",
    text: "#f8f8f2",
    textDim: "#75715e",
    textBright: "#ffffff",
    textMuted: "#75715e",
    positive: "#a6e22e",
    negative: "#f92672",
    neutral: "#75715e",
    warning: "#e6db74",
    header: "#49483e",
    headerText: "#e6db74",
    selected: "#49483e",
    selectedText: "#f8f8f2",
    commandBg: "#1e1f1c",
    commandBorder: "#f92672",
  },

  catppuccin: {
    name: "Catppuccin Mocha",
    description: "Soothing pastel theme",
    bg: "#1e1e2e",
    panel: "#181825",
    border: "#45475a",
    borderFocused: "#cba6f7",
    text: "#cdd6f4",
    textDim: "#585b70",
    textBright: "#ffffff",
    textMuted: "#6c7086",
    positive: "#a6e3a1",
    negative: "#f38ba8",
    neutral: "#6c7086",
    warning: "#f9e2af",
    header: "#313244",
    headerText: "#cba6f7",
    selected: "#3e3f56",
    selectedText: "#cdd6f4",
    commandBg: "#181825",
    commandBorder: "#cba6f7",
  },

  gruvbox: {
    name: "Gruvbox Dark",
    description: "Retro earthy tones",
    bg: "#282828",
    panel: "#1d2021",
    border: "#504945",
    borderFocused: "#fe8019",
    text: "#ebdbb2",
    textDim: "#928374",
    textBright: "#fbf1c7",
    textMuted: "#665c54",
    positive: "#b8bb26",
    negative: "#fb4934",
    neutral: "#928374",
    warning: "#fabd2f",
    header: "#3c3836",
    headerText: "#fabd2f",
    selected: "#3c3836",
    selectedText: "#ebdbb2",
    commandBg: "#1d2021",
    commandBorder: "#fe8019",
  },

  rosepine: {
    name: "Rose Pine",
    description: "Muted, elegant dark theme",
    bg: "#191724",
    panel: "#1f1d2e",
    border: "#403d52",
    borderFocused: "#c4a7e7",
    text: "#e0def4",
    textDim: "#6e6a86",
    textBright: "#ffffff",
    textMuted: "#524f67",
    positive: "#31748f",
    negative: "#eb6f92",
    neutral: "#6e6a86",
    warning: "#f6c177",
    header: "#26233a",
    headerText: "#c4a7e7",
    selected: "#332f4a",
    selectedText: "#e0def4",
    commandBg: "#1f1d2e",
    commandBorder: "#c4a7e7",
  },

  midnight: {
    name: "Midnight Blue",
    description: "",
    bg: "#000022",
    panel: "#000033",
    border: "#003366",
    borderFocused: "#ff6600",
    text: "#ccddff",
    textDim: "#6688bb",
    textBright: "#ffffff",
    textMuted: "#445577",
    positive: "#00cc66",
    negative: "#ff3333",
    neutral: "#6688bb",
    warning: "#ff9900",
    header: "#001144",
    headerText: "#ff6600",
    selected: "#002255",
    selectedText: "#ffffff",
    commandBg: "#000033",
    commandBorder: "#ff6600",
  },
};

export const themes: Record<string, Theme> = Object.fromEntries(
  Object.entries(rawThemes).map(([id, theme]) => [id, normalizeTheme(theme)]),
) as Record<string, Theme>;

export const DEFAULT_THEME = "amber";

export function getThemeIds(): string[] {
  return Object.keys(themes);
}

/**
 * A theme is dark when its text sits lighter than its background. That is the
 * definition, and it beats thresholding the background on its own, which
 * mislabels the mid-tone palettes sitting near whatever cutoff you pick.
 */
export function isDarkTheme(themeId: string): boolean {
  const theme = themes[themeId];
  if (!theme) return true;
  return relativeLuminance(theme.text) > relativeLuminance(theme.bg);
}

export function getTheme(id: string): Theme {
  return themes[id] ?? themes[DEFAULT_THEME]!;
}
