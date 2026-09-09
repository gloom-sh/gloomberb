import type { PluginTarget } from "../types/plugin";

/**
 * Which renderer is running.
 *
 * Renderers declare this at startup rather than having it sniffed from globals:
 * the Electrobun view and the hosted browser app are both browser contexts and
 * are otherwise hard to tell apart, yet they differ in what a plugin can do
 * (the desktop app can shell out to git; term.gloom.sh cannot).
 */
let currentTarget: PluginTarget = "cli";

export function setCurrentPluginTarget(target: PluginTarget): void {
  currentTarget = target;
}

export function getCurrentPluginTarget(): PluginTarget {
  return currentTarget;
}

/**
 * Whether this renderer can install plugins itself. Installing means cloning a
 * repository and running `bun install`, so only the Bun-hosted renderers can;
 * elsewhere the marketplace shows the command to run instead.
 */
export function canInstallPlugins(): boolean {
  return currentTarget === "cli" || currentTarget === "tui";
}

/**
 * Whether this renderer runs plugins from outside the build at all.
 *
 * term.gloom.sh ships only the curated built-ins in `catalog-browser.ts`.
 * Third-party code there would run on the origin that holds the session, so
 * it is a product decision, not a missing feature: plugins live in the desktop
 * app and the terminal. The marketplace still lists them on the web so it
 * works as a storefront, but it says where they run instead of how to install.
 */
export function runsExternalPlugins(target: PluginTarget = currentTarget): boolean {
  return target !== "web";
}
