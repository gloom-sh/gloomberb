import { join } from "path";
import { existsSync } from "fs";
import { getDataDir, loadConfig } from "../data/config/store";
import { AppPersistence } from "../data/app-persistence";
import { TickerRepository } from "../data/ticker-repository";
import { AssetDataRouter } from "../sources/provider-router";
import { createAppServices } from "../core/app-services";
import type { PluginCapability } from "../capabilities";
import type { AppConfig } from "../types/config";
import type { GloomPlugin } from "../types/plugin";
import { getLoadablePlugins } from "../plugins/catalog";
import type { PluginRegistry } from "../plugins/registry";
import type { LoadedExternalPlugin } from "../plugins/loader";
import { fail } from "./errors";
import type { ConfigContext, MarketContext } from "./types";

export { withCliServices, withConfigData, withMarketData } from "./scoped-context";

interface CliContextOptions {
  plugins?: GloomPlugin[];
}

interface CliServicesOptions {
  externalPlugins?: LoadedExternalPlugin[];
}

export async function ensureCliServicesReady<T extends { ready: Promise<unknown>; destroy(): void }>(
  services: T,
): Promise<T> {
  try {
    await services.ready;
    return services;
  } catch (error) {
    services.destroy();
    throw error;
  }
}

function resolveCliCapabilities(config: AppConfig, plugins: GloomPlugin[]): PluginCapability[] {
  const disabledPlugins = new Set(config.disabledPlugins ?? []);
  const disabledSources = new Set(config.disabledSources ?? []);
  return plugins
    .filter((plugin) => !disabledPlugins.has(plugin.id))
    .flatMap((plugin) => (
      (plugin.capabilities ?? [])
        .filter((capability) => {
          if (capability.kind !== "asset-data" && capability.kind !== "news") return false;
          const sourceId = capability.sourceId ?? capability.id;
          return !disabledSources.has(sourceId);
        })
    ));
}

export async function loadCliConfigIfAvailable(): Promise<AppConfig | null> {
  const dataDir = await getDataDir();
  if (!dataDir || !existsSync(dataDir)) {
    return null;
  }
  return loadConfig(dataDir);
}

export async function initConfigData(): Promise<ConfigContext> {
  const dataDir = await getDataDir();
  if (!dataDir || !existsSync(dataDir)) {
    fail("No data directory configured.", "Run gloomberb once to initialize your local data.");
  }

  const config = await loadConfig(dataDir);
  const persistence = new AppPersistence(join(dataDir, ".gloomberb-cache.db"));
  const store = new TickerRepository(persistence.tickers);
  return { config, persistence, store, dataDir };
}

export async function initMarketData(options: CliContextOptions = {}): Promise<MarketContext> {
  const context = await initConfigData();
  const plugins = options.plugins ?? getLoadablePlugins();
  const capabilities = resolveCliCapabilities(context.config, plugins);
  const dataProvider = new AssetDataRouter(null, [], context.persistence.resources);
  const registryAdapter: Pick<PluginRegistry, "brokers" | "getEnabledCapabilities"> = {
    brokers: new Map(),
    getEnabledCapabilities: (kind?: string) => capabilities.filter((capability) => !kind || capability.kind === kind),
  };
  dataProvider.attachRegistry(registryAdapter as PluginRegistry);
  dataProvider.setConfigAccessor(() => context.config);
  return { ...context, dataProvider };
}

export async function initCliServices(options: CliServicesOptions = {}) {
  const dataDir = await getDataDir();
  if (!dataDir || !existsSync(dataDir)) {
    fail("No data directory configured.", "Run gloomberb once to initialize your local data.");
  }

  const config = await loadConfig(dataDir);
  const services = createAppServices({
    config,
    plugins: getLoadablePlugins(options.externalPlugins ?? []),
  });
  services.providerRouter.setConfigAccessor(() => config);
  await ensureCliServicesReady(services);
  return {
    config,
    dataDir,
    services,
    dataProvider: services.providerRouter,
    persistence: services.persistence,
    store: services.tickerRepository,
    destroy: () => services.destroy(),
  };
}
