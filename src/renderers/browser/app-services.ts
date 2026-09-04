import { recordResearchActivity } from "../../api-client/research-activity";
import { newsProvider, type NewsCapability } from "../../capabilities";
import type { AppRuntimeServices, AppServicesFactoryOptions } from "../../core/app-service-ports";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../market-data/coordinator";
import { NewsService } from "../../news/aggregator";
import { setSharedNewsService } from "../../news/hooks";
import { PluginRegistry } from "../../plugins/registry";
import { createGloomberbCloudCapabilities, createGloomberbCloudProvider } from "../../sources/gloomberb-cloud";
import { AssetDataRouter } from "../../sources/provider-router";
import { BrowserPersistence } from "./persistence";
import { BrowserTickerRepository } from "./ticker-repository";

export function createBrowserAppServices({
  config,
  plugins,
}: AppServicesFactoryOptions): AppRuntimeServices {
  const persistence = new BrowserPersistence(localStorage);
  const tickerRepository = new BrowserTickerRepository(localStorage);
  const cloudProvider = createGloomberbCloudProvider();
  const dataProvider = new AssetDataRouter(null, [cloudProvider]);
  const marketData = new MarketDataCoordinator(dataProvider);
  const cloudNews = createGloomberbCloudCapabilities(cloudProvider).find(
    (capability): capability is NewsCapability => capability.kind === "news",
  );
  const pluginRegistry = new PluginRegistry(dataProvider, tickerRepository, persistence);
  dataProvider.attachRegistry(pluginRegistry);
  const stopSavedActivity = pluginRegistry.events.on("command-bar:portfolio-membership-persisted", () => recordResearchActivity("ticker_saved"));
  const newsService = new NewsService({
    pollIntervalMs: () => Math.max(1, config.refreshIntervalMinutes) * 60_000,
  });

  pluginRegistry.getConfigFn = () => config;
  pluginRegistry.getLayoutFn = () => config.layout;
  pluginRegistry.registerNewsCapabilityFn = (capability) => newsService.register(capability);
  pluginRegistry.watchNewsQueryFn = (query, listener) => newsService.watchQuery(query, listener);
  newsService.register(newsProvider({
    id: dataProvider.id,
    name: dataProvider.name,
    priority: 0,
    provider: { fetchNews: (query) => cloudNews?.provider.fetchNews(query) ?? Promise.resolve([]) },
  }));

  setSharedMarketDataCoordinator(marketData);
  setSharedNewsService(newsService);
  const ready = Promise.all(plugins.map((plugin) => pluginRegistry.register(plugin))).then(() => {});
  newsService.start();

  return {
    persistence,
    tickerRepository,
    dataProvider,
    marketData,
    pluginRegistry,
    ready,
    destroy() {
      stopSavedActivity();
      setSharedMarketDataCoordinator(null);
      setSharedNewsService(null);
      newsService.stop();
      pluginRegistry.destroy();
      persistence.close();
    },
  };
}
