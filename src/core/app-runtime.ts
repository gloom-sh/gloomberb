import { MarketDataCoordinator, getSharedMarketDataCoordinator, setSharedMarketDataCoordinator } from "../market-data/coordinator";
import { NewsService, type NewsServiceOptions } from "../news/aggregator";
import { getSharedNewsService, setSharedNewsService } from "../news/hooks";
import { PluginRegistry } from "../plugins/registry";
import { releaseSharedRegistry } from "../plugins/registry/shared";
import type { GloomPlugin } from "../types/plugin";
import { measurePerfAsync } from "../utils/perf-marks";
import type { AppRuntimeServices, AppServicesFactoryOptions } from "./app-service-ports";

type Dispose = () => void;
type Runtime = AppRuntimeServices & { newsService: NewsService };
type RuntimeModules = Pick<Runtime, "pluginRegistry" | "marketData" | "newsService">;

interface AppRuntimeOptions extends AppServicesFactoryOptions, Pick<Runtime, "persistence" | "tickerRepository" | "dataProvider"> {
  registryOptions?: ConstructorParameters<typeof PluginRegistry>[3];
  newsOptions?: NewsServiceOptions;
  configure?: (modules: RuntimeModules) => void | Dispose;
  onReady?: (modules: RuntimeModules) => void | Dispose;
  onPluginError?: (error: unknown, plugin: GloomPlugin) => void;
}

/** Hosts supply adapters; registration, shared-service ownership and disposal have one lifecycle. */
export function createAppRuntime({
  config, plugins, persistence, tickerRepository, dataProvider,
  registryOptions, newsOptions, configure, onReady, onPluginError,
}: AppRuntimeOptions): Runtime {
  const pluginRegistry = new PluginRegistry(dataProvider, tickerRepository, persistence, registryOptions);
  const marketData = new MarketDataCoordinator(dataProvider);
  const newsService = new NewsService({
    connectionHealth: pluginRegistry.connectionHealth,
    pollIntervalMs: () => Math.max(1, config.refreshIntervalMinutes) * 60_000,
    ...newsOptions,
  });
  const modules = { pluginRegistry, marketData, newsService };
  pluginRegistry.getConfigFn = () => config;
  pluginRegistry.getLayoutFn = () => config.layout;
  pluginRegistry.registerNewsCapabilityFn = registryOptions?.enableCapabilityHandlers === false
    ? () => () => {}
    : (capability) => newsService.register(capability);
  pluginRegistry.watchNewsQueryFn = (query, listener) => newsService.watchQuery(query, listener);
  setSharedMarketDataCoordinator(marketData);
  setSharedNewsService(newsService);

  let destroyed = false;
  let registering = false;
  let disposeConfigured: void | Dispose;
  let disposeReady: void | Dispose;
  const dispose = (...callbacks: Array<void | Dispose>) => {
    const errors: unknown[] = [];
    for (const callback of callbacks) {
      try { callback?.(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "App runtime teardown failed");
  };
  const disposePlugins = () => dispose(() => pluginRegistry.destroy(), disposeConfigured, () => persistence.close());
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (getSharedMarketDataCoordinator() === marketData) setSharedMarketDataCoordinator(null);
    if (getSharedNewsService() === newsService) setSharedNewsService(null);
    dispose(
      disposeReady, () => newsService.stop(), () => marketData.destroy(),
      // An async setup may still use persistence or contribute panes. Dispose it
      // after setup settles, so it cannot write into a closed store or leak late contributions.
      registering ? undefined : disposePlugins,
      () => releaseSharedRegistry(pluginRegistry, dataProvider),
    );
  };

  try {
    disposeConfigured = configure?.(modules);
    newsService.start();
  } catch (error) {
    try { destroy(); } catch { /* Preserve the startup failure. */ }
    throw error;
  }
  registering = true;
  const ready = Promise.allSettled(plugins.map((plugin) => (
    measurePerfAsync("startup.services.register-plugin", () => pluginRegistry.register(plugin), { pluginId: plugin.id })
      .catch((error) => { if (onPluginError) onPluginError(error, plugin); else throw error; })
  ))).then((results) => {
    registering = false;
    if (destroyed) {
      disposePlugins();
      return;
    }
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const cleanup = onReady?.(modules);
    if (destroyed) cleanup?.();
    else disposeReady = cleanup;
  }).catch((error) => {
    try { destroy(); } catch { /* Preserve the startup failure. */ }
    throw error;
  });
  return { persistence, tickerRepository, dataProvider, ...modules, ready, destroy };
}
