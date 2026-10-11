import { saveConfig } from "../../../../data/config/store";
import { withConfigData, withMarketData } from "../../../../cli/scoped-context";
import { countCollectionTickers } from "../../../../cli/helpers";
import { resolveCliTicker, resolveTickerForCli } from "../../../../cli/ticker-resolution";
import { takeFlag, takeOption } from "../../../../cli/commands/command-utils";
import { EXCHANGE_OPTION, listingKeys, loadSavedListing, parseListingArg, requireListingArg, savedListingName } from "../../../../cli/listing-arg";
import { cliStyles, renderStats, renderTable } from "../../../../utils/cli-output";
import { CLI_COMMAND_GROUPS } from "../../../../cli/help";
import { formatMarketCostWithCurrency, formatMarketQuantity } from "../../../../market-data/market/format";
import type { AppConfig } from "../../../../types/config";
import type { CliCommandContext, CliCommandDef } from "../../../../types/plugin";
import type { Portfolio, TickerRecord } from "../../../../types/ticker";
import type { TickerRepository } from "../../../../data/ticker-repository";
import type { ConfigContext, MarketContext } from "../../../../cli/types";
import { canonicalTickerKey, parsePublicTickerKey } from "../../../../utils/exchanges";
import {
  addTickerToPortfolio,
  adoptFirstPositionCurrency,
  clearPortfolioCash,
  clearPortfolioTargetWeights,
  createManualPortfolio,
  deleteManualPortfolio,
  hasOpenPortfolioPositions,
  isManualPortfolio,
  removeTickerFromPortfolio,
  resolveManualPositionCurrency,
  setManualPortfolioPosition,
  setPortfolioCash,
  setPortfolioTargetWeight,
} from "../mutations";
import { listingLabel, renderCollectionOverview, showCollection } from "./render";
import { resolvePortfolioTotalsCurrency } from "../summary/totals";
import {
  CASH_SYMBOL,
  describeTargetSum,
  formatAllocationMoney,
  formatAllocationWeight,
  parseTargetWeight,
} from "../allocation";
import { findCachedPortfolioAccount } from "../cached-account";
import { apiClient } from "../../../../api-client";
import { importSource, notionalPositions, rankThirteenFLines, type ThirteenFImportLine } from "./import-13f";
import { importedFromText } from "../imported-from";
import {
  failPortfolioCommand,
  isCashArgument,
  listingFields,
  parseFiniteNumber,
  PortfolioCliError,
  rejectCashSymbol,
  requireManualPortfolio,
  requirePortfolio,
  takeCollectionName,
} from "./shared";
import { addSymbols, FILE_OPTION, printSymbolRows, removeSymbols, requireSymbolList, retryNotice, SYMBOL_LIST_HELP } from "./bulk-symbols";

const ADD_USAGE = "Usage: gloomberb portfolio add <portfolio> <symbols...> [--file <path>]";
const REMOVE_USAGE = "Usage: gloomberb portfolio remove <portfolio> <symbols...> [--file <path>]";
const CASH_USAGE = "Usage: gloomberb portfolio cash set <portfolio> <amount> [currency] | portfolio cash clear <portfolio>";
const TARGET_USAGE = "Usage: gloomberb portfolio target set <portfolio> <symbol|CASH> <weight%> | target clear <portfolio> [symbol] | target show <portfolio>";
const IMPORT_USAGE = "Usage: gloomberb portfolio import --13f <CIK|fund name> [--top N] [--name <portfolio>] [--notional <amount>] [--replace]";
const IMPORT_DEFAULT_TOP = 10;
const IMPORT_MAX_TOP = 100;
const IMPORT_DEFAULT_NOTIONAL = 100_000;
/** 13F lines read for an import: the largest, so skipped lines still leave enough for --top. */
const IMPORT_13F_ROWS = 200;

async function listCollections(ctx: CliCommandContext) {
  await withConfigData(ctx, async ({ config, store }) => {
    const tickers = await store.loadAllTickers();
    if (ctx.cliOptions.format !== "text") {
      ctx.printResult({
        data: {
          portfolios: config.portfolios.map((portfolio) => ({
            id: portfolio.id,
            name: portfolio.name,
            currency: resolvePortfolioTotalsCurrency(portfolio, config.baseCurrency),
            brokerId: portfolio.brokerId ?? "",
            brokerInstanceId: portfolio.brokerInstanceId ?? "",
            brokerAccountId: portfolio.brokerAccountId ?? "",
            tickerCount: countCollectionTickers(tickers, "portfolios", portfolio.id),
          })),
          watchlists: config.watchlists.map((watchlist) => ({
            id: watchlist.id,
            name: watchlist.name,
            tickerCount: countCollectionTickers(tickers, "watchlists", watchlist.id),
          })),
        },
      });
      return;
    }
    console.log(renderCollectionOverview(config, tickers));
  });
}

async function createPortfolioCommand(name: string, ctx: CliCommandContext) {
  await withConfigData(ctx, async ({ config }) => {
    try {
      const result = createManualPortfolio(config, name, config.baseCurrency);
      await saveConfig(result.config);
      console.log(cliStyles.success(`Created portfolio "${result.portfolio.name}".`));
      console.log(renderStats([["ID", result.portfolio.id]]));
    } catch (error) {
      failPortfolioCommand(ctx, error, `Failed to create portfolio "${name}".`);
    }
  });
}

