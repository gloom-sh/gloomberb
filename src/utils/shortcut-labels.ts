import { detectPlatform, type DesktopPlatform } from "./platform";

export type ShortcutPlatform = DesktopPlatform;
export type ShortcutDisplayMode = "platform" | "terminal";

export function detectShortcutPlatform(): ShortcutPlatform {
  return detectPlatform((globalThis as { process?: { platform?: string } }).process?.platform);
}

function isMacShortcutPlatform(platform: ShortcutPlatform = detectShortcutPlatform()): boolean {
  return platform === "darwin";
}

export function getShortcutDisplayMode(uiKind: "opentui" | "desktop-web" | undefined): ShortcutDisplayMode {
  return uiKind === "opentui" ? "terminal" : "platform";
}

function getPrimaryShortcutModifier(
  platform: ShortcutPlatform = detectShortcutPlatform(),
  mode: ShortcutDisplayMode = "platform",
): "Cmd" | "Ctrl" {
  if (mode === "terminal") return "Ctrl";
  return isMacShortcutPlatform(platform) ? "Cmd" : "Ctrl";
}

export function formatPrimaryShortcut(
  keys: string | readonly string[],
  platform: ShortcutPlatform = detectShortcutPlatform(),
  mode: ShortcutDisplayMode = "platform",
): string {
  const keyParts = typeof keys === "string" ? [keys] : keys;
  return [getPrimaryShortcutModifier(platform, mode), ...keyParts].join("+");
}

export function formatPlatformShortcutLabel(
  label: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
  mode: ShortcutDisplayMode = "platform",
): string {
  const primaryModifier = getPrimaryShortcutModifier(platform, mode);
  return label.replace(/Cmd\/Ctrl|CmdOrCtrl/g, primaryModifier);
}
