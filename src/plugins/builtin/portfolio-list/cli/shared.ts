import type { AppConfig } from "../../../../types/config";
import type { CliCommandContext } from "../../../../types/plugin";
import { parseListingArg } from "../../../../cli/listing-arg";
import { findPortfolio, isManualPortfolio } from "../../../../portfolio/mutations";
import { CASH_SYMBOL } from "../allocation";
import { findNamedCollection } from "../../../../portfolio/collection-name";
import { readCurrencyAmount, readTypedNumber, TYPED_AMOUNT_FORMAT } from "../../../../utils/decimal-comma";

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
 * Fails an action that changes a portfolio or watchlist when `--dry-run` was
 * given. None of them previews, so running it anyway would save the change
 * under a flag that promises not to; this fails before anything is written.
 */
export function refuseDryRun(ctx: CliCommandContext, noun: "watchlist" | "portfolio", action: string): void {
  if (ctx.cliOptions.dryRun) ctx.fail(`${noun} ${action} has no --dry-run; it changes the ${noun} when it runs.`);
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

/** What a pasted list of symbols with no list name in front of it fails with. */
export interface MisplacedSymbolList {
  message: string;
  details: string;
}

/** How much of a pasted list an error quotes back. */
const PASTE_PREVIEW = 40;

/**
 * Whether the only argument is a list of symbols given where the name goes: it
 * names no collection (the caller looked) and holds separators (a comma, a
 * semicolon, a blank, a newline), as `usdngn=x, USDZAR=X; usdsar=x` pasted
 * from a sheet does. Null for anything else, and with `--file`, where the one
 * argument is the name. The failure says what the command takes, and which
 * lists there are.
 */
export function misplacedSymbolList(
  args: readonly string[],
  file: string | undefined,
  options: { noun: "watchlist" | "portfolio"; verb: "add" | "remove"; collections: readonly { name: string }[]; usage: string },
): MisplacedSymbolList | null {
  const typed = args.length === 1 && file == null ? args[0]!.trim() : "";
  if (!/[\s,;]/.test(typed)) return null;
  const { noun, verb, collections, usage } = options;
  const flat = typed.replace(/\s+/g, " ");
  const preview = flat.length > PASTE_PREVIEW ? `${flat.slice(0, PASTE_PREVIEW - 1)}…` : flat;
  const label = noun === "watchlist" ? "lists" : "portfolios";
  const names = collections.slice(0, 12).map((entry) => entry.name);
  const more = collections.length - names.length;
  const existing = names.length > 0
    ? `${label}: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}`
    : `no ${label} yet, create one with \`gloomberb ${noun} create <name>\``;
  return {
    message: `"${preview}" reads as a list of symbols, not a ${noun} name; did you mean \`gloomberb ${noun} ${verb} <name> <list>\`; ${existing}`,
    details: usage,
  };
}

/**
 * A number argument: `1.234,5` and `1,234.5` are 1234.5, `18,50` is 18.5. With
 * a currency it is an amount of it (cash), where `1,234` and `1.234` are
 * thousands unless the currency has three decimals (`readCurrencyAmount`);
 * without one it is a price per share or a share count, where a lone dot is a
 * decimal point (`readTypedNumber`). One that reads two ways fails naming
 * both, rather than storing either.
 */
export function parseAmountArg(rawValue: string | undefined, label: string, currency?: string): number {
  const value = currency ? readCurrencyAmount(rawValue, label, currency) : readTypedNumber(rawValue, label);
  if (Number.isFinite(value)) return value;
  const typed = rawValue?.trim();
  throw new Error(`${label} must be a number such as ${TYPED_AMOUNT_FORMAT}${typed ? `; got "${typed}"` : ""}.`);
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