async function deletePortfolioCommand(name: string, ctx: CliCommandContext) {
  await withConfigData(ctx, async ({ config, store }) => {
    try {
      const portfolio = requireManualPortfolio(config, name);
      const result = deleteManualPortfolio(config, await store.loadAllTickers(), portfolio.id);
      for (const ticker of result.tickers) {
        await store.saveTicker(ticker);
      }
      await saveConfig(result.config);
      console.log(cliStyles.success(`Deleted portfolio "${result.portfolio.name}".`));
      console.log(renderStats([
        ["Cleaned Tickers", String(result.cleanedTickerCount)],
        ["Removed Positions", String(result.removedPositionCount)],
      ]));
    } catch (error) {
      failPortfolioCommand(ctx, error, `Failed to delete portfolio "${name}".`);
    }
  });
}

/** The manual portfolio the leading arguments name and the symbols after it; fails naming the portfolios there are. */
function requirePortfolioArgs(config: AppConfig, args: readonly string[], usage: string, ctx: CliCommandContext): { portfolio: Portfolio; rest: string[] } {
  if (args.length === 0) ctx.fail(usage);
  const match = takeCollectionName(args, config.portfolios);
  try {
    // A name nothing matches is reported as typed: its first argument, never the symbols glued on.
    return { portfolio: requireManualPortfolio(config, match?.collection.id ?? args[0]!), rest: match?.rest ?? [] };
  } catch (error) {
    return failPortfolioCommand(ctx, error, `Portfolio "${args[0]}" was not found.`);
  }
}

