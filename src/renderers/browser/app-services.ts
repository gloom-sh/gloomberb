import { recordResearchActivity } from "../../api-client/research-activity";
import { newsProvider, type NewsCapability } from "../../capabilities";
import type { AppServicesFactoryOptions } from "../../core/app-service-ports";
import { createAppRuntime } from "../../core/app-runtime";
import { createGloomberbCloudCapabilities, createGloomberbCloudProvider } from "../../sources/gloomberb-cloud";
import { AssetDataRouter } from "../../sources/provider-router";
import { JsonPersistence } from "../../data/json-persistence";
import { isBrokerAccountSnapshotKey } from "../../brokers/account-cache";
import { JsonTickerRepository } from "../../data/json-ticker-repository";
import { registerGloomCloudConnectionSources } from "../../core/connection-health";
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
  const dataProvider = new AssetDataRouter(null, [cloudProvider]);
  const cloudNews = createGloomberbCloudCapabilities(cloudProvider).find(
    (capability): capability is NewsCapability => capability.kind === "news",
  );
  return createAppRuntime({
    config, plugins, externalPlugins, dataProvider,
    persistence,
    tickerRepository: new JsonTickerRepository(localStorage),
    configure({ pluginRegistry, newsService }) {
      dataProvider.attachRegistry(pluginRegistry);
      newsService.register(newsProvider({
        id: dataProvider.id,
        name: dataProvider.name,
        priority: 0,
        provider: { fetchNews: (query) => cloudNews?.provider.fetchNews(query) ?? Promise.resolve([]) },
      }));
      // The page sends its own Gloom Cloud requests and holds its own stream: their health is this registry's to keep.
      const disposeCloudSources = registerGloomCloudConnectionSources(pluginRegistry.connectionHealth);
      const stopRecording = pluginRegistry.events.on("host:portfolio-ticker-saved", () => recordResearchActivity("ticker_saved"));
      return () => {
        stopRecording();
        disposeCloudSources();
      };
    },
  });
}
