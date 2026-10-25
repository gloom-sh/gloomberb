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
