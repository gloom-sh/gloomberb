import { renderAsciiText, type AsciiFontName } from "../../../../ui/ascii-font";

const WEB_GLOOMBERB_WORDMARK = [
  "  ____ _                       _               _     ",
  " / ___| | ___   ___  _ __ ___ | |__   ___ _ __| |__  ",
  "| |  _| |/ _ \\ / _ \\| '_ ` _ \\| '_ \\ / _ \\ '__| '_ \\ ",
  "| |_| | | (_) | (_) | | | | | | |_) |  __/ |  | |_) |",
  " \\____|_|\\___/ \\___/|_| |_| |_|_.__/ \\___|_|  |_.__/ ",
];

type WebWordmarkVariant = "legacy" | "compat" | null;

function currentDesktopPlatform(): string {
  const navigatorLike = (globalThis as {
    navigator?: {
      platform?: string;
      userAgent?: string;
      userAgentData?: { platform?: string };
    };
  }).navigator;
  return [
    navigatorLike?.userAgentData?.platform,
    navigatorLike?.platform,
    navigatorLike?.userAgent,
  ].filter(Boolean).join(" ");
}

/**
 * A platform string worth trusting. The DOM host is shared by Electrobun, which
 * passes a real `process.platform`, and the browser build, which passes the
 * sentinel `"browser"` because a web page has no OS of its own. Only the former
 * answers the question we are asking, so anything that does not name an OS
 * falls through to sniffing the navigator.
 */
const OS_PLATFORM = /(darwin|mac|iphone|ipad|ipod|win|linux|android|freebsd|openbsd|netbsd|aix|sunos|cros|x11)/i;

function isMacDesktopPlatform(desktopPlatform?: string): boolean {
  const hint = desktopPlatform?.trim();
  const raw = hint && OS_PLATFORM.test(hint) ? hint : currentDesktopPlatform();
  return /(darwin|mac|iphone|ipad|ipod)/i.test(raw);
}

export function webAsciiTextWordmarkVariant(
  text: string,
  font: AsciiFontName = "tiny",
  desktopPlatform?: string,
): WebWordmarkVariant {
  if (font !== "wordmark" || text.trim().toLowerCase() !== "gloomberb") return null;
  return isMacDesktopPlatform(desktopPlatform) ? "legacy" : "compat";
}

export function webAsciiTextLines(
  text: string,
  font: AsciiFontName = "tiny",
  desktopPlatform?: string,
): string[] {
  return webAsciiTextWordmarkVariant(text, font, desktopPlatform) === "compat"
    ? WEB_GLOOMBERB_WORDMARK
    : renderAsciiText(text, font);
}
