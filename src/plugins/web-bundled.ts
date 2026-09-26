/**
 * The plugins the hosted web app compiles into its own build. The web app never
 * installs a plugin ("Where plugins run" in PLUGINS.md explains why), so
 * anything web-capable ships this way, with no install step.
 *
 * Each entry is the package name of a devDependency, pinned by `bun.lock`, so
 * what the web app runs is a reviewed commit rather than whatever the plugin's
 * default branch happened to be at deploy time. Update one with
 * `bun update <package>`, then `bun run web:proxy-hosts` if its hosts changed.
 *
 * A plugin listed here must declare `"web"` in `targets`; the build fails
 * rather than shipping a pane that cannot reach its data. The rest of the
 * catalog stays installable on the desktop and in the terminal as before.
 */
export const WEB_BUNDLED_PLUGIN_PACKAGES = [
  "gloom-fear-greed",
  "gloom-ipo-calendar",
  "gloom-market-halts",
  "gloom-market-heatmap",
  "gloom-polls",
  "gloom-prediction-markets",
] as const;

/**
 * One compiled plugin, as the build hands it to the browser.
 *
 * The identity is repeated here rather than read from the module because it is
 * needed before the module loads, and especially when it fails to: that is the
 * case where the marketplace has to name the plugin that broke.
 */
export interface WebBundledPluginDescriptor {
  id: string;
  name: string;
  version: string;
  /** Origin-relative URL of the compiled ES module. */
  url: string;
}
