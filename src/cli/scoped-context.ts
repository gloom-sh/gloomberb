import type { CliCommandContext } from "../types/plugin";
import type { CliServicesContext, ConfigContext, MarketContext } from "./types";

type AsyncInitializer<T> = () => Promise<T>;

async function withCleanup<TContext, TResult>(
  initialize: AsyncInitializer<TContext>,
  cleanup: (context: TContext) => void,
  operation: (context: TContext) => TResult | Promise<TResult>,
): Promise<TResult> {
  const context = await initialize();
  try {
    return await operation(context);
  } finally {
    cleanup(context);
  }
}

export async function withConfigData<TResult>(
  source: Pick<CliCommandContext, "initConfigData"> | AsyncInitializer<ConfigContext>,
  operation: (context: ConfigContext) => TResult | Promise<TResult>,
): Promise<TResult> {
  const initialize = typeof source === "function" ? source : () => source.initConfigData();
  return withCleanup(initialize, (context) => context.persistence.close(), operation);
}

export async function withMarketData<TResult>(
  source: Pick<CliCommandContext, "initMarketData"> | AsyncInitializer<MarketContext>,
  operation: (context: MarketContext) => TResult | Promise<TResult>,
): Promise<TResult> {
  const initialize = typeof source === "function" ? source : () => source.initMarketData();
  return withCleanup(initialize, (context) => context.persistence.close(), operation);
}

export async function withCliServices<TResult>(
  source: Pick<CliCommandContext, "initServices"> | AsyncInitializer<CliServicesContext>,
  operation: (context: CliServicesContext) => TResult | Promise<TResult>,
): Promise<TResult> {
  const initialize = typeof source === "function" ? source : () => source.initServices();
  return withCleanup(initialize, (context) => context.destroy(), operation);
}
