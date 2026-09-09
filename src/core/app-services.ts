import { join } from "path";
import { connectionHealth, registerGloomCloudConnectionSources } from "./connection-health";
import { AppPersistence } from "../data/app-persistence";
import { TickerRepository } from "../data/ticker-repository";
import { AssetDataRouter } from "../sources/provider-router";
import { assetDataProvider, newsProvider } from "../capabilities";
import { getPluginResourceStore, setPluginResourceStore } from "../public/broker";
import type { AppServicesFactoryOptions } from "./app-service-ports";
import { createAppRuntime } from "./app-runtime";

export type AppServices = ReturnType<typeof createAppServices>;

export function createAppServices({ config, plugins }: AppServicesFactoryOptions) {
  const persistence = new AppPersistence(join(config.dataDir, ".gloomberb-cache.db"));
  const tickerRepository = new TickerRepository(persistence.tickers);
  const providerRouter = new AssetDataRouter(null, [], persistence.resources, connectionHealth);
  const runtime = createAppRuntime({
    config, plugins, persistence, tickerRepository, dataProvider: providerRouter,
    registryOptions: { connectionHealth },
    configure({ pluginRegistry, newsService }) {
      providerRouter.attachRegistry(pluginRegistry);
      pluginRegistry.capabilities.register("core", assetDataProvider(providerRouter));
      pluginRegistry.capabilities.register("core", {
        ...newsProvider({
          id: "core",
          name: "News",
          provider: {
            fetchNews: async (query) => (await newsService.load(query)).articles,
            getCachedNews: (query) => newsService.getQueryState(query).articles,
          },
        }),
        // The router must not rediscover its own aggregate facade as a source.
        sourceId: providerRouter.id,
      });
      setPluginResourceStore(persistence.resources);
      const disposeCloudSources = registerGloomCloudConnectionSources(connectionHealth);
      return () => {
        if (getPluginResourceStore() === persistence.resources) setPluginResourceStore(null);
        disposeCloudSources();
      };
    },
  });
  return { ...runtime, persistence, tickerRepository, providerRouter };
}
