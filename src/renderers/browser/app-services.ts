import { recordResearchActivity } from "../../api-client/research-activity";
import { newsProvider, type NewsCapability } from "../../capabilities";
import type { AppServicesFactoryOptions } from "../../core/app-service-ports";
import { createAppRuntime } from "../../core/app-runtime";
import { createGloomberbCloudCapabilities, createGloomberbCloudProvider } from "../../sources/gloomberb-cloud";
import { AssetDataRouter } from "../../sources/provider-router";
import { JsonPersistence } from "../../data/json-persistence";
import { isBrokerAccountSnapshotKey } from "../../brokers/account-cache";
import { JsonTickerRepository } from "../../data/json-ticker-repository";
import { noteFirstScreenTicker } from "./first-screen";

export function createBrowserAppServices({ config, plugins, externalPlugins }: AppServicesFactoryOptions) {
  const cloudProvider = createGloomberbCloudProvider();
  const dataProvider = new AssetDataRouter(null, [cloudProvider]);
  const cloudNews = createGloomberbCloudCapabilities(cloudProvider).find(
    (capability): capability is NewsCapability => capability.kind === "news",
  );
  return createAppRuntime({
    config, plugins, externalPlugins, dataProvider,
    // Broker account snapshots are kept with the positions, so a reload keeps the account's equity and cash.
    persistence: new JsonPersistence(localStorage, { keepResource: isBrokerAccountSnapshotKey }),
    tickerRepository: new JsonTickerRepository(localStorage),
    configure({ pluginRegistry, newsService }) {
      dataProvider.attachRegistry(pluginRegistry);
      newsService.register(newsProvider({
        id: dataProvider.id,
        name: dataProvider.name,
        priority: 0,
        provider: { fetchNews: (query) => cloudNews?.provider.fetchNews(query) ?? Promise.resolve([]) },
      }));
      const offSaved = pluginRegistry.events.on("host:portfolio-ticker-saved", () => recordResearchActivity("ticker_saved"));
      const offSelected = pluginRegistry.events.on("ticker:selected", ({ symbol, previous }) => noteFirstScreenTicker(symbol, previous));
      return () => {
        offSaved();
        offSelected();
      };
    },
  });
}
