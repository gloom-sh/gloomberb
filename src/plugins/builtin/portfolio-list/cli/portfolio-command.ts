import { saveConfig } from "../../../../data/config/store";
import { withConfigData, withMarketData } from "../../../../cli/scoped-context";
import { countCollectionTickers } from "../../../../cli/helpers";
import { resolveTickerForCli } from "../../../../cli/ticker-resolution";
import { takeOption } from "../../../../cli/commands/command-utils";
import { EXCHANGE_OPTION, loadSavedListing, parseListingArg, requireListingArg, savedListingName } from "../../../../cli/listing-arg";
import { cliStyles, renderStats, renderTable } from "../../../../utils/cli-output";
import { CLI_COMMAND_GROUPS } from "../../../../cli/help";
import { formatMarketCostWithCurrency, formatMarketQuantity } from "../../../../market-data/market/format";
import type { AppConfig } from "../../../../types/config";
import type { CliCommandContext, CliCommandDef } from "../../../../types/plugin";
import type { Portfolio, TickerRecord } from "../../../../types/ticker";
import type { TickerRepository } from "../../../../data/ticker-repository";
import { canonicalExchange, parsePublicTickerKey } from "../../../../utils/exchanges";
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
import { renderCollectionOverview, showCollection } from "./render";
import { resolvePortfolioTotalsCurrency } from "../summary/totals";
import {
  CASH_SYMBOL,
  describeTargetSum,
  formatAllocationMoney,
  formatAllocationWeight,
  parseTargetWeight,
} from "../allocation";
import { findCachedPortfolioAccount } from "../cached-account";
import {
  describeTicker,
  failPortfolioCommand,
  isCashArgument,
  listingFields,
  parseFiniteNumber,
  PortfolioCliError,
  rejectCashSymbol,
  requireManualPortfolio,
  requirePortfolio,
} from "./shared";

const CASH_USAGE = "Usage: gloomberb portfolio cash set <portfolio> <amount> [currency] | portfolio cash clear <portfolio>";
const TARGET_USAGE = "Usage: gloomberb portfolio target set <portfolio> <symbol|CASH> <weight%> | target clear <portfolio> [symbol] | target show <portfolio>";

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

async function addTickerToPortfolioCommand(portfolioName: string, symbol: string, exchange: string | undefined, ctx: CliCommandContext) {
  await withMarketData(ctx, async ({ config, store, dataProvider }) => {
    try {
      const portfolio = requireManualPortfolio(config, portfolioName);
      rejectCashSymbol(symbol, exchange, portfolio.name);
      const ticker = await resolveTickerForCli(symbol, store, dataProvider, exchange);
      const result = addTickerToPortfolio(ticker, portfolio.id);
      // Name the listing that was stored: SAN:EPA is not the SAN that a bare SAN means.
      const saved = savedListingName(ticker);
      const data = { changed: result.changed, ...listingFields(saved), portfolio: portfolio.name };
      if (!result.changed) {
        ctx.printResult({ data }, { text: () => cliStyles.warning(`${saved.label} is already in "${portfolio.name}".`) });
        return;
      }
      await store.saveTicker(result.ticker);
      ctx.printResult({ data }, { text: () => cliStyles.success(`Added ${saved.label} to "${portfolio.name}".`) });
    } catch (error) {
      failPortfolioCommand(ctx, error, `Failed to add ${symbol} to "${portfolioName}".`);
    }
  });
}

/** A target or a removal drops the symbol's target with it, so none outlives its holding. */
function withoutTarget(config: AppConfig, portfolio: Portfolio, symbol: string): AppConfig | null {
  const { config: next, removed } = clearPortfolioTargetWeights(config, portfolio.id, symbol);
  return removed.length > 0 ? next : null;
}

