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
 * The bundle identifier. Electrobun names the app's data and update folders
 * after it (and on Windows the folder the app itself is updated in), and
 * macOS ties the app's WebKit storage and notification permission to it.
 */
export const DESKTOP_APP_IDENTIFIER = "sh.gloom.desktop";

/**
 * The identifier before that one, kept through the rename to Gloom. An
 * install from then has its folders under it until this build moves them,
 * at its first start (bun/desktop/app-identifier.ts).
 */
export const LEGACY_DESKTOP_APP_IDENTIFIER = "com.vincelwt.gloomberb";

/**
 * Both identifiers. A copy of the app on disk (an app bundle, an install the
 * script or Homebrew replaces) can carry either until every install has
 * moved, so anything that asks whether a copy is this app accepts both.
 */
export const DESKTOP_APP_IDENTIFIERS: readonly string[] = [DESKTOP_APP_IDENTIFIER, LEGACY_DESKTOP_APP_IDENTIFIER];

/** Whether `identifier` is one a build of this app carries. */
export function isDesktopAppIdentifier(identifier: string | null | undefined): boolean {
  return !!identifier && DESKTOP_APP_IDENTIFIERS.includes(identifier);
}
