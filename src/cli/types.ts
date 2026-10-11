import type { AppConfig } from "../types/config";
import { AppPersistence } from "../data/app-persistence";
import { TickerRepository } from "../data/ticker-repository";
import { AssetDataRouter } from "../sources/provider-router";
import type { AppServices } from "../core/app-services";
import type { CapabilityInvoker } from "../capabilities/types";

export type ConfigContext = {
  config: AppConfig;
  persistence: AppPersistence;
  store: TickerRepository;
  dataDir: string;
};

export type MarketContext = ConfigContext & {
  dataProvider: AssetDataRouter;
  /** Charts catalog series in a report run without the plugin runtime. */
  seriesCapabilities?: CapabilityInvoker;
  /** `--refresh`: prefetched data bypasses the local cache. */
  refresh?: boolean;
};

export type CliServicesContext = {
  config: AppConfig;
  dataDir: string;
  services: AppServices;
  dataProvider: AssetDataRouter;
  persistence: AppPersistence;
  store: TickerRepository;
  destroy(): void;
};
