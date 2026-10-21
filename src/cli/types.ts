import type { AppConfig } from "../types/config";
import { AppPersistence } from "../data/app-persistence";
import { TickerRepository } from "../data/ticker-repository";
import { AssetDataRouter } from "../sources/provider-router";
import type { AppServices } from "../core/app-services";
import type { CapabilityInvoker } from "../capabilities/types";
import type { StatementReportSources } from "./statement-filings";
import type { FxHistoryClient } from "../market-data/fx-closes";

export type ConfigContext = {
  config: AppConfig;
  persistence: AppPersistence;
  store: TickerRepository;
  dataDir: string;
};

export type MarketContext = ConfigContext & {
  dataProvider: AssetDataRouter;
  resolveBroker?: (brokerType: string) => import("../types/broker").BrokerAdapter | null;
  /** Charts catalog series in a report run without the plugin runtime. */
  seriesCapabilities?: CapabilityInvoker;
  /** `--refresh`: prefetched data bypasses the local cache. */
  refresh?: boolean;
  /** Filings behind the statements and a bank's figures, read from Gloom Cloud; absent where the data service is a stand-in. */
  statementSources?: StatementReportSources;
  /** Daily FX closes (`fx --date`, converted INS values); Gloom Cloud unless a test stands in for it. */
  fxHistory?: FxHistoryClient;
};

export type CliServicesContext = {
  config: AppConfig;
  dataDir: string;
  /** This command created the data folder: the profile had never been used. */
  createdDataDir?: boolean;
  services: AppServices;
  dataProvider: AssetDataRouter;
  persistence: AppPersistence;
  store: TickerRepository;
  destroy(): void;
};
