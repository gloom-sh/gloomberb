import type { AppConfig } from "../../../../types/config";
import type { CliCommandContext } from "../../../../types/plugin";
import type { TickerRecord } from "../../../../types/ticker";
import { parseListingArg } from "../../../../cli/listing-arg";
import { isUsListingExchange } from "../../../../utils/exchanges";
import { findPortfolio, isManualPortfolio } from "../mutations";
import { CASH_SYMBOL } from "../allocation";

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

/** `VTI (Vanguard Total Stock Market ETF)`, with the venue and currency for a listing outside the US. */
export function describeTicker(ticker: TickerRecord): string {
  const { ticker: symbol, name, exchange, currency } = ticker.metadata;
  const foreign = !!exchange && !isUsListingExchange(exchange);
  const details = [
    name?.trim(),
    foreign ? exchange : undefined,
    foreign && currency && currency.toUpperCase() !== "USD" ? currency.toUpperCase() : undefined,
  ].filter((part): part is string => !!part);
  return details.length > 0 ? `${symbol} (${details.join(", ")})` : symbol;
}
