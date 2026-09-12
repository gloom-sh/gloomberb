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
 * Whether this renderer loads plugins that are not part of its build.
 *
 * term.gloom.sh does not. It ships the built-ins in `catalog-browser.ts` plus
 * the web-capable plugins compiled into the build (`plugins/web-bundled.ts`),
 * and nothing else: a plugin is a React component sharing the host's module
 * registry on the origin that holds the user's session, so there is nothing to
 * sandbox code a visitor chose with. That is a product decision, not a missing
 * feature: installing plugins belongs to the desktop app and the terminal,
 * which run on the user's own machine. The marketplace still lists every plugin
 * on the web so it works as a storefront, saying where each one runs instead of
 * how to install it.
 */
export function runsExternalPlugins(target: PluginTarget = currentTarget): boolean {
  return target !== "web";
}
