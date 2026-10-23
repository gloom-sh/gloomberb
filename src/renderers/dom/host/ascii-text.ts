import { renderAsciiText, type AsciiFontName } from "../../../ui/ascii-font";
import { detectPlatform } from "../../../utils/platform";

const WEB_GLOOMBERB_WORDMARK = [
  "  ____ _                       _               _     ",
  " / ___| | ___   ___  _ __ ___ | |__   ___ _ __| |__  ",
  "| |  _| |/ _ \\ / _ \\| '_ ` _ \\| '_ \\ / _ \\ '__| '_ \\ ",
  "| |_| | | (_) | (_) | | | | | | |_) |  __/ |  | |_) |",
  " \\____|_|\\___/ \\___/|_| |_| |_|_.__/ \\___|_|  |_.__/ ",
];

const WEB_GLOOM_WORDMARK = [
  "  ____ _                       ",
  " / ___| | ___   ___  _ __ ___  ",
  "| |  _| |/ _ \\ / _ \\| '_ ` _ \\ ",
  "| |_| | | (_) | (_) | | | | | |",
  " \\____|_|\\___/ \\___/|_| |_| |_|",
];

/** The web wordmarks, by the text they spell. */
const WEB_WORDMARKS = new Map<string, string[]>([
  ["gloom", WEB_GLOOM_WORDMARK],
  ["gloomberb", WEB_GLOOMBERB_WORDMARK],
]);

type WebWordmarkVariant = "legacy" | "compat" | null;

/**
 * The DOM host is shared by Electrobun, which passes a real `process.platform`,
 * and the browser build, which passes the sentinel `"browser"` because a web
 * page has no OS of its own. `detectPlatform` trusts only the former and
 * sniffs the navigator for the latter.
 */
export function webAsciiTextWordmarkVariant(
  text: string,
  font: AsciiFontName = "tiny",
  desktopPlatform?: string,
): WebWordmarkVariant {
  if (font !== "wordmark" || !WEB_WORDMARKS.has(text.trim().toLowerCase())) return null;
  return detectPlatform(desktopPlatform) === "darwin" ? "legacy" : "compat";
}

export function webAsciiTextLines(
  text: string,
  font: AsciiFontName = "tiny",
  desktopPlatform?: string,
): string[] {
  return webAsciiTextWordmarkVariant(text, font, desktopPlatform) === "compat"
    ? WEB_WORDMARKS.get(text.trim().toLowerCase())!
    : renderAsciiText(text, font);
}
