import { SHARED_SPECIFIERS, type SharedSpecifier } from "./host-contract";

type HostModuleImporter = () => Promise<object>;

/**
 * The host's canonical implementation for every public shared-module
 * specifier. Resolve Gloomberb's own modules relative to this file: a
 * Bun-compiled host has no filesystem package root from which
 * `import("gloomberb/ui")` can be resolved.
 */
const HOST_MODULE_IMPORTERS = {
  "react": () => import("react"),
  "react/jsx-runtime": () => import("react/jsx-runtime"),
  "react/jsx-dev-runtime": () => import("react/jsx-dev-runtime"),
  "gloomberb/types/plugin": () => import("../types/plugin"),
  "gloomberb/types/persistence": () => import("../types/persistence"),
  "gloomberb/ui": () => import("../ui"),
  "gloomberb/components": () => import("../components"),
  "gloomberb/theme": () => import("../theme/colors"),
  "gloomberb/capabilities": () => import("../capabilities"),
  "gloomberb/utils": () => import("../public/utils"),
  "gloomberb/react": () => import("../public/react"),
  "gloomberb/broker": () => import("../public/broker"),
  "gloomberb/dialog": () => import("../ui/dialog"),
  "gloomberb/market-data": () => import("../public/market-data"),
  "gloomberb/time-series": () => import("../public/time-series"),
  "gloomberb/layout": () => import("../public/layout"),
  "gloomberb/quotes": () => import("../public/quotes"),
} satisfies Record<SharedSpecifier, HostModuleImporter>;

/** Import one host module without depending on bare Gloomberb package resolution. */
export async function importPluginHostModule(specifier: string): Promise<object> {
  if (!(SHARED_SPECIFIERS as readonly string[]).includes(specifier)) {
    throw new Error(`Unknown plugin host module: ${specifier}`);
  }
  return HOST_MODULE_IMPORTERS[specifier as SharedSpecifier]();
}

/** Import the complete registry from the same map used by the bundler. */
export async function importAllPluginHostModules(): Promise<Readonly<Record<SharedSpecifier, object>>> {
  const entries = await Promise.all(
    SHARED_SPECIFIERS.map(async (specifier) => [specifier, await importPluginHostModule(specifier)] as const),
  );
  return Object.fromEntries(entries) as Record<SharedSpecifier, object>;
}
