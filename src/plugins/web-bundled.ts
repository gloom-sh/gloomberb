/**
 * The plugins the hosted web app compiles into its own build.
 *
 * term.gloom.sh cannot clone a repository or run `bun install`, and it will not
 * evaluate code a visitor points it at: a plugin is a React component sharing
 * the host's module registry on the origin that holds the session, so there is
 * nothing to sandbox it with. That rules out installing plugins on the web, not
 * shipping them. Anything web-capable is compiled into the build instead, so a
 * visitor gets it with no install step, no marketplace trip, and no account.
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
