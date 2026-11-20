import { logFailure } from "../utils/log-failure";
import { chartSeriesResolveRequestSchema, uncoveredCapabilityMessage } from "../capabilities/chart-series";
import type { CapabilityInvoker } from "../capabilities/types";
import type { GloomPlugin } from "../types/plugin";
import { resolveRegisteredSeries } from "./capability";
import { readSeriesFolder } from "./files";
import { SeriesRegistry, seriesExpression, seriesNamedBy } from "./registry";
import type { SeriesDefinition } from "./types";

/** The plugins a series lookup reads: a list, or a function that gives it once a series is first asked for. */
export type SeriesPlugins = readonly GloomPlugin[] | (() => readonly GloomPlugin[]);

export const pluginsOf = (plugins: SeriesPlugins): readonly GloomPlugin[] => typeof plugins === "function" ? plugins() : plugins;

/**
 * Charts the catalog's loaded series where no plugin runtime runs, such as a
 * `gloom fn G` report: the series plugins declare, and the files in the
 * data directory's series folder. Series a plugin registers from its setup
 * need the app.
 */
export function standaloneSeriesInvoker(
  plugins: SeriesPlugins,
  dataDir: string,
  disabledPlugins: readonly string[] = [],
): CapabilityInvoker {
  let registry: Promise<SeriesRegistry> | null = null;
  const build = async () => {
    const all = pluginsOf(plugins);
    const built = new SeriesRegistry({ pluginHosts: (pluginId) => all.find((plugin) => plugin.id === pluginId)?.hosts });
    const register = (pluginId: string, definitions: readonly Parameters<SeriesRegistry["register"]>[1][]) => {
      for (const definition of definitions) {
        try {
          built.register(pluginId, definition);
        } catch (error) {
          logFailure("series.standalone", "Registering a standalone series failed")(error);
        }
      }
    };
    for (const plugin of all) {
      if (!disabledPlugins.includes(plugin.id)) register(plugin.id, plugin.series ?? []);
    }
    register("user", await readSeriesFolder(dataDir));
    return built;
  };
  return {
    capabilityManifests: () => [],
    async invokeCapability<T>(capabilityId: string, operationId: string, payload: unknown, options?: { signal?: AbortSignal }) {
      if (operationId !== "resolve") throw new Error(`Capability "${capabilityId}" is not available.`);
      registry ??= build();
      const request = chartSeriesResolveRequestSchema.parse(payload);
      const resolved = await resolveRegisteredSeries(await registry, capabilityId, request, options?.signal);
      if (!resolved) throw new Error(uncoveredCapabilityMessage(capabilityId, request.seriesId));
      return resolved as T;
    },
  };
}

/**
 * The plugins' catalog series by what `fn G` charts each as (`FRED:DFII10`),
 * where no plugin runtime runs: a series with an input (a ticker's field) is
 * no one expression. The first plugin to declare an expression keeps it, as
 * the registry's `findByExpression` does.
 */
export function standaloneSeriesCatalog(
  plugins: SeriesPlugins,
  disabledPlugins: readonly string[] = [],
): (expression: string) => SeriesDefinition | undefined {
  let byExpression: Map<string, SeriesDefinition> | null = null;
  return (expression) => {
    if (!byExpression) {
      byExpression = new Map();
      for (const plugin of pluginsOf(plugins)) {
        if (disabledPlugins.includes(plugin.id)) continue;
        for (const definition of plugin.series ?? []) {
          if (definition.input) continue;
          const key = seriesExpression(definition);
          if (!byExpression.has(key)) byExpression.set(key, definition);
        }
      }
    }
    return byExpression.get(expression);
  };
}

/** The catalog series a bare word is an alias of (`hashrate`), where no plugin runtime runs; see `seriesNamedBy`. */
export function standaloneSeriesNamed(
  plugins: SeriesPlugins,
  disabledPlugins: readonly string[] = [],
): (word: string) => SeriesDefinition | undefined {
  const definitions = () => pluginsOf(plugins).filter((plugin) => !disabledPlugins.includes(plugin.id)).flatMap((plugin) => plugin.series ?? []);
  return (word) => seriesNamedBy(definitions(), word);
}
