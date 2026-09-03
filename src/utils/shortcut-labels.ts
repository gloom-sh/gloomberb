export type ShortcutPlatform = "darwin" | "win32" | "linux" | "unknown";
export type ShortcutDisplayMode = "platform" | "terminal";

function platformFromProcess(): ShortcutPlatform | null {
  const platform = (globalThis as { process?: { platform?: string } }).process?.platform;
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  return null;
}

function platformFromNavigator(): ShortcutPlatform | null {
  const navigatorLike = (globalThis as {
    navigator?: {
      platform?: string;
      userAgent?: string;
      userAgentData?: { platform?: string };
    };
  }).navigator;
  const raw = [
    navigatorLike?.userAgentData?.platform,
    navigatorLike?.platform,
    navigatorLike?.userAgent,
  ].filter(Boolean).join(" ").toLowerCase();

  if (!raw) return null;
  if (/(mac|iphone|ipad|ipod)/.test(raw)) return "darwin";
  if (/win/.test(raw)) return "win32";
  if (/(linux|x11)/.test(raw)) return "linux";
  return null;
}

export function detectShortcutPlatform(): ShortcutPlatform {
  return platformFromProcess() ?? platformFromNavigator() ?? "unknown";
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

/**
 * The single binding a host advertises for the command bar. Ctrl+P is the
 * terminal's canonical binding; desktop hosts show the platform modifier with
 * K, which the global shortcut accepts everywhere. Every surface that names the
 * binding goes through here, so the header prompt and the empty-state hint can
 * never quote two different keys at the same user.
 */
export function formatCommandBarShortcut(
  mode: ShortcutDisplayMode = "platform",
  platform: ShortcutPlatform = detectShortcutPlatform(),
): string {
  return mode === "terminal" ? "Ctrl+P" : formatPrimaryShortcut("K", platform, "platform");
}

export function formatPlatformShortcutLabel(
  label: string,
  platform: ShortcutPlatform = detectShortcutPlatform(),
  mode: ShortcutDisplayMode = "platform",
): string {
  const primaryModifier = getPrimaryShortcutModifier(platform, mode);
  return label.replace(/Cmd\/Ctrl|CmdOrCtrl/g, primaryModifier);
}
