/**
 * The desktop app is Gloom. Builds up to 0.18.4 were named Gloomberb, and an
 * install from then still is: `Gloomberb.app` on a Mac, a `Gloomberb` folder
 * inside the Windows update archive, and an updater that asks the release for
 * `<channel>-<os>-<arch>-Gloomberb.*` files. The release keeps publishing
 * those under the old name (scripts/write-legacy-desktop-files.ts), and a Mac
 * bundle still named Gloomberb.app renames itself (bun/desktop/app-name.ts).
 */
export const DESKTOP_APP_NAME = "Gloom";
export const LEGACY_DESKTOP_APP_NAME = "Gloomberb";

/**
 * Kept through the rename. Electrobun names the app's data and update folders
 * after it, and macOS ties the app's settings, WebKit storage and permissions
 * to it.
 */
export const DESKTOP_APP_IDENTIFIER = "com.vincelwt.gloomberb";

/**
 * The identifiers a build of this app carries: the one above, and the one a
 * later release moves to. Until every install has moved, either one can be
 * on disk (an app bundle, an install the script or Homebrew replaces), so
 * anything that asks whether a copy is this app accepts both.
 */
export const DESKTOP_APP_IDENTIFIERS: readonly string[] = [DESKTOP_APP_IDENTIFIER, "sh.gloom.desktop"];

/** Whether `identifier` is one a build of this app carries. */
export function isDesktopAppIdentifier(identifier: string | null | undefined): boolean {
  return !!identifier && DESKTOP_APP_IDENTIFIERS.includes(identifier);
}
