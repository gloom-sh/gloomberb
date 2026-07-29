import { join } from "path";
import { AppPersistence } from "../data/app-persistence";
import { TickerRepository } from "../data/ticker-repository";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../market-data/coordinator";
import { NewsService } from "../news/aggregator";
import { setSharedNewsService } from "../news/hooks";
import { PluginRegistry } from "../plugins/registry";
import { AssetDataRouter } from "../sources/provider-router";
import { assetDataProvider, newsProvider } from "../capabilities";
import type { DataProvider } from "../types/data-provider";
import { debugLog } from "../utils/debug-log";
import { measurePerf, measurePerfAsync } from "../utils/perf-marks";
import { setIbkrPortfolioPerformanceResourceStore } from "../plugins/ibkr/portfolio-performance";
import type { AppRuntimeServices, AppServicesFactoryOptions } from "./app-service-ports";

const servicesLog = debugLog.createLogger("services");

export interface AppServices extends AppRuntimeServices {
  persistence: AppPersistence;
  tickerRepository: TickerRepository;
  providerRouter: AssetDataRouter;
  dataProvider: DataProvider;
  marketData: MarketDataCoordinator;
  pluginRegistry: PluginRegistry;
  newsService: NewsService;
  ready: Promise<void>;
  destroy(): void;
}

export function createAppServices({
  config,
  plugins,
}: AppServicesFactoryOptions): AppServices {
  servicesLog.info("create services start", {
    pluginCount: plugins.length,
    brokerInstanceCount: config.brokerInstances.length,
  });
  const dbPath = join(config.dataDir, ".gloomberb-cache.db");
  const persistence = measurePerf("startup.services.persistence", () => new AppPersistence(dbPath));
  setIbkrPortfolioPerformanceResourceStore(persistence.resources);
  const tickerRepository = measurePerf("startup.services.ticker-repository", () => new TickerRepository(persistence.tickers));
  const providerRouter = measurePerf("startup.services.asset-data-router", () => new AssetDataRouter(null, [], persistence.resources));
  const dataProvider: DataProvider = providerRouter;
  const marketData = new MarketDataCoordinator(dataProvider);
  const pluginRegistry = new PluginRegistry(dataProvider, tickerRepository, persistence);
  const newsService = new NewsService();
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
    // This capability exposes the aggregate service to remote renderers. Giving
    // it the router source id prevents the router from rediscovering its own
    // aggregate facade alongside the underlying plugin news sources.
    sourceId: providerRouter.id,
  });

  providerRouter.attachRegistry(pluginRegistry);
  pluginRegistry.getConfigFn = () => config;
  pluginRegistry.getLayoutFn = () => config.layout;
  pluginRegistry.registerNewsCapabilityFn = (capability) => newsService.register(capability);
  pluginRegistry.watchNewsQueryFn = (query, listener) => newsService.watchQuery(query, listener);

  setSharedNewsService(newsService);
  setSharedMarketDataCoordinator(marketData);

  const pluginReadyPromises: Promise<void>[] = [];
  for (const plugin of plugins) {
    pluginReadyPromises.push(measurePerfAsync("startup.services.register-plugin", () => (
      pluginRegistry.register(plugin)
    ), { pluginId: plugin.id }));
  }
  measurePerf("startup.services.news-start", () => {
    newsService.start();
  });
  servicesLog.info("create services complete", { pluginCount: plugins.length });

  return {
    persistence,
    tickerRepository,
    providerRouter,
    dataProvider,
    marketData,
    pluginRegistry,
    newsService,
    ready: Promise.all(pluginReadyPromises).then(() => {}),
    destroy() {
      setSharedMarketDataCoordinator(null);
      setSharedNewsService(null);
      newsService.stop();
      pluginRegistry.destroy();
      setIbkrPortfolioPerformanceResourceStore(null);
      persistence.close();
    },
  };
}
