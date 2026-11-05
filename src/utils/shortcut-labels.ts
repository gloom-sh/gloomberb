import { detectPlatform, type DesktopPlatform } from "./platform";

export type ShortcutPlatform = DesktopPlatform;
export type ShortcutDisplayMode = "platform" | "terminal";

export function detectShortcutPlatform(): ShortcutPlatform {
  return detectPlatform((globalThis as { process?: { platform?: string } }).process?.platform);
}

/**
 * The terminal names keys the way a terminal delivers them, Control included on
 * a Mac; the desktop app and the web follow the platform. Labels themselves are
 * written by src/app/keybindings/labels.ts (formatChordForHost,
 * formatShortcutForHost).
 */
export function getShortcutDisplayMode(uiKind: "opentui" | "desktop-web" | undefined): ShortcutDisplayMode {
  return uiKind === "opentui" ? "terminal" : "platform";
}