/** Bare CASH is the cash line, which add and remove refuse with the hint `rejectCashSymbol` gives. */
function cashRefusal(portfolio: Portfolio, exchange: string | undefined) {
  return (input: string): Error | null => {
    try {
      rejectCashSymbol(input, exchange, portfolio.name);
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };
}

async function addTickerToPortfolioCommand(portfolio: Portfolio, symbol: string, exchange: string | undefined, ctx: CliCommandContext, { store, dataProvider }: MarketContext) {
  try {
    rejectCashSymbol(symbol, exchange, portfolio.name);
    // A bare symbol is stored on the listing `quote` reads it as, and the notes say which, as `watchlist add` does.
    const { ticker, notes, change } = await resolveCliTicker(symbol, store, dataProvider, exchange, {
      retry: (key) => `gloomberb portfolio add ${portfolio.name} ${key}`,
    });
    const result = addTickerToPortfolio(ticker, portfolio.id);
    // Name the listing that was stored: SAN:EPA is not the SAN that a bare SAN means.
    const saved = savedListingName(ticker);
    const data = { changed: result.changed, ...listingFields(saved), portfolio: portfolio.name, ...change ? { tickerChange: change } : {} };
    const warnings = notes.length > 0 ? notes : undefined;
    if (!result.changed) {
      ctx.printResult({ data, warnings }, { text: () => cliStyles.warning(`${saved.label} is already in "${portfolio.name}".`) });
      return;
    }
    await store.saveTicker(result.ticker);
    ctx.printResult({ data, warnings }, { text: () => cliStyles.success(`Added ${saved.label} to "${portfolio.name}".`) });
  } catch (error) {
    failPortfolioCommand(ctx, error, `Failed to add ${symbol} to "${portfolio.name}".`);
  }
}

async function addToPortfolioCommand(args: string[], file: string | undefined, exchange: string | undefined, ctx: CliCommandContext) {
  await withMarketData(ctx, async (market) => {
    const { portfolio, rest } = requirePortfolioArgs(market.config, args, ADD_USAGE, ctx);
    const list = await requireSymbolList(ctx, rest, file, ADD_USAGE);
    if (list.single) {
      await addTickerToPortfolioCommand(portfolio, list.single, exchange, ctx, market);
      return;
    }
    const rows = await addSymbols({
      symbols: list.symbols,
      exchange,
      store: market.store,
      dataProvider: market.dataProvider,
      reject: cashRefusal(portfolio, exchange),
      onRetry: retryNotice(ctx),
      retry: (key) => `gloomberb portfolio add ${/\s/.test(portfolio.name) ? `"${portfolio.name}"` : portfolio.name} ${key}`,
      add: (ticker) => addTickerToPortfolio(ticker, portfolio.id),
    });
    printSymbolRows(ctx, rows, { verb: "add", collection: { kind: "portfolio", name: portfolio.name }, repeated: list.repeated });
  });
}

/** A target or a removal drops the symbol's target with it, so none outlives its holding. */
function withoutTarget(config: AppConfig, portfolio: Portfolio, symbol: string): AppConfig | null {
  const { config: next, removed } = clearPortfolioTargetWeights(config, portfolio.id, symbol);
  return removed.length > 0 ? next : null;
}

async function removeTickerFromPortfolioCommand(portfolio: Portfolio, symbol: string, exchange: string | undefined, ctx: CliCommandContext, { config, store }: ConfigContext) {
  // SAN:EPA and SAN --exchange EPA name the stored listing, which a bare SAN may hold under another venue.
  const listing = await requireListingArg(symbol, exchange, ctx);
  try {
    const ticker = await loadSavedListing(store, listing);
    if (!ticker) ctx.fail(`Ticker "${listing.key}" was not found in your local data.`);
    const saved = savedListingName(ticker);
    const result = removeTickerFromPortfolio(ticker, portfolio.id);
    if (!result.changed) ctx.fail(`${saved.key} is not in "${portfolio.name}".`);
    await store.saveTicker(result.ticker);
    const nextConfig = withoutTarget(config, portfolio, ticker.metadata.ticker);
    if (nextConfig) await saveConfig(nextConfig);
    ctx.printResult({
      data: {
        changed: true,
        ...listingFields(saved),
        portfolio: portfolio.name,
        removedPositions: result.removedPositionCount,
        removedTarget: nextConfig != null,
      },
    }, {
      text: () => [
        cliStyles.success(`Removed ${saved.label} from "${portfolio.name}".`),
        renderStats([
          ["Removed Positions", String(result.removedPositionCount)],
          ...(nextConfig ? [["Removed Target", "yes"] as [string, string]] : []),
        ]),
      ].join("\n"),
    });
  } catch (error) {
    failPortfolioCommand(ctx, error, `Failed to remove ${symbol} from "${portfolio.name}".`);
  }
}

async function removeFromPortfolioCommand(args: string[], file: string | undefined, exchange: string | undefined, ctx: CliCommandContext) {
  await withConfigData(ctx, async (context) => {
    const { portfolio, rest } = requirePortfolioArgs(context.config, args, REMOVE_USAGE, ctx);
    const list = await requireSymbolList(ctx, rest, file, REMOVE_USAGE);
    if (list.single) {
      await removeTickerFromPortfolioCommand(portfolio, list.single, exchange, ctx, context);
      return;
    }
    // Targets go with their holdings, all in one config write.
    let nextConfig = context.config;
    const rows = await removeSymbols({
      symbols: list.symbols,
      exchange,
      store: context.store,
      reject: cashRefusal(portfolio, exchange),
      remove: (ticker) => {
        const result = removeTickerFromPortfolio(ticker, portfolio.id);
        const withoutTargets = result.changed ? withoutTarget(nextConfig, portfolio, ticker.metadata.ticker) : null;
        if (withoutTargets) nextConfig = withoutTargets;
        return { ...result, extra: { removedPositions: result.removedPositionCount, removedTarget: withoutTargets != null } };
      },
    });
    if (nextConfig !== context.config) await saveConfig(nextConfig);
    printSymbolRows(ctx, rows, { verb: "remove", collection: { kind: "portfolio", name: portfolio.name }, repeated: list.repeated });
  });
}

async function setPositionCommand(
  portfolioName: string,
  symbol: string,
  sharesValue: string,
  avgCostValue: string,
  rawCurrency: string | undefined,
  exchange: string | undefined,
  ctx: CliCommandContext,
) {
  await withMarketData(ctx, async ({ config, store, dataProvider }) => {
    try {
      const portfolio = requireManualPortfolio(config, portfolioName);
      rejectCashSymbol(symbol, exchange, portfolio.name);
      const shares = parseFiniteNumber(sharesValue, "Shares");
      const avgCost = parseFiniteNumber(avgCostValue, "Average cost");
      const ticker = await resolveTickerForCli(symbol, store, dataProvider, exchange);
      const currency = resolveManualPositionCurrency(rawCurrency, ticker, portfolio, config.baseCurrency);
      const result = setManualPortfolioPosition(ticker, portfolio.id, {
        shares,
        avgCost,
        currency,
      });
      const firstPosition = !hasOpenPortfolioPositions(portfolio.id, await store.loadAllTickers());
      await store.saveTicker(result.ticker);
      const adopted = firstPosition ? adoptFirstPositionCurrency(config, portfolio.id, currency) : null;
      if (adopted) await saveConfig(adopted);
      const saved = savedListingName(result.ticker);
      ctx.printResult({
        data: { changed: true, ...listingFields(saved), portfolio: portfolio.name, shares, avgCost, currency },
      }, {
        text: () => [
          cliStyles.success(`Set position for ${saved.label} in "${portfolio.name}".`),
          renderStats([
            ["Shares", formatMarketQuantity(shares, { assetCategory: result.ticker.metadata.assetCategory })],
            ["Average Cost", formatMarketCostWithCurrency(avgCost, currency, { assetCategory: result.ticker.metadata.assetCategory })],
            ["Currency", currency],
          ]),
        ].join("\n"),
      });
    } catch (error) {
      failPortfolioCommand(ctx, error, `Failed to set position for ${symbol} in "${portfolioName}".`);
    }
  });
}

const CURRENCY_CODE = /^[A-Za-z]{3}$/;

/** `<portfolio...> <amount> [currency]`: a portfolio name may have spaces, the amount and currency do not. */
function parseCashArgs(rest: string[]): { name: string; amount: string; currency?: string } | null {
  const last = rest.at(-1);
  const beforeLast = rest.at(-2);
  if (rest.length >= 3 && last && CURRENCY_CODE.test(last) && beforeLast && Number.isFinite(parseCashAmount(beforeLast))) {
    return { name: rest.slice(0, -2).join(" "), amount: beforeLast, currency: last.toUpperCase() };
  }
  if (rest.length >= 2 && last) return { name: rest.slice(0, -1).join(" "), amount: last };
  return null;
}

/** 500000, 500,000 and 500_000 are the same amount. */
function parseCashAmount(raw: string): number {
  const text = raw.trim().replace(/[,_]/g, "");
  return text ? Number(text) : Number.NaN;
}

async function setCashCommand(rest: string[], ctx: CliCommandContext) {
  const parsed = parseCashArgs(rest);
  if (!parsed?.name) ctx.fail(CASH_USAGE);
  await withConfigData(ctx, async ({ config, persistence }) => {
    try {
      const portfolio = requirePortfolio(config, parsed.name);
      const amount = parseCashAmount(parsed.amount);
      if (!Number.isFinite(amount)) throw new Error("Cash amount must be a valid number.");
      const currency = parsed.currency ?? resolvePortfolioTotalsCurrency(portfolio, config.baseCurrency);
      await saveConfig(setPortfolioCash(config, portfolio.id, { amount, currency }));
      console.log(cliStyles.success(`Set cash in "${portfolio.name}" to ${formatAllocationMoney(amount, currency)}.`));
      const account = findCachedPortfolioAccount(config, portfolio, persistence.resources);
      if (account && Number.isFinite(account.totalCashValue)) {
        console.log(cliStyles.warning(
          `The broker account reports its own cash, ${formatAllocationMoney(account.totalCashValue, account.currency || currency)}; reports show that balance instead.`,
        ));
      }
    } catch (error) {
      failPortfolioCommand(ctx, error, `Failed to set cash in "${parsed.name}".`);
    }
  });
}

async function clearCashCommand(name: string, ctx: CliCommandContext) {
  await withConfigData(ctx, async ({ config }) => {
    try {
      const portfolio = requirePortfolio(config, name);
      const result = clearPortfolioCash(config, portfolio.id);
      if (!result.changed) {
        console.log(cliStyles.warning(`"${portfolio.name}" has no cash recorded.`));
        return;
      }
      await saveConfig(result.config);
      console.log(cliStyles.success(`Cleared the cash in "${portfolio.name}".`));
    } catch (error) {
      failPortfolioCommand(ctx, error, `Failed to clear the cash in "${name}".`);
    }
  });
}

/** The note under a target change when the targets do not add up to the whole portfolio, else null. */
function targetSumNote(config: AppConfig, portfolioId: string, tickers: readonly TickerRecord[]): string | null {
  const portfolio = config.portfolios.find((entry) => entry.id === portfolioId);
  const listed = new Set([CASH_SYMBOL, ...tickers.filter((ticker) => ticker.metadata.portfolios.includes(portfolioId)).map((ticker) => ticker.metadata.ticker)]);
  let sum: number | null = null;
  for (const [symbol, weight] of Object.entries(portfolio?.targetWeights ?? {})) {
    if (listed.has(symbol)) sum = (sum ?? 0) + weight;
  }
  const note = describeTargetSum(sum);
  return note ? cliStyles.muted(note) : null;
}

/**
 * The portfolio's own row for a listing, without a search when it is already
 * listed. A named exchange (SAN:EPA, or SAN --exchange EPA) matches only a row
 * on that venue, whatever key the row is saved under: a bare SAN row is one
 * listing, Paris or New York, never both. A bare SAN takes the row saved under
 * that key, else any row of the symbol.
 */
async function findListedTicker(store: TickerRepository, portfolio: Portfolio, symbol: string, exchange?: string): Promise<TickerRecord | null> {
  const listing = parseListingArg(symbol, exchange);
  const listed = (await store.loadAllTickers()).filter((ticker) => ticker.metadata.portfolios.includes(portfolio.id));
  const savedAs = (ticker: TickerRecord, key: string) => ticker.metadata.ticker.toUpperCase() === key;
  if (!listing.exchange) {
    const sameSymbol = listed.filter((ticker) => parsePublicTickerKey(ticker.metadata.ticker).symbol === listing.symbol);
    return sameSymbol.find((ticker) => savedAs(ticker, listing.symbol)) ?? sameSymbol[0] ?? null;
  }
  // 7203:TSE is the row on any venue TSE names.
  const keys = listingKeys(listing);
  const onVenue = listed.filter((ticker) => keys.includes(canonicalTickerKey(ticker.metadata.ticker, ticker.metadata.exchange)));
  // The key as saved (VTI:XMEX), else the same listing under another spelling of its venue (VTI:BMV).
  return onVenue.find((ticker) => keys.some((key) => savedAs(ticker, key))) ?? onVenue[0] ?? null;
}

/** What a target command reports for the cash line, in the fields a listing has. */
const CASH_LISTING = { key: CASH_SYMBOL, symbol: CASH_SYMBOL, exchange: "", name: null };

async function setTargetCommand(rest: string[], exchange: string | undefined, ctx: CliCommandContext) {
  const rawWeight = rest.at(-1);
  const symbol = rest.at(-2);
  const name = rest.slice(0, -2).join(" ");
  if (!name || !symbol || !rawWeight) ctx.fail(TARGET_USAGE);
  await withMarketData(ctx, async ({ config, store, dataProvider }) => {
    try {
      const portfolio = requirePortfolio(config, name);
      const weight = parseTargetWeight(rawWeight);
      if (isCashArgument(symbol, exchange)) {
        const next = setPortfolioTargetWeight(config, portfolio.id, CASH_SYMBOL, weight);
        await saveConfig(next);
        const note = targetSumNote(next, portfolio.id, await store.loadAllTickers());
        ctx.printResult({
          data: { changed: true, ...listingFields(CASH_LISTING), portfolio: portfolio.name, targetWeight: weight },
        }, {
          text: () => [cliStyles.success(`Set the cash target in "${portfolio.name}" to ${formatAllocationWeight(weight)}.`), note].filter(Boolean).join("\n"),
        });
        return;
      }
      let ticker = await findListedTicker(store, portfolio, symbol, exchange);
      let added = false;
      if (!ticker) {
        const resolved = await resolveTickerForCli(symbol, store, dataProvider, exchange);
        if (!resolved.metadata.portfolios.includes(portfolio.id)) {
          if (!isManualPortfolio(portfolio)) {
            throw new PortfolioCliError(
              `${savedListingName(resolved).label} is not in "${portfolio.name}".`,
              "A broker portfolio lists what the broker holds; set targets on its holdings.",
            );
          }
          const membership = addTickerToPortfolio(resolved, portfolio.id);
          await store.saveTicker(membership.ticker);
          added = true;
          ticker = membership.ticker;
        } else {
          ticker = resolved;
        }
      }
      const next = setPortfolioTargetWeight(config, portfolio.id, ticker.metadata.ticker, weight);
      await saveConfig(next);
      const saved = savedListingName(ticker);
      const note = targetSumNote(next, portfolio.id, await store.loadAllTickers());
      ctx.printResult({
        data: { changed: true, ...listingFields(saved), portfolio: portfolio.name, targetWeight: weight, added },
      }, {
        text: () => [
          added ? cliStyles.success(`Added ${saved.label} to "${portfolio.name}".`) : null,
          cliStyles.success(`Set the target for ${saved.label} in "${portfolio.name}" to ${formatAllocationWeight(weight)}.`),
          note,
        ].filter(Boolean).join("\n"),
      });
    } catch (error) {
      failPortfolioCommand(ctx, error, `Failed to set the target for ${symbol} in "${name}".`);
    }
  });
}

async function clearTargetCommand(rest: string[], exchange: string | undefined, ctx: CliCommandContext) {
  if (rest.length === 0) ctx.fail(TARGET_USAGE);
  await withConfigData(ctx, async ({ config, store }) => {
    try {
      // The whole argument naming a portfolio clears every target; otherwise the last word is the symbol.
      const whole = config.portfolios.some((entry) => [entry.id, entry.name].some((value) => value.toLowerCase() === rest.join(" ").trim().toLowerCase()));
      const portfolio = requirePortfolio(config, whole ? rest.join(" ") : rest.slice(0, -1).join(" "));
      const rawSymbol = whole ? undefined : rest.at(-1);
      const cash = rawSymbol != null && isCashArgument(rawSymbol, exchange);
      const listing = rawSymbol == null || cash ? null : parseListingArg(rawSymbol, exchange);
      // The row the listing is: the portfolio's own, else any saved one; a target is kept under that row's key.
      const ticker = listing ? await findListedTicker(store, portfolio, rawSymbol!, exchange) ?? await loadSavedListing(store, listing) : null;
      const saved = ticker ? savedListingName(ticker) : null;
      const symbol = cash ? CASH_SYMBOL : ticker?.metadata.ticker ?? listing?.key;
      const { config: next, removed } = clearPortfolioTargetWeights(config, portfolio.id, symbol);
      const fields = cash ? listingFields(CASH_LISTING) : saved ? listingFields(saved) : listing ? listingFields({ ...listing, name: null }) : {};
      const named = saved?.label ?? listing?.key ?? CASH_SYMBOL;
      const data = { changed: removed.length > 0, ...fields, portfolio: portfolio.name, removedTargets: removed.length };
      if (removed.length === 0) {
        ctx.printResult({ data }, { text: () => cliStyles.warning(symbol ? `"${portfolio.name}" has no target for ${named}.` : `"${portfolio.name}" has no targets.`) });
        return;
      }
      await saveConfig(next);
      ctx.printResult({ data }, {
        text: () => cliStyles.success(
          symbol
            ? `Cleared the ${cash ? "cash target" : `target for ${named}`} in "${portfolio.name}".`
            : `Cleared ${removed.length} target${removed.length === 1 ? "" : "s"} in "${portfolio.name}".`,
        ),
      });
    } catch (error) {
      failPortfolioCommand(ctx, error, `Failed to clear targets in "${rest.join(" ")}".`);
    }
  });
}

async function showTargetsCommand(name: string, ctx: CliCommandContext) {
  await withConfigData(ctx, async ({ config, store }) => {
    try {
      const portfolio = requirePortfolio(config, name);
      const tickers = await store.loadAllTickers();
      const bySymbol = new Map(tickers.map((ticker) => [ticker.metadata.ticker, ticker]));
      const rows = Object.entries(portfolio.targetWeights ?? {})
        .sort(([left], [right]) => (left === CASH_SYMBOL ? 1 : right === CASH_SYMBOL ? -1 : left.localeCompare(right)))
        .map(([symbol, targetWeight]) => {
          const ticker = bySymbol.get(symbol);
          return {
            symbol,
            name: symbol === CASH_SYMBOL ? "Cash" : ticker?.metadata.name ?? null,
            targetWeight,
            listed: symbol === CASH_SYMBOL || !!ticker?.metadata.portfolios.includes(portfolio.id),
          };
        });
      if (ctx.cliOptions.format !== "text") {
        ctx.printResult({ data: rows, metadata: { portfolioId: portfolio.id, portfolioName: portfolio.name } });
        return;
      }
      console.log(cliStyles.bold(`${portfolio.name} targets`));
      if (rows.length === 0) {
        console.log(cliStyles.muted(`No targets. Set one with: gloomberb portfolio target set "${portfolio.name}" <symbol|CASH> <weight%>`));
        return;
      }
      console.log("");
      console.log(renderTable(
        [{ header: "Ticker" }, { header: "Name" }, { header: "Target", align: "right" }],
        // A saved row reads as its listing (SAN:NYSE); a target whose row is not saved keeps its key.
        rows.map((row) => {
          const saved = row.symbol === CASH_SYMBOL ? undefined : bySymbol.get(row.symbol);
          return [
            saved ? listingLabel(saved) : row.symbol,
            row.listed ? row.name ?? "" : cliStyles.muted("not in this portfolio"),
            formatAllocationWeight(row.targetWeight),
          ];
        }),
      ));
      const note = targetSumNote(config, portfolio.id, tickers);
      if (note) console.log(note);
    } catch (error) {
      failPortfolioCommand(ctx, error, `Failed to show targets for "${name}".`);
    }
  });
}

interface ThirteenFImportOptions {
  query: string;
  top: number;
  name: string | undefined;
  notional: number;
  replace: boolean;
}

/** An import option's value; a flag given without one fails rather than reading as left out. */
function takeImportValue(args: string[], flag: string, ctx: CliCommandContext): string | undefined {
  if (!args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) return undefined;
  const value = takeOption(args, flag)?.trim();
  if (!value || value.startsWith("--")) ctx.fail(`${flag} needs a value.`, IMPORT_USAGE);
  return value;
}

function parseImportOptions(args: string[], ctx: CliCommandContext): ThirteenFImportOptions {
  const query = takeImportValue(args, "--13f", ctx);
  const top = takeImportValue(args, "--top", ctx);
  const name = takeImportValue(args, "--name", ctx);
  const notional = takeImportValue(args, "--notional", ctx);
  const replace = takeFlag(args, "--replace");
  // `portfolio import holdings.csv` is a list of symbols, which add reads.
  const path = args.find((arg) => /\.(csv|tsv|txt)$/i.test(arg));
  if (!query && path) {
    ctx.fail(
      `portfolio import reads a manager's 13F filing. To add the symbols in ${path}, run: gloomberb portfolio add <portfolio> --file ${path}`,
      IMPORT_USAGE,
    );
  }
  if (!query) ctx.fail("portfolio import needs a manager: --13f <CIK|fund name>.", IMPORT_USAGE);
  if (args.length > 0) {
    ctx.fail(`portfolio import takes its manager and portfolio as options; got ${args.join(" ")}.`, `Quote a name with spaces, as in --13f "Berkshire Hathaway".\n${IMPORT_USAGE}`);
  }
  const count = top == null ? IMPORT_DEFAULT_TOP : Number(top);
  if (!Number.isInteger(count) || count < 1 || count > IMPORT_MAX_TOP) ctx.fail(`--top must be a whole number from 1 to ${IMPORT_MAX_TOP}.`);
  const amount = notional == null ? IMPORT_DEFAULT_NOTIONAL : Number(notional.replace(/[,_]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) ctx.fail("--notional must be an amount above zero, such as --notional 250000.");
  return { query, top: count, name: name || undefined, notional: amount, replace };
}

/**
 * A manual portfolio from a manager's latest 13F: its largest common-stock
 * lines that resolve to a listing, weighted by reported value, as a notional
 * the user can see. An existing portfolio of that name is filled only when it
 * is empty, or replaced with --replace; never overwritten silently.
 */
async function importThirteenFCommand(options: ThirteenFImportOptions, ctx: CliCommandContext) {
  // The manager's holdings as `fn 13F <manager>` reports them, through the 13F function of the plugins that are on.
  const thirteenF = ctx.plugins.flatMap((plugin) => plugin.paneTemplates ?? []).find((template) => template.shortcut?.prefix === "13F")?.headless;
  if (!thirteenF) ctx.fail("13F filings are not available: the Ownership & Insiders plugin is off.", "Turn it on with gloomberb plugin enable ownership.");
  await withMarketData(ctx, async ({ config, store, dataProvider }) => {
    try {
      const report = await thirteenF.load(
        { rawArgument: options.query, argument: options.query, symbols: [], options: { view: "holdings", limit: IMPORT_13F_ROWS } },
        { marketData: dataProvider, apiClient, config, signal: new AbortController().signal },
      );
      const source = importSource(report.metadata);
      const rows = "rows" in report && Array.isArray(report.rows) ? report.rows : [];
      if (!source) throw new PortfolioCliError(`No dated 13F holdings report found for "${options.query}".`);
      const detail = { cik: source.cik, name: source.name };
      const name = options.name ?? `${detail.name} 13F`;
      const existing = config.portfolios.find((entry) => [entry.id, entry.name].some((value) => value.toLowerCase() === name.toLowerCase()));
      if (existing && !isManualPortfolio(existing)) {
        throw new PortfolioCliError(`Portfolio "${existing.name}" is broker-managed and cannot be imported into.`, "Name another with --name.");
      }
      const members = existing ? (await store.loadAllTickers()).filter((ticker) => ticker.metadata.portfolios.includes(existing.id)) : [];
      if (existing && members.length > 0 && !options.replace) {
        throw new PortfolioCliError(
          `Portfolio "${existing.name}" already exists with ${members.length} ticker${members.length === 1 ? "" : "s"}.`,
          `Add --replace to replace them with this 13F, or --name to import into a new portfolio.\n${IMPORT_USAGE}`,
        );
      }

      // The largest lines first; a line that cannot be a position, or whose ticker does not resolve, gives way to the next.
      const picked: Array<{ line: ThirteenFImportLine; ticker: TickerRecord }> = [];
      const skipped: Array<{ label: string; reason: string }> = [];
      for (const line of rankThirteenFLines(rows)) {
        if (picked.length >= options.top) break;
        const label = line.ticker || line.issuer;
        if (line.skip) { skipped.push({ label, reason: line.skip }); continue; }
        try {
          const ticker = await resolveTickerForCli(line.ticker, store, dataProvider);
          const same = picked.find((entry) => entry.ticker.metadata.ticker === ticker.metadata.ticker);
          if (same) { skipped.push({ label, reason: `same listing as ${same.line.ticker}` }); continue; }
          picked.push({ line, ticker });
        } catch (error) {
          skipped.push({ label, reason: `ticker did not resolve (${error instanceof Error ? error.message : String(error)})` });
        }
      }
      if (picked.length === 0) {
        throw new PortfolioCliError(`None of ${detail.name}'s 13F lines could be imported.`, skipped.map((entry) => `${entry.label}: ${entry.reason}`).join("\n"));
      }
      const reported = report.metadata?.currentReportedValue;
      const filingValue = typeof reported === "number" && Number.isFinite(reported) ? reported : null;
      const positions = notionalPositions(picked.map((entry) => entry.line), options.notional, filingValue);

      let nextConfig = config;
      let portfolio: Portfolio;
      if (existing) {
        portfolio = existing;
        for (const member of members) {
          const removed = removeTickerFromPortfolio(member, existing.id);
          if (removed.changed) await store.saveTicker(removed.ticker);
        }
        nextConfig = clearPortfolioTargetWeights(nextConfig, existing.id).config;
      } else {
        const created = createManualPortfolio(nextConfig, name, "USD");
        nextConfig = created.config;
        portfolio = created.portfolio;
      }
      for (const [index, position] of positions.entries()) {
        const resolved = picked[index]!.ticker;
        // Reread: replacing the old positions may have saved this listing since it resolved.
        const ticker = await store.loadTicker(resolved.metadata.ticker) ?? resolved;
        const result = setManualPortfolioPosition(ticker, portfolio.id, { shares: position.shares, avgCost: position.avgCost, currency: "USD" });
        await store.saveTicker(result.ticker);
      }
      nextConfig = adoptFirstPositionCurrency(nextConfig, portfolio.id, "USD") ?? nextConfig;
      nextConfig = { ...nextConfig, portfolios: nextConfig.portfolios.map((entry) => entry.id === portfolio.id ? { ...entry, importedFrom: source } : entry) };
      await saveConfig(nextConfig);

      const importedShare = filingValue ? picked.reduce((sum, entry) => sum + entry.line.value, 0) / filingValue : null;
      const action = !existing ? "created" : members.length > 0 ? "replaced" : "filled";
      const lines = positions.map((position, index) => ({ ...position, ...listingFields(savedListingName(picked[index]!.ticker)) }));
      ctx.printResult({
        data: {
          changed: true, action, portfolio: portfolio.name, portfolioId: portfolio.id, importedFrom: source,
          notional: options.notional, currency: "USD", importedShareOfFiling: importedShare,
          removedTickers: members.length, positions: lines, skipped,
        },
      }, {
        text: () => [
          cliStyles.success(`${action === "created" ? "Created portfolio" : action === "replaced" ? `Replaced the ${members.length} ticker${members.length === 1 ? "" : "s"} in` : "Filled the empty portfolio"} "${portfolio.name}" with the top ${positions.length} positions of ${detail.name}'s 13F (CIK ${detail.cik}).`),
          importedFromText({ importedFrom: source }),
          `Shares are a ${formatAllocationMoney(options.notional, "USD", { whole: true })} notional at the filing's quarter-end prices${importedShare != null ? `; these lines are ${formatAllocationWeight(importedShare * 100)} of its reported value` : ""}.`,
          "",
          renderTable(
            [{ header: "Ticker" }, { header: "Name" }, { header: "Weight", align: "right" }, { header: "13F %", align: "right" }, { header: "Shares", align: "right" }, { header: "Cost", align: "right" }],
            lines.map((line) => [line.listing, line.name ?? line.issuer, formatAllocationWeight(line.weight * 100), formatAllocationWeight(line.filingWeight == null ? null : line.filingWeight * 100), formatMarketQuantity(line.shares), formatMarketCostWithCurrency(line.avgCost, "USD")]),
          ),
          ...(skipped.length ? ["", cliStyles.warning(`Skipped: ${skipped.map((entry) => `${entry.label} (${entry.reason})`).join("; ")}`)] : []),
          renderStats([["ID", portfolio.id]]),
        ].filter((line) => line != null).join("\n"),
      });
    } catch (error) {
      failPortfolioCommand(ctx, error, `Failed to import the 13F of "${options.query}".`);
    }
  });
}

const IMPORT_FLAGS = new Set(["--13f", "--top", "--name", "--notional", "--replace"]);

/** Actions that change a portfolio: none of them previews, so --dry-run would change it anyway. */
const MUTATING_ACTIONS = new Set(["create", "delete", "rm", "add", "remove", "position", "cash", "import"]);

export const portfolioCliCommand: CliCommandDef = {
  name: "portfolio",
  description: "Show holdings, value, weights and P&L; manage manual portfolios, cash and targets",
  help: {
    group: CLI_COMMAND_GROUPS.portfolios,
    usage: [
      "portfolio [list]",
      "portfolio show <name>",
      "portfolio create <name>",
      "portfolio delete <name>",
      "portfolio add <portfolio> <symbols...> [--file <path>]",
      "portfolio remove <portfolio> <symbols...> [--file <path>]",
      "portfolio position set <portfolio> <symbol> <shares> <avg-cost> [currency]",
      "portfolio cash set <portfolio> <amount> [currency]",
      "portfolio cash clear <portfolio>",
      "portfolio target set <portfolio> <symbol|CASH> <weight%>",
      "portfolio target clear <portfolio> [symbol|CASH]",
      "portfolio target show <portfolio>",
      "portfolio import --13f <CIK|fund name> [--top N] [--name <portfolio>] [--notional <amount>] [--replace]",
    ],
    options: [
      EXCHANGE_OPTION,
      FILE_OPTION,
      { flags: "--13f <CIK|name>", description: "portfolio import: the 13F manager whose latest filing to import" },
      { flags: "--top <n>", description: `portfolio import: how many of its largest common-stock lines (default ${IMPORT_DEFAULT_TOP}, at most ${IMPORT_MAX_TOP})` },
      { flags: "--name <portfolio>", description: "portfolio import: the portfolio to create or fill (default: the manager's name and 13F)" },
      { flags: "--notional <amount>", description: "portfolio import: the USD total the shares add up to at the filing's prices (default 100,000)" },
      { flags: "--replace", description: "portfolio import: replace the positions of an existing portfolio of that name" },
    ],
    examples: [
      "portfolio show Research",
      "portfolio add Research ASML",
      "portfolio add Research ASML:AMS",
      "portfolio add Research --file holdings.csv",
      "portfolio position set Research ASML 10 800 EUR",
      "portfolio cash set Research 25000 USD",
      "portfolio target set Research ASML 12.5%",
      "portfolio target set Research CASH 10",
      "portfolio show Research --csv",
      "portfolio import --13f 0001067983 --top 10",
    ],
    sections: [SYMBOL_LIST_HELP],
  },
  execute: async (rawArgs, ctx) => {
    const args = [...rawArgs];
    const action = args[0];
    if (action === "import") {
      if (ctx.cliOptions.dryRun) ctx.fail("portfolio import has no --dry-run; it creates or fills the portfolio when it runs.");
      await importThirteenFCommand(parseImportOptions(args.slice(1), ctx), ctx);
      return;
    }
    const exchange = takeOption(args, "--exchange");
    const hasFile = args.some((arg) => arg === "--file" || arg.startsWith("--file="));
    const file = hasFile ? takeOption(args, "--file") ?? "" : undefined;
    if (file != null && action !== "add" && action !== "remove") ctx.fail(`--file is an option of portfolio add and remove, not portfolio ${action ?? "list"}.`, ADD_USAGE);
    // The import's options are declared for the command; on another action one would become part of a name or symbol.
    const importOnly = args.find((arg) => IMPORT_FLAGS.has(arg.split("=")[0]!));
    if (importOnly) ctx.fail(`${importOnly.split("=")[0]} is an option of portfolio import, not portfolio ${action}.`, IMPORT_USAGE);
    const mutating = MUTATING_ACTIONS.has(action ?? "") || ((action === "target" || action === "targets") && (args[1] === "set" || args[1] === "clear"));
    if (ctx.cliOptions.dryRun && mutating) ctx.fail(`portfolio ${action} has no --dry-run; it changes the portfolio when it runs.`);

    if (!action || action === "list") {
      await listCollections(ctx);
      return;
    }

    if (action === "show") {
      const name = args.slice(1).join(" ");
      if (!name) ctx.fail("Usage: gloomberb portfolio show <name>");
      await showCollection(name, ctx);
      return;
    }

    if (action === "create") {
      const name = args.slice(1).join(" ");
      if (!name) ctx.fail("Usage: gloomberb portfolio create <name>");
      await createPortfolioCommand(name, ctx);
      return;
    }

    if (action === "delete" || action === "rm") {
      const name = args.slice(1).join(" ");
      if (!name) ctx.fail("Usage: gloomberb portfolio delete <name>");
      await deletePortfolioCommand(name, ctx);
      return;
    }

    if (action === "add") {
      await addToPortfolioCommand(args.slice(1), file, exchange, ctx);
      return;
    }

    if (action === "remove") {
      await removeFromPortfolioCommand(args.slice(1), file, exchange, ctx);
      return;
    }

    if (action === "position") {
      const subaction = args[1];
      if (subaction !== "set") {
        ctx.fail("Usage: gloomberb portfolio position set <portfolio> <ticker> <shares> <avg-cost> [currency]");
      }
      const [, , ...rest] = args;
      const currency = rest[4];
      if (rest.length < 4) {
        ctx.fail("Usage: gloomberb portfolio position set <portfolio> <ticker> <shares> <avg-cost> [currency]");
      }
      await setPositionCommand(rest[0]!, rest[1]!, rest[2]!, rest[3]!, currency, exchange, ctx);
      return;
    }

    if (action === "cash") {
      const [, subaction, ...rest] = args;
      if (subaction === "set") {
        await setCashCommand(rest, ctx);
        return;
      }
      if (subaction === "clear" && rest.length > 0) {
        await clearCashCommand(rest.join(" "), ctx);
        return;
      }
      ctx.fail(CASH_USAGE);
    }

    if (action === "target" || action === "targets") {
      const [, subaction, ...rest] = args;
      if (subaction === "set") {
        await setTargetCommand(rest, exchange, ctx);
        return;
      }
      if (subaction === "clear") {
        await clearTargetCommand(rest, exchange, ctx);
        return;
      }
      if ((subaction === "show" || subaction === "list") && rest.length > 0) {
        await showTargetsCommand(rest.join(" "), ctx);
        return;
      }
      ctx.fail(TARGET_USAGE);
    }

    await showCollection(args.join(" "), ctx);
  },
};
