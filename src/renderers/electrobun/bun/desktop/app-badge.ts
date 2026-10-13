import { setMacosDockBadge } from "./macos-dock-badge";

/** A count from 1 to 99, or `99+`: the only labels a badge can carry. */
const BADGE_LABEL = /^(?:[1-9]\d?|99\+)$/;

type NativeBadgeSetter = (label: string) => void;

/**
 * How each platform shows the app badge. Electrobun has no badge call on any
 * of them (blackboardsh/electrobun#392), so macOS goes through AppKit in
 * `macos-dock-badge.ts`.
 *
 * Windows is the seam still open: a taskbar overlay is
 * `ITaskbarList3::SetOverlayIcon` on the main window's handle (`withWindowHandle`
 * in `window/windows-native.ts` finds it) with an icon drawn from the label.
 * Add a `win32` entry here when that exists. Linux has no common badge.
 */
const NATIVE_BADGE_SETTERS: Partial<Record<NodeJS.Platform, NativeBadgeSetter>> = {
  darwin: setMacosDockBadge,
};

/**
 * The label the badge may show. The view sends only a count, and anything else
 * clears the badge, so message text can never reach the Dock or the taskbar.
 */
function normalizeAppBadgeLabel(value: unknown): string {
  return typeof value === "string" && BADGE_LABEL.test(value) ? value : "";
}

/** Shows `label` as the app's badge on this platform; an empty label clears it. */
export function setAppBadge(
  label: string,
  platform: NodeJS.Platform = process.platform,
  setters: Partial<Record<NodeJS.Platform, NativeBadgeSetter>> = NATIVE_BADGE_SETTERS,
): void {
  setters[platform]?.(normalizeAppBadgeLabel(label));
}
