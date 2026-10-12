import type { AppConfig } from "../../../../types/config";
import type { CliCommandContext } from "../../../../types/plugin";
import { parseListingArg } from "../../../../cli/listing-arg";
import { findPortfolio, isManualPortfolio } from "../mutations";
import { CASH_SYMBOL } from "../allocation";
import { findNamedCollection } from "../../../../portfolio/collection-name";

export { listingFields } from "../../../../cli/listing-arg";

/** A command error with a hint printed under it. */
export class PortfolioCliError extends Error {
  constructor(message: string, readonly details?: string) {
    super(message);
    this.name = "PortfolioCliError";
  }
}

/** Fails the command with the error's message and hint, or the fallback for anything unexpected. */
export function failPortfolioCommand(ctx: CliCommandContext, error: unknown, fallback: string): never {
  if (error instanceof Error) {
    const details = (error as { details?: unknown }).details;
    return ctx.fail(error.message, typeof details === "string" ? details : undefined);
  }
  return ctx.fail(fallback);
}

/**
 * The portfolio or watchlist the leading arguments name, and the arguments
 * after it. The first argument is the name (quoted when it has spaces); an
 * unquoted name with spaces still works, as the longest leading run of
 * arguments that names a collection. Null when none does, so a symbol is never
 * read as part of a name.
 */
export function takeCollectionName<T extends { id: string; name: string }>(
  args: readonly string[],
  collections: readonly T[],
): { collection: T; rest: string[] } | null {
  for (let length = args.length; length >= 1; length -= 1) {
    const name = args.slice(0, length).join(" ");
    const collection = findNamedCollection(collections, name);
    if (collection) return { collection, rest: args.slice(length) };
  }
  return null;
}

export function parseFiniteNumber(rawValue: string | undefined, label: string): number {
  const value = Number(rawValue);
  if (!rawValue?.trim() || !Number.isFinite(value)) {
    throw new Error(`${label} must be a valid number.`);
  }
  return value;
}

export function requirePortfolio(config: AppConfig, rawName: string): NonNullable<ReturnType<typeof findPortfolio>> {
  const portfolio = findPortfolio(config, rawName);
  if (!portfolio) {
    throw new PortfolioCliError(
      `Portfolio "${rawName}" was not found.`,
      config.portfolios.length > 0 ? `Portfolios: ${config.portfolios.map((entry) => entry.name).join(", ")}` : undefined,
    );
  }
  return portfolio;
}

export function requireManualPortfolio(config: AppConfig, rawName: string): NonNullable<ReturnType<typeof findPortfolio>> {
  const portfolio = requirePortfolio(config, rawName);
  if (!isManualPortfolio(portfolio)) {
    throw new Error(`Portfolio "${portfolio.name}" is broker-managed and cannot be modified manually.`);
  }
  return portfolio;
}

/** Whether the argument is the bare cash line rather than a listing (`CASH:NASDAQ` is a stock). */
export function isCashArgument(symbol: string, exchange?: string): boolean {
  const listing = parseListingArg(symbol, exchange);
  return listing.symbol === CASH_SYMBOL && !listing.exchange;
}

/**
 * Bare `CASH` would resolve to a company that trades under that symbol and
 * value the cash as its shares. Cash has its own line.
 */
export function rejectCashSymbol(symbol: string, exchange: string | undefined, portfolioName: string): void {
  if (!isCashArgument(symbol, exchange)) return;
  throw new PortfolioCliError(
    "CASH is the portfolio's cash line, not a ticker.",
    `Record cash with: gloomberb portfolio cash set "${portfolioName}" <amount> [currency]. For the stock that trades as CASH, name its exchange: CASH:NASDAQ.`,
  );
}
