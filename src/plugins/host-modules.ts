/**
 * The host modules external plugins may import, and how the host serves them.
 *
 * One table for the plugin bundler (`bundle.ts`), the in-process resolver
 * (`host-resolver.ts`) and the browser renderers that publish the registry a
 * compiled plugin reads. Only dynamic imports on purpose: the bundler runs in
 * Bun and reaches the filesystem, while the renderers here are browser
 * contexts. Taking these from `bundle.ts` once dragged the whole bundler, and
 * through it `plugins/loader.ts`, which reads `process.env.HOME` at module
 * scope, into the desktop view, where it threw on load.
 */

export const PLUGIN_HOST_GLOBAL = "__GLOOM_PLUGIN_HOST__";

type HostModuleImporter = () => Promise<object>;

interface HostModule {
  load: HostModuleImporter;
  /**
   * Served to plugins running in the host's own Bun process, but never to a
   * browser renderer, so a renderer bundle that imports it fails to compile.
   */
  native?: true;
}

/**
 * Every specifier a plugin may import that must resolve to the host's copy.
 * Anything else is a plugin's own dependency and gets bundled normally.
 *
 * Each loads Gloomberb's own module relative to this file: a Bun-compiled host
 * has no filesystem package root from which `import("gloomberb/ui")` could be
 * resolved.
 *
 * Deliberately no `react-dom`: it is a renderer package, and plugins are
 * required to be renderer-neutral so the same code runs in the terminal. A
 * plugin reaching for it should fail to bundle rather than quietly work on the
 * desktop and break in the TUI.
 */
const HOST_MODULES: Readonly<Record<string, HostModule>> = {
  "react": { load: () => import("react") },
  "react/jsx-runtime": { load: () => import("react/jsx-runtime") },
  "react/jsx-dev-runtime": { load: () => import("react/jsx-dev-runtime") },
  "gloomberb/types/plugin": { load: () => import("../types/plugin") },
  "gloomberb/types/persistence": { load: () => import("../types/persistence") },
  // Type modules also export runtime values (`TICKER_RESEARCH_PANE_ID`,
  // `resolvePaneInstance`, `DEFAULT_COLUMNS`) that plugins reach for. A bundled
  // copy would be harmless, but the compiled terminal binary and the packaged
  // desktop app have no host package on disk to bundle it from, so the host
  // serves these the same way it serves everything else.
  "gloomberb/types/broker": { load: () => import("../types/broker") },
  "gloomberb/types/config": { load: () => import("../types/config") },
  "gloomberb/types/data-provider": { load: () => import("../types/data-provider") },
  "gloomberb/types/financials": { load: () => import("../types/financials") },
  "gloomberb/types/instrument": { load: () => import("../types/instrument") },
  "gloomberb/types/ticker": { load: () => import("../types/ticker") },
  "gloomberb/types/trading": { load: () => import("../types/trading") },
  "gloomberb/ui": { load: () => import("../ui") },
  "gloomberb/components": { load: () => import("../components") },
  "gloomberb/theme": { load: () => import("../theme/colors") },
  "gloomberb/capabilities": { load: () => import("../capabilities") },
  "gloomberb/utils": { load: () => import("../public/utils") },
  "gloomberb/react": { load: () => import("../public/react") },
  // Modules below hold state or reach the host's services, so a bundled copy
  // is worse than a missing one. `gloomberb/broker` is the clearest case: it
  // owns the remote broker client the desktop view sets at startup, and a
  // plugin carrying its own copy reads an empty one and reports that the
  // broker host is unavailable.
  "gloomberb/broker": { load: () => import("../public/broker") },
  "gloomberb/dialog": { load: () => import("../ui/dialog") },
  "gloomberb/market-data": { load: () => import("../public/market-data") },
  "gloomberb/time-series": { load: () => import("../public/time-series") },
  // Layout placement reads and rewrites the app's own layout rules; a bundled
  // copy would drag the whole pane manager into every plugin that has a launch
  // command, and diverge from the host the next time those rules change.
  "gloomberb/layout": { load: () => import("../public/layout") },
  // Quote subscriptions live in host state; a bundled copy would open its own
  // feed and never see the host's updates.
  "gloomberb/quotes": { load: () => import("../public/quotes") },
  // The ticker repository and the event bus behind it belong to the running
  // app: a plugin writing into its own copy would save tickers nothing else
  // can see.
  "gloomberb/tickers": { load: () => import("../public/tickers") },
  // The selected language is host state, and a bundled copy of the tables
  // would answer in English no matter what the user picked.
  "gloomberb/i18n": { load: () => import("../public/i18n") },
  // Reads the data directory, so only the Bun process serves it.
  "gloomberb/remote": { load: () => import("../public/remote"), native: true },
};

/** The specifiers a compiled plugin reads from the host registry instead of bundling. */
export const SHARED_SPECIFIERS: readonly string[] = Object.keys(HOST_MODULES)
  .filter((specifier) => !HOST_MODULES[specifier]!.native);

/**
 * Every specifier the Bun process can hand a plugin directly, shared and
 * native alike. This is what the runtime resolver publishes when the host has
 * no package directory for a symlink to point at.
 */
export const PLUGIN_HOST_RESOLVER_IMPORTERS: Readonly<Record<string, HostModuleImporter>> = Object.fromEntries(
  Object.entries(HOST_MODULES).map(([specifier, hostModule]) => [specifier, hostModule.load]),
);

/** Import one shared host module without depending on bare Gloomberb package resolution. */
export async function importPluginHostModule(specifier: string): Promise<object> {
  const hostModule = HOST_MODULES[specifier];
  if (!hostModule || hostModule.native) throw new Error(`Unknown plugin host module: ${specifier}`);
  return hostModule.load();
}

/**
 * Import the complete registry from the same table the bundler uses.
 * @knipignore Also imported by the script host-modules.test.ts compiles and runs.
 */
export async function importAllPluginHostModules(): Promise<Readonly<Record<string, object>>> {
  const entries = await Promise.all(
    SHARED_SPECIFIERS.map(async (specifier) => [specifier, await importPluginHostModule(specifier)] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * Publishes the host's shared modules for compiled plugin bundles to read.
 *
 * Browser-context renderers load plugins as separate ES modules, so the bundler
 * rewrites their `react` and `gloomberb/*` imports to read from this registry
 * (see `bundle.ts`). This must run before any plugin bundle is imported, and
 * the modules here must be the same instances the app itself uses. Importing
 * them normally is what guarantees that.
 */
export async function installPluginHostModules(): Promise<void> {
  const globals = globalThis as Record<string, unknown>;
  if (globals[PLUGIN_HOST_GLOBAL]) return;

  const registry = await importAllPluginHostModules();

  for (const specifier of SHARED_SPECIFIERS) {
    if (!registry[specifier]) throw new Error(`Plugin host registry is missing "${specifier}"`);
  }

  globals[PLUGIN_HOST_GLOBAL] = registry;
}
