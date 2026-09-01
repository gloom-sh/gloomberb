/**
 * The contract shared between the plugin bundler and the renderers that load
 * its output.
 *
 * Kept in its own module with no imports on purpose. The bundler runs in Bun
 * and reaches the filesystem; the renderers that consume it are browser
 * contexts. Pulling these two constants from `bundle.ts` dragged the whole
 * bundler — and through it `plugins/loader.ts`, which reads `process.env.HOME`
 * at module scope — into the desktop view, where it threw on load.
 */

export const PLUGIN_HOST_GLOBAL = "__GLOOM_PLUGIN_HOST__";

/**
 * Specifiers a plugin may import that must resolve to the host's copy. Anything
 * else is a plugin's own dependency and gets bundled normally.
 *
 * Deliberately no `react-dom`: it is a renderer package, and plugins are
 * required to be renderer-neutral so the same code runs in the terminal. A
 * plugin reaching for it should fail to bundle rather than quietly work on the
 * desktop and break in the TUI.
 */
export const SHARED_SPECIFIERS = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "gloomberb/types/plugin",
  "gloomberb/types/persistence",
  "gloomberb/ui",
  "gloomberb/components",
  "gloomberb/theme",
  "gloomberb/capabilities",
  "gloomberb/utils",
  "gloomberb/react",
] as const;

export type SharedSpecifier = (typeof SHARED_SPECIFIERS)[number];
