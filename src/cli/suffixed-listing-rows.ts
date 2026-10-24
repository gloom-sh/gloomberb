import { saveConfig } from "../data/config/store";
import { mergeSavedSuffixedListings } from "../portfolio/suffixed-listings";
import type { CliCommandContext } from "../types/plugin";
import { debugLog } from "../utils/debug-log";
import { logFailure } from "../utils/log-failure";
import { withConfigData, withMarketData } from "./scoped-context";
import type { ConfigContext, MarketContext } from "./types";

const log = debugLog.createLogger("cli.suffixed-listings");

/**
 * The profile with the rows a collection holds under a vendor's suffixed key
 * (GARAN.IS) merged into their listing's row (`mergeSuffixedListings`), as
 * the app does at launch, for a command about to change a portfolio or
 * watchlist: what it reads is then what it saves over. A dry run writes
 * nothing and reads the profile as it is. A merge that fails leaves the rows
 * as they were.
 */
async function mergedForWrite<TContext extends ConfigContext>(ctx: Pick<CliCommandContext, "cliOptions">, context: TContext): Promise<TContext> {
  if (ctx.cliOptions.dryRun) return context;
  try {
    const merged = await mergeSavedSuffixedListings(await context.store.loadAllTickers(), context.config, {
      config: saveConfig,
      tickers: (rows) => context.store.saveTickers(rows),
    });
    // In place: a market context's provider reads the config through this object.
    if (merged) context.config = merged.config;
    for (const kept of merged?.keptCustom ?? []) log.info("custom fields kept on the suffixed row", kept);
  } catch (error) {
    logFailure("cli.suffixed-listings", "Merging suffixed listing rows failed")(error);
  }
  return context;
}

/** `withConfigData` for a command that changes a portfolio or watchlist (`mergedForWrite`). Commands that only read use `withConfigData`. */
export function withCollectionConfigData<TResult>(
  ctx: Pick<CliCommandContext, "initConfigData" | "cliOptions">,
  operation: (context: ConfigContext) => TResult | Promise<TResult>,
): Promise<TResult> {
  return withConfigData(async () => mergedForWrite(ctx, await ctx.initConfigData()), operation);
}

/** `withMarketData` for a command that changes a portfolio or watchlist (`mergedForWrite`). */
export function withCollectionMarketData<TResult>(
  ctx: Pick<CliCommandContext, "initMarketData" | "cliOptions">,
  operation: (context: MarketContext) => TResult | Promise<TResult>,
): Promise<TResult> {
  return withMarketData(async () => mergedForWrite(ctx, await ctx.initMarketData()), operation);
}
