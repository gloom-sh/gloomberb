import { saveConfig } from "../../../../data/config/store";
import { withConfigData, withMarketData } from "../../../../cli/scoped-context";
import { countCollectionTickers } from "../../../../cli/helpers";
import { resolveTickerForCli } from "../../../../cli/ticker-resolution";
import { cliStyles, renderStat } from "../../../../utils/cli-output";
import { formatMarketCostWithCurrency, formatMarketQuantity } from "../../../../market-data/market/format";
import type { CliCommandContext, CliCommandDef } from "../../../../types/plugin";
import {
  addTickerToPortfolio,
  createManualPortfolio,
  deleteManualPortfolio,
  removeTickerFromPortfolio,
  resolveManualPositionCurrency,
  setManualPortfolioPosition,
} from "../mutations";
import { renderCollectionOverview, showCollection } from "./render";
import { parseFiniteNumber, requireManualPortfolio } from "./shared";

async function listCollections(ctx: CliCommandContext) {
  await withConfigData(ctx, async ({ config, store }) => {
    const tickers = await store.loadAllTickers();
    if (ctx.cliOptions.format !== "text") {
      ctx.printResult({
        data: {
          portfolios: config.portfolios.map((portfolio) => ({
            id: portfolio.id,
            name: portfolio.name,
            currency: portfolio.currency,
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
      console.log(renderStat("ID", result.portfolio.id));
    } catch (error) {
      ctx.fail(error instanceof Error ? error.message : `Failed to create portfolio "${name}".`);
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
      console.log(renderStat("Cleaned Tickers", String(result.cleanedTickerCount)));
      console.log(renderStat("Removed Positions", String(result.removedPositionCount)));
    } catch (error) {
      ctx.fail(error instanceof Error ? error.message : `Failed to delete portfolio "${name}".`);
    }
  });
}

async function addTickerToPortfolioCommand(portfolioName: string, symbol: string, ctx: CliCommandContext) {
  await withMarketData(ctx, async ({ config, store, dataProvider }) => {
    try {
      const portfolio = requireManualPortfolio(config, portfolioName);
      const ticker = await resolveTickerForCli(symbol, store, dataProvider);
      const result = addTickerToPortfolio(ticker, portfolio.id);
      if (!result.changed) {
        console.log(cliStyles.warning(`${ticker.metadata.ticker} is already in "${portfolio.name}".`));
        return;
      }
      await store.saveTicker(result.ticker);
      console.log(cliStyles.success(`Added ${result.ticker.metadata.ticker} to "${portfolio.name}".`));
      if (result.ticker.metadata.name) {
        console.log(renderStat("Name", result.ticker.metadata.name));
      }
    } catch (error) {
      ctx.fail(error instanceof Error ? error.message : `Failed to add ${symbol} to "${portfolioName}".`);
    }
  });
}

async function removeTickerFromPortfolioCommand(portfolioName: string, symbol: string, ctx: CliCommandContext) {
  await withConfigData(ctx, async ({ config, store }) => {
    const normalized = symbol.trim().toUpperCase();

    try {
      const portfolio = requireManualPortfolio(config, portfolioName);
      const ticker = await store.loadTicker(normalized);
      if (!ticker) ctx.fail(`Ticker "${normalized}" was not found in your local data.`);
      const result = removeTickerFromPortfolio(ticker, portfolio.id);
      if (!result.changed) ctx.fail(`${normalized} is not in "${portfolio.name}".`);
      await store.saveTicker(result.ticker);
      console.log(cliStyles.success(`Removed ${normalized} from "${portfolio.name}".`));
      console.log(renderStat("Removed Positions", String(result.removedPositionCount)));
    } catch (error) {
      ctx.fail(error instanceof Error ? error.message : `Failed to remove ${symbol} from "${portfolioName}".`);
    }
  });
}

async function setPositionCommand(
  portfolioName: string,
  symbol: string,
  sharesValue: string,
  avgCostValue: string,
  rawCurrency: string | undefined,
  ctx: CliCommandContext,
) {
  await withMarketData(ctx, async ({ config, store, dataProvider }) => {
    try {
      const portfolio = requireManualPortfolio(config, portfolioName);
      const ticker = await resolveTickerForCli(symbol, store, dataProvider);
      const shares = parseFiniteNumber(sharesValue, "Shares");
      const avgCost = parseFiniteNumber(avgCostValue, "Average cost");
      const currency = resolveManualPositionCurrency(rawCurrency, ticker, portfolio, config.baseCurrency);
      const result = setManualPortfolioPosition(ticker, portfolio.id, {
        shares,
        avgCost,
        currency,
      });
      await store.saveTicker(result.ticker);
      console.log(cliStyles.success(`Set position for ${result.ticker.metadata.ticker} in "${portfolio.name}".`));
      console.log(renderStat("Shares", formatMarketQuantity(shares, { assetCategory: result.ticker.metadata.assetCategory })));
      console.log(renderStat("Average Cost", formatMarketCostWithCurrency(avgCost, currency, { assetCategory: result.ticker.metadata.assetCategory })));
      console.log(renderStat("Currency", currency));
    } catch (error) {
      ctx.fail(error instanceof Error ? error.message : `Failed to set position for ${symbol} in "${portfolioName}".`);
    }
  });
}

export const portfolioCliCommand: CliCommandDef = {
  name: "portfolio",
  description: "List, inspect, create, delete, and manage manual portfolios",
  help: {
    usage: ["portfolio [action]"],
    sections: [{
      title: "Portfolio Actions",
      columns: [
        { header: "Action" },
        { header: "Example" },
      ],
      rows: [
        ["list", "gloomberb portfolio list"],
        ["show", "gloomberb portfolio show Research"],
        ["show (legacy)", "gloomberb portfolio Research"],
        ["create", "gloomberb portfolio create Research"],
        ["delete", "gloomberb portfolio delete Research"],
        ["add", "gloomberb portfolio add Research ASML"],
        ["remove", "gloomberb portfolio remove Research ASML"],
        ["position set", "gloomberb portfolio position set Research ASML 10 800 EUR"],
      ],
    }],
  },
  execute: async (args, ctx) => {
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
      await addTickerToPortfolioCommand(name!, symbol!, ctx);
      return;
    }

    if (action === "remove") {
      const symbol = args.at(-1);
      const name = args.slice(1, -1).join(" ");
      if (!name || !symbol) ctx.fail("Usage: gloomberb portfolio remove <portfolio> <ticker>");
      await removeTickerFromPortfolioCommand(name!, symbol!, ctx);
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
      await setPositionCommand(rest[0]!, rest[1]!, rest[2]!, rest[3]!, currency, ctx);
      return;
    }

    await showCollection(args.join(" "), ctx);
  },
};
