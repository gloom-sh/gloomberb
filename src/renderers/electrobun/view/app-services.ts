import { createRemoteBrokerAdapter } from "../../../brokers/remote-broker-adapter";
import type { AppServicesFactoryOptions } from "../../../core/app-service-ports";
import { createAppRuntime } from "../../../core/app-runtime";
import { createRemoteAssetDataClient } from "./remote/asset-data-client";
import { RemotePersistence } from "./remote/persistence";
import { RemoteTickerRepository } from "./remote/ticker-repository";
import { connectBackendConnectionHealth } from "./remote/connection-health";
import { backendRequest, getElectrobunBackendInitSnapshot } from "./backend-rpc";
import { createCapabilityInvoker } from "./remote/capability-invoker";
import { createDesktopNewsSource } from "./news-source";

export function createElectrobunAppServices({ config, plugins, externalPlugins }: AppServicesFactoryOptions) {
  const dataProvider = createRemoteAssetDataClient();
  const invokeCapability = createCapabilityInvoker({
    request: backendRequest,
    shouldApplyDeadline: () => false,
    timeoutMs: 0,
  });
  return createAppRuntime({
    config, plugins, externalPlugins, dataProvider,
    persistence: new RemotePersistence(),
    tickerRepository: new RemoteTickerRepository(),
    registryOptions: {
      enableCapabilityHandlers: false,
      wrapBrokerAdapter: (broker) => createRemoteBrokerAdapter(broker),
      remoteCapabilityManifests: () => getElectrobunBackendInitSnapshot()?.capabilityManifests ?? [],
      remoteCapabilityInvoke: invokeCapability,
    },
    // The news service's own two-minute cadence, even while the window is
    // hidden or minimized: breaking-news notifications stay prompt, where the
    // shared default drops a hidden app to the configured refresh interval.
    newsOptions: { pollIntervalMs: undefined },
    configure({ newsService }) {
      newsService.register(createDesktopNewsSource(dataProvider));
    },
    onReady: ({ pluginRegistry }) => connectBackendConnectionHealth(pluginRegistry.connectionHealth),
  });
}
