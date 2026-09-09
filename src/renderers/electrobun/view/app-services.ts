import { createRemoteBrokerAdapter } from "../../../brokers/remote-broker-adapter";
import type { AppServicesFactoryOptions } from "../../../core/app-service-ports";
import { createAppRuntime } from "../../../core/app-runtime";
import { newsProvider } from "../../../capabilities";
import { createRemoteAssetDataClient } from "./remote/asset-data-client";
import { RemotePersistence } from "./remote/persistence";
import { RemoteTickerRepository } from "./remote/ticker-repository";
import { connectBackendConnectionHealth } from "./remote/connection-health-backend";
import { backendRequest, getElectrobunBackendInitSnapshot } from "./backend-rpc";
import { createCapabilityInvoker } from "./remote/capability-invoker";
import { apiClient } from "../../../api-client";
import { cloudNewsParams, mapCloudNewsArticle } from "../../../sources/gloomberb-cloud/news";

export function createElectrobunAppServices({ config, plugins }: AppServicesFactoryOptions) {
  const dataProvider = createRemoteAssetDataClient();
  const invokeCapability = createCapabilityInvoker({
    request: backendRequest,
    shouldApplyDeadline: () => false,
    timeoutMs: 0,
  });
  return createAppRuntime({
    config, plugins, dataProvider,
    persistence: new RemotePersistence(),
    tickerRepository: new RemoteTickerRepository(),
    registryOptions: {
      enableCapabilityHandlers: false,
      wrapBrokerAdapter: (broker) => createRemoteBrokerAdapter(broker),
      remoteCapabilityManifests: () => getElectrobunBackendInitSnapshot()?.capabilityManifests ?? [],
      remoteCapabilityInvoke: invokeCapability,
    },
    newsOptions: { pollIntervalMs: undefined },
    configure({ newsService }) {
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
    },
    onReady: ({ pluginRegistry }) => connectBackendConnectionHealth(pluginRegistry.connectionHealth),
  });
}
