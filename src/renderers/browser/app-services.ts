import { recordResearchActivity } from "../../api-client/research-activity";
import { newsProvider, type NewsCapability } from "../../capabilities";
import type { AppServicesFactoryOptions } from "../../core/app-service-ports";
import { createAppRuntime } from "../../core/app-runtime";
import { createGloomberbCloudCapabilities, createGloomberbCloudProvider } from "../../sources/gloomberb-cloud";
import { AssetDataRouter } from "../../sources/provider-router";
import { JsonPersistence } from "../../data/json-persistence";
import { JsonTickerRepository } from "../../data/json-ticker-repository";

export function createBrowserAppServices({ config, plugins }: AppServicesFactoryOptions) {
  const cloudProvider = createGloomberbCloudProvider();
  const dataProvider = new AssetDataRouter(null, [cloudProvider]);
  const cloudNews = createGloomberbCloudCapabilities(cloudProvider).find(
    (capability): capability is NewsCapability => capability.kind === "news",
  );
  return createAppRuntime({
    config, plugins, dataProvider,
    persistence: new JsonPersistence(localStorage),
    tickerRepository: new JsonTickerRepository(localStorage),
    configure({ pluginRegistry, newsService }) {
      dataProvider.attachRegistry(pluginRegistry);
      newsService.register(newsProvider({
        id: dataProvider.id,
        name: dataProvider.name,
        priority: 0,
        provider: { fetchNews: (query) => cloudNews?.provider.fetchNews(query) ?? Promise.resolve([]) },
      }));
      return pluginRegistry.events.on("command-bar:portfolio-membership-persisted", () => recordResearchActivity("ticker_saved"));
    },
  });
}