async function removeTickerFromPortfolioCommand(portfolioName: string, symbol: string, exchange: string | undefined, ctx: CliCommandContext) {
  // SAN:EPA and SAN --exchange EPA name the stored listing, which a bare SAN may hold under another venue.
  const listing = await requireListingArg(symbol, exchange, ctx);
  await withConfigData(ctx, async ({ config, store }) => {
    try {
      const portfolio = requireManualPortfolio(config, portfolioName);
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
      failPortfolioCommand(ctx, error, `Failed to remove ${symbol} from "${portfolioName}".`);
    }
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
      console.log(cliStyles.success(`Set position for ${describeTicker(result.ticker)} in "${portfolio.name}".`));
      console.log(renderStats([
        ["Shares", formatMarketQuantity(shares, { assetCategory: result.ticker.metadata.assetCategory })],
        ["Average Cost", formatMarketCostWithCurrency(avgCost, currency, { assetCategory: result.ticker.metadata.assetCategory })],
        ["Currency", currency],
      ]));
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

function printTargetSumNote(config: AppConfig, portfolioId: string, tickers: readonly TickerRecord[]) {
  const portfolio = config.portfolios.find((entry) => entry.id === portfolioId);
  const listed = new Set([CASH_SYMBOL, ...tickers.filter((ticker) => ticker.metadata.portfolios.includes(portfolioId)).map((ticker) => ticker.metadata.ticker)]);
  let sum: number | null = null;
  for (const [symbol, weight] of Object.entries(portfolio?.targetWeights ?? {})) {
    if (listed.has(symbol)) sum = (sum ?? 0) + weight;
  }
  const note = describeTargetSum(sum);
  if (note) console.log(cliStyles.muted(note));
}

/** The portfolio's own ticker for a symbol, without a search when it is already listed. */
async function findListedTicker(store: TickerRepository, portfolio: Portfolio, symbol: string, exchange?: string): Promise<TickerRecord | null> {
  const listing = parseListingArg(symbol, exchange);
  const typed = symbol.trim().toUpperCase();
  const listed = (await store.loadAllTickers()).filter((ticker) => ticker.metadata.portfolios.includes(portfolio.id));
  // The key as saved (VTI:XMEX), else the same listing under another spelling of its venue (VTI:BMV).
  return listed.find((ticker) => [typed, listing.key].includes(ticker.metadata.ticker.toUpperCase()))
    ?? listed.find((ticker) => {
      const saved = parsePublicTickerKey(ticker.metadata.ticker);
      return saved.symbol === listing.symbol
        && (!listing.exchange || canonicalExchange(saved.exchange ?? ticker.metadata.exchange) === listing.exchange);
    })
    ?? null;
}

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
        console.log(cliStyles.success(`Set the cash target in "${portfolio.name}" to ${formatAllocationWeight(weight)}.`));
        printTargetSumNote(next, portfolio.id, await store.loadAllTickers());
        return;
      }
      let ticker = await findListedTicker(store, portfolio, symbol, exchange);
      let added = false;
      if (!ticker) {
        const resolved = await resolveTickerForCli(symbol, store, dataProvider, exchange);
        if (!resolved.metadata.portfolios.includes(portfolio.id)) {
          if (!isManualPortfolio(portfolio)) {
            throw new PortfolioCliError(
              `${describeTicker(resolved)} is not in "${portfolio.name}".`,
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
      if (added) console.log(cliStyles.success(`Added ${describeTicker(ticker)} to "${portfolio.name}".`));
      console.log(cliStyles.success(`Set the target for ${describeTicker(ticker)} in "${portfolio.name}" to ${formatAllocationWeight(weight)}.`));
      printTargetSumNote(next, portfolio.id, await store.loadAllTickers());
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
      const symbol = rawSymbol == null ? undefined
        : isCashArgument(rawSymbol, exchange) ? CASH_SYMBOL
          : (await findListedTicker(store, portfolio, rawSymbol, exchange))?.metadata.ticker ?? parseListingArg(rawSymbol, exchange).key;
      const { config: next, removed } = clearPortfolioTargetWeights(config, portfolio.id, symbol);
      if (removed.length === 0) {
        console.log(cliStyles.warning(symbol ? `"${portfolio.name}" has no target for ${symbol}.` : `"${portfolio.name}" has no targets.`));
        return;
      }
      await saveConfig(next);
      if (symbol) {
        const ticker = symbol === CASH_SYMBOL ? null : await store.loadTicker(symbol);
        console.log(cliStyles.success(`Cleared the ${symbol === CASH_SYMBOL ? "cash target" : `target for ${ticker ? describeTicker(ticker) : symbol}`} in "${portfolio.name}".`));
      } else {
        console.log(cliStyles.success(`Cleared ${removed.length} target${removed.length === 1 ? "" : "s"} in "${portfolio.name}".`));
      }
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
        rows.map((row) => [row.symbol, row.listed ? row.name ?? "" : cliStyles.muted("not in this portfolio"), formatAllocationWeight(row.targetWeight)]),
      ));
      printTargetSumNote(config, portfolio.id, tickers);
    } catch (error) {
      failPortfolioCommand(ctx, error, `Failed to show targets for "${name}".`);
    }
  });
}

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
      "portfolio add <portfolio> <symbol>",
      "portfolio remove <portfolio> <symbol>",
      "portfolio position set <portfolio> <symbol> <shares> <avg-cost> [currency]",
      "portfolio cash set <portfolio> <amount> [currency]",
      "portfolio cash clear <portfolio>",
      "portfolio target set <portfolio> <symbol|CASH> <weight%>",
      "portfolio target clear <portfolio> [symbol|CASH]",
      "portfolio target show <portfolio>",
    ],
    options: [EXCHANGE_OPTION],
    examples: [
      "portfolio show Research",
      "portfolio add Research ASML",
      "portfolio add Research ASML:AMS",
      "portfolio position set Research ASML 10 800 EUR",
      "portfolio cash set Research 25000 USD",
      "portfolio target set Research ASML 12.5%",
      "portfolio target set Research CASH 10",
      "portfolio show Research --csv",
    ],
  },
  execute: async (rawArgs, ctx) => {
    const args = [...rawArgs];
    const exchange = takeOption(args, "--exchange");
    const action = args[0];

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
      const symbol = args.at(-1);
      const name = args.slice(1, -1).join(" ");
      if (!name || !symbol) ctx.fail("Usage: gloomberb portfolio add <portfolio> <ticker>");
      await addTickerToPortfolioCommand(name!, symbol!, exchange, ctx);
      return;
    }

    if (action === "remove") {
      const symbol = args.at(-1);
      const name = args.slice(1, -1).join(" ");
      if (!name || !symbol) ctx.fail("Usage: gloomberb portfolio remove <portfolio> <ticker>");
      await removeTickerFromPortfolioCommand(name!, symbol!, exchange, ctx);
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
