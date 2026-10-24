import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { getDataDir, initDataDir, loadConfig, saveConfig } from "../data/config/store";
import { getGloomberbDirs } from "../data/config/home";
import { AppPersistence } from "../data/app-persistence";
import { TickerRepository } from "../data/ticker-repository";
import { AssetDataRouter } from "../sources/provider-router";
import { createAppServices } from "../core/app-services";
import type { PluginCapability } from "../capabilities";
import type { AppConfig } from "../types/config";
import type { GloomPlugin } from "../types/plugin";
import { getLoadablePlugins } from "../plugins/catalog";
import { standaloneSeriesCatalog, standaloneSeriesInvoker } from "../series/standalone";
import type { PluginRegistry } from "../plugins/registry";
import type { LoadedExternalPlugin } from "../plugins/loader";
import { apiClient } from "../api-client";
import { fail } from "./errors";
import { resolvePersistedCloudSessionToken } from "./pane-functions/cloud-session";
import { cloudStatementReportSources } from "./statement-filings";
import type { ConfigContext, MarketContext } from "./types";
import { mergeSavedSuffixedListings } from "../portfolio/suffixed-listings";
import { logFailure } from "../utils/log-failure";

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

function isUnreadableConfig(configFile: string): boolean {
  try {
    JSON.parse(readFileSync(configFile, "utf-8"));
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** The data folder this profile uses, whether or not anything has created it yet. Never writes. */
export async function resolveCliDataDir(): Promise<string> {
  return await getDataDir() ?? getGloomberbDirs().data;
}

/**
 * The data folder and config a command works with. The first command on a new
 * profile creates them with the same `initDataDir` a first launch of the
 * terminal or desktop app runs, so the CLI works before the app was ever
 * opened. That config leaves onboarding unfinished, so the app's first launch
 * still walks through it.
 *
 * A config.json that is there but does not parse would be replaced with
 * defaults by that, so the command fails instead and leaves it for the user.
 */
async function openCliDataDir(): Promise<{ dataDir: string; config: AppConfig; created: boolean }> {
  const recorded = await getDataDir();
  if (recorded && existsSync(recorded)) {
    return { dataDir: recorded, config: await loadConfig(recorded), created: false };
  }
  const { configFile, data } = getGloomberbDirs();
  if (!recorded && isUnreadableConfig(configFile)) {
    fail(`Could not read ${configFile}.`, "Fix the file or move it aside; the next command creates a fresh one.");
  }
  const dataDir = recorded ?? data;
  return { dataDir, config: await initDataDir(dataDir), created: true };
}

/**
 * Rows a collection holds under a vendor's suffixed key (GARAN.IS) merge into
 * their listing's row as the profile loads, as the app does at launch
 * (`mergeSuffixedListings`). A merge that fails leaves the rows as they were.
 */
async function mergeSuffixedListingRows(store: TickerRepository, config: AppConfig): Promise<AppConfig> {
  try {
    const merged = await mergeSavedSuffixedListings(await store.loadAllTickers(), config, (rows) => store.saveTickers(rows));
    if (!merged || merged.config === config) return config;
    await saveConfig(merged.config);
    return merged.config;
  } catch (error) {
    logFailure("cli.context", "Merging suffixed listing rows failed")(error);
    return config;
  }
}

export async function initConfigData(): Promise<ConfigContext> {
  const { dataDir, config } = await openCliDataDir();
  const persistence = new AppPersistence(join(dataDir, ".gloomberb-cache.db"));
  const store = new TickerRepository(persistence.tickers);
  return { config: await mergeSuffixedListingRows(store, config), persistence, store, dataDir };
}

/**
 * Market commands (`quote`, `compare`, `history`...) run with the session the
 * app saved after sign-in, as `fn` does: Gloom Cloud answers a Pro account
 * with real-time quotes and anyone else with delayed ones.
 */
function applyPersistedCloudSession(context: Pick<MarketContext, "persistence">): void {
  apiClient.setSessionToken(resolvePersistedCloudSessionToken(context));
}

export async function initMarketData(options: CliContextOptions = {}): Promise<MarketContext> {
  const context = await initConfigData();
  applyPersistedCloudSession(context);
  const plugins = options.plugins ?? getLoadablePlugins();
  const capabilities = resolveCliCapabilities(context.config, plugins);
  const dataProvider = new AssetDataRouter(null, [], context.persistence.resources);
  const registryAdapter: Pick<PluginRegistry, "brokers" | "getEnabledCapabilities"> = {
    brokers: new Map(),
    getEnabledCapabilities: (kind?: string) => capabilities.filter((capability) => !kind || capability.kind === kind),
  };
  dataProvider.attachRegistry(registryAdapter as PluginRegistry);
  dataProvider.setConfigAccessor(() => context.config);
  dataProvider.setBackgroundRevalidation(false);
  const seriesCapabilities = standaloneSeriesInvoker(plugins, context.dataDir, context.config.disabledPlugins);
  const findCatalogSeries = standaloneSeriesCatalog(plugins, context.config.disabledPlugins);
  return { ...context, dataProvider, seriesCapabilities, findCatalogSeries, statementSources: cloudStatementReportSources };
}

export async function initCliServices(options: CliServicesOptions = {}) {
  const { dataDir, config: opened, created } = await openCliDataDir();
  const services = createAppServices({
    config: opened,
    plugins: getLoadablePlugins(options.externalPlugins ?? []),
    externalPlugins: options.externalPlugins ?? [],
  });
  const config = await mergeSuffixedListingRows(services.tickerRepository, opened);
  services.providerRouter.setConfigAccessor(() => config);
  services.providerRouter.setBackgroundRevalidation(false);
  await ensureCliServicesReady(services);
  applyPersistedCloudSession(services);
  return {
    config,
    dataDir,
    createdDataDir: created,
    services,
    dataProvider: services.providerRouter,
    persistence: services.persistence,
    store: services.tickerRepository,
    destroy: () => services.destroy(),
  };
}
