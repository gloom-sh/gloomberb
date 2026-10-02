import { PLUGIN_HOST_RESOLVER_IMPORTERS } from "./host-modules";

/**
 * Serves `gloomberb/*` and `react` to external plugins from inside the
 * process when there is no Gloomberb package on disk to symlink.
 *
 * The terminal imports a plugin straight from the plugins folder, and the
 * plugin's `import { Box } from "gloomberb/ui"` has to resolve to the running
 * host. A source install (npm, a checkout) has a package directory, and
 * host-link.ts points `node_modules/gloomberb` at it. The compiled terminal
 * binary from the install script and the packaged desktop app have no such
 * directory: their `import.meta.dir` is Bun's embedded filesystem or a
 * bundle folder with no package.json above it. There, every external plugin
 * failed to load with "Cannot find module 'gloomberb/utils'", which turned
 * the extraction of built-in panes into losing them.
 *
 * A Bun runtime plugin answers those specifiers with the host's own modules,
 * already loaded in this process, so a plugin gets the same React instance
 * and the same stateful `gloomberb/*` modules the app uses. It is installed
 * once and only when the symlink route is unavailable: with a package root,
 * the host's own `react` import resolves by name at runtime, and answering
 * it from a virtual module that itself imports `react` would never settle.
 */

const RESOLVER_NAME = "gloomberb-plugin-host";
const JSX_DEV_RUNTIME = "react/jsx-dev-runtime";
const JSX_RUNTIME = "react/jsx-runtime";

let installed = false;

type JsxFactory = (type: unknown, props: unknown, key?: unknown) => unknown;

/**
 * A packaged host is built with `--production`, so its React is the
 * production build, whose `react/jsx-dev-runtime` exports `jsxDEV` as
 * undefined. A plugin's `.tsx` is transpiled when it is imported, and unless
 * the user's shell says NODE_ENV=production that transform calls `jsxDEV`.
 * The first render then throws "jsxDEV is not a function". Answer it with the
 * production `jsx`, which builds the same elements without the dev checks.
 */
async function jsxDevRuntimeExports(): Promise<Record<string, unknown>> {
  const dev = { ...(await PLUGIN_HOST_RESOLVER_IMPORTERS[JSX_DEV_RUNTIME]!()) } as Record<string, unknown>;
  if (typeof dev.jsxDEV === "function") return dev;
  const prod = (await PLUGIN_HOST_RESOLVER_IMPORTERS[JSX_RUNTIME]!()) as { jsx: JsxFactory };
  return { ...dev, jsxDEV: (type: unknown, props: unknown, key?: unknown) => prod.jsx(type, props, key) };
}

/** True when this process can register runtime resolvers. */
function hasBunRuntimePlugins(): boolean {
  return typeof Bun !== "undefined" && typeof Bun.plugin === "function";
}

/**
 * Registers the resolver. Returns true when plugins in this process resolve
 * host modules through it, false when the caller should fall back to symlinks.
 */
export function installPluginHostResolver(): boolean {
  if (installed) return true;
  if (!hasBunRuntimePlugins()) return false;

  const resolving = new Set<string>();

  Bun.plugin({
    name: RESOLVER_NAME,
    setup(build) {
      for (const [specifier, importer] of Object.entries(PLUGIN_HOST_RESOLVER_IMPORTERS)) {
        build.module(specifier, async () => {
          // A host that still resolves this name from the filesystem would
          // re-enter here and hang; fail loudly instead.
          if (resolving.has(specifier)) {
            throw new Error(`The plugin host resolver was asked for "${specifier}" while loading it.`);
          }
          resolving.add(specifier);
          try {
            // Spread the namespace: `loader: "object"` reads own enumerable
            // properties, and a module namespace's live bindings are exactly
            // that. Values keep their identity, so `React` is the host's.
            const exports = specifier === JSX_DEV_RUNTIME
              ? await jsxDevRuntimeExports()
              : { ...(await importer()) };
            return { exports, loader: "object" };
          } finally {
            resolving.delete(specifier);
          }
        });
      }
    },
  });

  installed = true;
  return true;
}

/**
 * Whether the resolver is serving host modules in this process.
 * @knipignore Imported by the script host-resolver.test.ts compiles and runs.
 */
export function isPluginHostResolverInstalled(): boolean {
  return installed;
}
