import type { AppConfig } from "../types/config";
import { AppPersistence } from "../data/app-persistence";
import { TickerRepository } from "../data/ticker-repository";
import { AssetDataRouter } from "../sources/provider-router";
import type { AppServices } from "../core/app-services";

export type ConfigContext = {
  config: AppConfig;
  persistence: AppPersistence;
  store: TickerRepository;
  dataDir: string;
};

export type MarketContext = ConfigContext & {
  dataProvider: AssetDataRouter;
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
