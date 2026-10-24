export type AsciiFontName = "tiny" | "wordmark";

type TinyFontChar = readonly [string, string];

const TINY_FONT: Record<string, TinyFontChar> = {
  A: ["▄▀█", "█▀█"],
  B: ["█▄▄", "█▄█"],
  C: ["█▀▀", "█▄▄"],
  D: ["█▀▄", "█▄▀"],
  E: ["█▀▀", "██▄"],
  F: ["█▀▀", "█▀ "],
  G: ["█▀▀", "█▄█"],
  H: ["█ █", "█▀█"],
  I: ["█", "█"],
  J: ["  █", "█▄█"],
  K: ["█▄▀", "█ █"],
  L: ["█  ", "█▄▄"],
  M: ["█▀▄▀█", "█ ▀ █"],
  N: ["█▄ █", "█ ▀█"],
  O: ["█▀█", "█▄█"],
  P: ["█▀█", "█▀▀"],
  Q: ["█▀█", "▀▀█"],
  R: ["█▀█", "█▀▄"],
  S: ["█▀▀", "▄▄█"],
  T: ["▀█▀", " █ "],
  U: ["█ █", "█▄█"],
  V: ["█ █", "▀▄▀"],
  W: ["█ █ █", "▀▄▀▄▀"],
  X: ["▀▄▀", "█ █"],
  Y: ["█▄█", " █ "],
  Z: ["▀█", "█▄"],
  "0": ["▞█▚", "▚█▞"],
  "1": ["▄█", " █"],
  "2": ["▀█", "█▄"],
  "3": ["▀▀█", "▄██"],
  "4": ["█ █", "▀▀█"],
  "5": ["█▀", "▄█"],
  "6": ["█▄▄", "█▄█"],
  "7": ["▀▀█", "  █"],
  "8": ["███", "█▄█"],
  "9": ["█▀█", "▀▀█"],
  "!": ["█", "▄"],
  "?": ["▀█", " ▄"],
  ".": [" ", "▄"],
  "+": ["▄█▄", " ▀ "],
  "-": ["▄▄", "  "],
  _: ["  ", "▄▄"],
  "=": ["▀▀", "▀▀"],
  "@": ["▛█▜", "▙▟▃"],
  "#": ["▟▄▙", "▜▀▛"],
  $: ["▖█▗", "▘█▝"],
  "%": ["▀ ▄▀", "▄▀ ▄"],
  "&": ["▄▄█", "█▄█"],
  "(": ["▄▀", "▀▄"],
  ")": ["▀▄", "▄▀"],
  "/": ["  ▄▀", "▄▀  "],
  ":": ["▀", "▄"],
  ";": ["  ", "▄▀"],
  ",": [" ", "█"],
  "'": ["▀", " "],
  "\"": ["▛ ▜", "   "],
  " ": [" ", " "],
};

const GLOOMBERB_WORDMARK = [
  "▞▀▖▜           ▌        ▌  ",
  "▌▄▖▐ ▞▀▖▞▀▖▛▚▀▖▛▀▖▞▀▖▙▀▖▛▀▖",
  "▌ ▌▐ ▌ ▌▌ ▌▌▐ ▌▌ ▌▛▀ ▌  ▌ ▌",
  "▝▀  ▘▝▀ ▝▀ ▘▝ ▘▀▀ ▝▀▘▘  ▀▀ ",
];

/** The first five letters of the wordmark above. */
const GLOOM_WORDMARK = GLOOMBERB_WORDMARK.map((line) => line.slice(0, 15));

/**
 * The drawn wordmarks, by the text they spell. The app is Gloom; chart
 * screenshots keep the Gloomberb watermark.
 */
const WORDMARKS = new Map<string, string[]>([
  ["gloom", GLOOM_WORDMARK],
  ["gloomberb", GLOOMBERB_WORDMARK],
]);

export function renderAsciiText(text: string, font: AsciiFontName = "tiny"): string[] {
  if (font === "wordmark") {
    return WORDMARKS.get(text.trim().toLowerCase()) ?? [text];
  }

  const lines = ["", ""];
  for (let index = 0; index < text.length; index += 1) {
    const glyph = TINY_FONT[text[index]!.toUpperCase()] ?? TINY_FONT[" "]!;
    const spacer = index < text.length - 1 ? " " : "";
    lines[0] += `${glyph[0]}${spacer}`;
    lines[1] += `${glyph[1]}${spacer}`;
  }
  return lines;
}
