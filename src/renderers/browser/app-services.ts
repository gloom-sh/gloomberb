import { recordResearchActivity } from "../../api-client/research-activity";
import { assetDataProvider, newsProvider } from "../../capabilities";
import type { AppServicesFactoryOptions } from "../../core/app-service-ports";
import { createAppRuntime } from "../../core/app-runtime";
import { connectionHealth, registerGloomCloudConnectionSources } from "../../core/connection-health";
import { createGloomberbCloudProvider } from "../../sources/gloomberb-cloud";
import { AssetDataRouter } from "../../sources/provider-router";
import { JsonPersistence } from "../../data/json-persistence";
import { isBrokerAccountSnapshotKey } from "../../brokers/account-cache";
import { JsonTickerRepository } from "../../data/json-ticker-repository";
import type { BrowserResources } from "./resource-db";

/**
 * The web app's services. `resources` are the saved copies the launch opened
 * (resource-db.ts): every cache, the plugins' and the market data's, starts
 * from them and writes through to them, so a reload opens its panes on what
 * they last showed.
 */
export function createBrowserAppServices({ config, plugins, externalPlugins }: AppServicesFactoryOptions, resources?: BrowserResources) {
  const cloudProvider = createGloomberbCloudProvider();
  const persistence = new JsonPersistence(localStorage, {
    keepResource: isBrokerAccountSnapshotKey,
    durable: resources && { saved: resources.records.splice(0), sink: resources.sink },
  });
  const dataProvider = new AssetDataRouter(null, [cloudProvider], persistence.resources, connectionHealth);
  return createAppRuntime({
    config, plugins, externalPlugins, dataProvider,
    persistence,
    tickerRepository: new JsonTickerRepository(localStorage),
    registryOptions: { connectionHealth },
    configure({ pluginRegistry, newsService }) {
      dataProvider.attachRegistry(pluginRegistry);
      pluginRegistry.capabilities.register("core", assetDataProvider(dataProvider));
      pluginRegistry.capabilities.register("core", {
        ...newsProvider({
          id: "core",
          name: "News",
          provider: {
            fetchNews: async (query) => (await newsService.load(query)).articles,
            fetchNewsPage: async (query) => {
              const { articles, error, nextCursor, access } = await newsService.load(query);
              return { articles, error, nextCursor, access };
            },
            getCachedNews: (query) => newsService.getQueryState(query).articles,
          },
        }),
        // The router must not rediscover its own aggregate facade as a source.
        sourceId: dataProvider.id,
      });
      // The page sends its own Gloom Cloud requests and holds its own stream: their health is this registry's to keep.
      const disposeCloudSources = registerGloomCloudConnectionSources(connectionHealth);
      const stopRecording = pluginRegistry.events.on("host:portfolio-ticker-saved", () => recordResearchActivity("ticker_saved"));
      return () => {
        stopRecording();
        disposeCloudSources();
      };
    },
  });
}
