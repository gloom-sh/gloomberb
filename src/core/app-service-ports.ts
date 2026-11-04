import type { PluginStateStore } from "../data/plugin-state-store";
import type { ResourceStore } from "../data/resource-store";
import type { SessionStore } from "../data/session-store";
import type { TickerRepository } from "../data/ticker-repository";
import type { MarketDataCoordinator } from "../market-data/coordinator";
import type { LoadedExternalPlugin } from "../plugins/loader";
import type { PluginRegistry } from "../plugins/registry";
import type { AppConfig } from "../types/config";
import type { DataProvider } from "../types/data-provider";
import type { GloomPlugin } from "../types/plugin";

export type AppPluginStateStorePort = Pick<
  PluginStateStore,
  "get" | "set" | "delete" | "keys" | "clear"
> & Partial<Pick<PluginStateStore, "getStrict">>;

export type AppResourceStorePort = Pick<ResourceStore, "get" | "list" | "set" | "delete">;
export type AppSessionStorePort = Pick<SessionStore, "get" | "set" | "delete">;

export interface AppPersistencePort {
  pluginState: AppPluginStateStorePort;
  resources: AppResourceStorePort;
  sessions: AppSessionStorePort;
  close(): void;
}

export type AppTickerRepositoryPort = Pick<
  TickerRepository,
  "loadAllTickers" | "loadTicker" | "saveTicker" | "createTicker" | "deleteTicker"
>;

export interface AppRuntimeServices {
  persistence: AppPersistencePort;
  tickerRepository: AppTickerRepositoryPort;
  dataProvider: DataProvider;
  marketData: MarketDataCoordinator;
  pluginRegistry: PluginRegistry;
  ready: Promise<void>;
  destroy(): void;
}

export interface AppServicesFactoryOptions {
  config: AppConfig;
  plugins: readonly GloomPlugin[];
  /**
   * The entries behind the external plugins in `plugins`. One of them failing
   * to register is recorded on its entry and shown in the marketplace; without
   * this list the runtime cannot tell it apart from a built-in, whose failure
   * is a bug that should stop startup.
   */
  externalPlugins?: readonly LoadedExternalPlugin[];
}

export type AppServicesFactory = (options: AppServicesFactoryOptions) => AppRuntimeServices;
