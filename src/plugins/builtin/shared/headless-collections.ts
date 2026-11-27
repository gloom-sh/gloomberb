import { describeCollections } from "../../../portfolio/collection-name";
import type { HeadlessPaneContext } from "../../../types/headless";

export async function requireHeadlessPortfolio(name: string, ctx: HeadlessPaneContext) {
  const local = await ctx.resolvePortfolio?.(name);
  if (!local) {
    throw new Error(`Unknown local portfolio: ${name}.${ctx.config.portfolios.length ? ` Portfolios: ${describeCollections(ctx.config.portfolios)}.` : ""}`);
  }
  return local;
}

export async function requireHeadlessWatchlist(name: string, ctx: HeadlessPaneContext) {
  const tickers = await ctx.resolveWatchlist?.(name);
  if (!tickers) {
    throw new Error(`Unknown local watchlist: ${name}.${ctx.config.watchlists.length ? ` Watchlists: ${describeCollections(ctx.config.watchlists)}.` : ""}`);
  }
  return tickers;
}
