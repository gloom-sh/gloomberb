export type DesktopPlatform = "darwin" | "win32" | "linux" | "unknown";

type NavigatorLike = {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
};

// "darwin" contains "win", so macOS is matched first.
function classifyPlatform(raw: string | undefined): Exclude<DesktopPlatform, "unknown"> | null {
  if (!raw) return null;
  if (/(darwin|mac|iphone|ipad|ipod)/i.test(raw)) return "darwin";
  if (/win/i.test(raw)) return "win32";
  if (/(linux|x11|android|\bcros\b|bsd|\baix\b|sunos)/i.test(raw)) return "linux";
  return null;
}

function navigatorPlatform(): string {
  const navigatorLike = (globalThis as { navigator?: NavigatorLike }).navigator;
  return [
    navigatorLike?.userAgentData?.platform,
    navigatorLike?.platform,
    navigatorLike?.userAgent,
  ].filter(Boolean).join(" ");
}

/**
 * The OS the UI runs on. A `hint` that names an OS, such as the desktop host's
 * `process.platform`, wins. Anything else, including the web build's
 * `"browser"` sentinel, falls back to sniffing the navigator.
 */
export function detectPlatform(hint?: string): DesktopPlatform {
  return classifyPlatform(hint?.trim()) ?? classifyPlatform(navigatorPlatform()) ?? "unknown";
}
