import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { createRemoteBrokerAdapter } from "../../../brokers/remote-broker-adapter";
import { NewsService } from "../../../news/aggregator";
import { setSharedNewsService } from "../../../news/hooks";
import { PluginRegistry } from "../../../plugins/registry";
import type { AppRuntimeServices, AppServicesFactoryOptions } from "../../../core/app-service-ports";
import { newsProvider } from "../../../capabilities";
import { debugLog } from "../../../utils/debug-log";
import { measurePerf, measurePerfAsync } from "../../../utils/perf-marks";
import { getRendererBuiltinPlugins } from "../../../plugins/catalog-ui";
import { createRemoteAssetDataClient } from "./remote/asset-data-client";
import { RemotePersistence } from "./remote/persistence";
import { RemoteTickerRepository } from "./remote/ticker-repository";
import { connectBackendConnectionHealth } from "./remote/connection-health-backend";
import { backendRequest, getElectrobunBackendInitSnapshot } from "./backend-rpc";
import { createCapabilityInvoker } from "./remote/capability-invoker";
import { apiClient } from "../../../api-client";
import { cloudNewsParams, mapCloudNewsArticle } from "../../../sources/gloomberb-cloud/news";

const servicesLog = debugLog.createLogger("services");

export function createElectrobunAppServices({ config }: AppServicesFactoryOptions): AppRuntimeServices {
  servicesLog.info("create desktop web services start", {
    brokerInstanceCount: config.brokerInstances.length,
  });
  const persistence = measurePerf("startup.services.persistence", () => new RemotePersistence());
  const tickerRepository = measurePerf("startup.services.ticker-repository", () => new RemoteTickerRepository());
  const dataProvider = measurePerf("startup.services.data-provider", () => createRemoteAssetDataClient());
  const marketData = new MarketDataCoordinator(dataProvider);
  const invokeCapability = createCapabilityInvoker({
    request: backendRequest,
    shouldApplyDeadline: () => false,
    timeoutMs: 0,
  });
  const pluginRegistry = new PluginRegistry(dataProvider, tickerRepository, persistence, {
    enableCapabilityHandlers: false,
    wrapBrokerAdapter: (broker) => createRemoteBrokerAdapter(broker),
    remoteCapabilityManifests: () => getElectrobunBackendInitSnapshot()?.capabilityManifests ?? [],
    remoteCapabilityInvoke: (capabilityId, operationId, payload, options) => (
      invokeCapability(capabilityId, operationId, payload, options)
    ),
  });
  const newsService = new NewsService({ connectionHealth: pluginRegistry.connectionHealth });

  pluginRegistry.getConfigFn = () => config;
  pluginRegistry.getLayoutFn = () => config.layout;
  pluginRegistry.registerNewsCapabilityFn = () => () => {};
  pluginRegistry.watchNewsQueryFn = (query, listener) => newsService.watchQuery(query, listener);

  setSharedMarketDataCoordinator(marketData);
  setSharedNewsService(newsService);

  newsService.register(newsProvider({
    id: dataProvider.id,
    name: dataProvider.name,
    priority: 0,
    provider: {
      fetchNews: (query) => dataProvider.getNews(query),
      fetchNewsPage: async (query) => {
        try {
          const response = await apiClient.getCloudNews(cloudNewsParams(query));
          return {
            articles: response.items.map((item) => mapCloudNewsArticle(item, query.ticker)),
            nextCursor: response.nextCursor ?? null,
          };
        } catch {
          return { articles: await dataProvider.getNews(query), nextCursor: null };
        }
      },
    },
  }));

  const plugins = getRendererBuiltinPlugins();
  const pluginReadyPromises: Promise<void>[] = [];
  for (const plugin of plugins) {
    pluginReadyPromises.push(measurePerfAsync("startup.services.register-plugin", () => (
      pluginRegistry.register(plugin)
    ), { pluginId: plugin.id }));
  }
  measurePerf("startup.services.news-start", () => {
    newsService.start();
  });
  let destroyed = false;
  let disposeRemoteConnectionHealth: (() => void) | null = null;
  const ready = Promise.all(pluginReadyPromises).then(() => {
    if (destroyed) return;
    const dispose = connectBackendConnectionHealth(pluginRegistry.connectionHealth);
    if (destroyed) dispose();
    else disposeRemoteConnectionHealth = dispose;
  });
  servicesLog.info("create desktop web services complete", { pluginCount: plugins.length });

  return {
    persistence,
    tickerRepository,
    dataProvider,
    marketData,
    pluginRegistry,
    ready,
    destroy() {
      destroyed = true;
      disposeRemoteConnectionHealth?.();
      disposeRemoteConnectionHealth = null;
      setSharedMarketDataCoordinator(null);
      setSharedNewsService(null);
      newsService.stop();
      pluginRegistry.destroy();
      persistence.close();
    },
  };
}
